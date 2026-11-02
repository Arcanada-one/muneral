import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link, lstat, open, realpath, readdir, unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const FAILURE_SUMMARY_SCHEMA = 'ActivityVisibleCountFailureSummary/v1';
export const MAX_STDERR_BYTES = 64 * 1024;
export const MAX_SUMMARY_BYTES = 8 * 1024;
export const MAX_DIAGNOSTIC_CODES = 8;
export const MAX_DIAGNOSTIC_CODE_LENGTH = 256;
export const FAILURE_SUMMARY_FILENAME = 'failure-summary.json';

const CAPTURE_SCHEMA = 'ActivityVisibleCountProcess/v1';
const RESULT_FILENAME = 'result.json';
const SIGNALS = new Set([
  'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS', 'SIGFPE',
  'SIGKILL', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE', 'SIGALRM', 'SIGTERM',
  'SIGCHLD', 'SIGCONT', 'SIGSTOP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGURG',
  'SIGXCPU', 'SIGXFSZ', 'SIGVTALRM', 'SIGPROF', 'SIGWINCH', 'SIGIO', 'SIGSYS', 'SIGPWR', 'SIGSTKFLT',
]);
const DIAGNOSTIC_CODES = new Set([
  'BROWSER_SANDBOX_UNAVAILABLE', 'BROWSER_STARTUP_FAILURE', 'BROWSER_DISPLAY_UNAVAILABLE',
  'STDERR_WITHHELD', 'UNKNOWN',
]);
const STDERR_PHRASES = new Map([
  ['No usable sandbox!', 'BROWSER_SANDBOX_UNAVAILABLE'],
  ["DevToolsActivePort file doesn't exist", 'BROWSER_STARTUP_FAILURE'],
  ['Missing X server or $DISPLAY', 'BROWSER_DISPLAY_UNAVAILABLE'],
]);
const STDERR_STATUSES = new Set(['NOT_STARTED', 'EMPTY', 'CLASSIFIED', 'WITHHELD', 'TRUNCATED']);

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validUtc(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function validBinding(binding) {
  return isPlainRecord(binding) && typeof binding.runId === 'string' && /^[0-9]+$/.test(binding.runId) &&
    Number.isSafeInteger(binding.runAttempt) && binding.runAttempt > 0 &&
    typeof binding.candidateSha === 'string' && /^[a-f0-9]{40}$/.test(binding.candidateSha);
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function failure(errorCode) {
  const error = new Error(errorCode);
  error.code = errorCode;
  return error;
}

export function sanitizeStderr(bytes, { truncated = false } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_STDERR_BYTES || typeof truncated !== 'boolean') {
    throw failure('STDERR_INPUT_INVALID');
  }
  if (bytes.length === 0) {
    return { stderrCategories: ['UNKNOWN'], stderrTruncated: truncated, stderrStatus: truncated ? 'TRUNCATED' : 'EMPTY' };
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { stderrCategories: ['UNKNOWN'], stderrTruncated: truncated, stderrStatus: truncated ? 'TRUNCATED' : 'WITHHELD' };
  }

  const lines = text.split('\n');
  const categories = [];
  let withheld = false;
  let considered = 0;
  for (const sourceLine of lines) {
    const line = sourceLine.endsWith('\r') ? sourceLine.slice(0, -1) : sourceLine;
    if (line.length === 0) continue;
    considered += 1;
    if (considered > MAX_DIAGNOSTIC_CODES) {
      withheld = true;
      break;
    }
    const category = STDERR_PHRASES.get(line);
    if (category) categories.push(category);
    else withheld = true;
  }
  if (considered === 0) withheld = true;

  const outputTruncated = truncated || considered > MAX_DIAGNOSTIC_CODES;
  if (withheld && categories.length < MAX_DIAGNOSTIC_CODES) categories.push('STDERR_WITHHELD');
  if (outputTruncated && categories.length < MAX_DIAGNOSTIC_CODES && !categories.includes('STDERR_WITHHELD')) {
    categories.push('STDERR_WITHHELD');
  }
  if (categories.length === 0) categories.push('UNKNOWN');
  return {
    stderrCategories: categories.slice(0, MAX_DIAGNOSTIC_CODES),
    stderrTruncated: outputTruncated,
    stderrStatus: outputTruncated ? 'TRUNCATED' : (withheld ? 'WITHHELD' : 'CLASSIFIED'),
  };
}

async function readRegularNoFollow(filePath, maxBytes, expectedBytes = null) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    const named = await lstat(filePath);
    if (!opened.isFile() || named.isSymbolicLink() || !named.isFile() ||
        opened.dev !== named.dev || opened.ino !== named.ino || (opened.mode & 0o077) !== 0 || opened.size > maxBytes ||
        (expectedBytes !== null && opened.size !== expectedBytes)) throw failure('CAPTURE_FILE_INVALID');
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw failure('CAPTURE_FILE_CHANGED');
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino) throw failure('CAPTURE_FILE_CHANGED');
    return bytes;
  } finally {
    await handle?.close();
  }
}

function validCaptureShape(capture, liveRecord, expectedArgv, expectedCwd) {
  const keys = [
    'schema', 'label', 'argv', 'cwd', 'pid', 'processGroup', 'startedAtUtc', 'endedAtUtc',
    'exitCode', 'signal', 'timedOut', 'spawnFailed', 'stdout', 'stderr',
  ];
  const streamKeys = ['file', 'capturedBytes', 'observedBytes', 'truncated', 'sha256'];
  if (!exactKeys(capture, keys) || capture.schema !== CAPTURE_SCHEMA || capture.label !== 'browser' ||
      !Array.isArray(capture.argv) || !capture.argv.every((item) => typeof item === 'string') ||
      !isDeepStrictEqual(capture.argv, expectedArgv) || capture.cwd !== expectedCwd ||
      capture.pid !== liveRecord.pid || capture.processGroup !== liveRecord.processGroup ||
      capture.startedAtUtc !== liveRecord.startedAtUtc || capture.endedAtUtc !== liveRecord.endedAtUtc ||
      capture.exitCode !== liveRecord.exitCode || capture.signal !== liveRecord.signal ||
      capture.timedOut !== liveRecord.timedOut || capture.spawnFailed !== liveRecord.spawnFailed ||
      !exactKeys(capture.stdout, streamKeys) || !exactKeys(capture.stderr, streamKeys)) return false;
  for (const [stream, filename] of [[capture.stdout, 'browser.stdout.raw'], [capture.stderr, 'browser.stderr.raw']]) {
    if (stream.file !== filename || !Number.isSafeInteger(stream.capturedBytes) || stream.capturedBytes < 0 ||
        !Number.isSafeInteger(stream.observedBytes) || stream.observedBytes < stream.capturedBytes ||
        stream.truncated !== (stream.observedBytes > stream.capturedBytes) ||
        typeof stream.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(stream.sha256)) return false;
  }
  const started = capture.pid !== null;
  const hasExitCode = capture.exitCode !== null;
  const hasSignal = capture.signal !== null;
  return capture.stderr.capturedBytes <= MAX_STDERR_BYTES &&
    (capture.pid === null || (Number.isSafeInteger(capture.pid) && capture.pid > 0)) &&
    (capture.processGroup === null || capture.processGroup === capture.pid) &&
    (capture.exitCode === null || (Number.isInteger(capture.exitCode) && capture.exitCode >= 0 && capture.exitCode <= 255)) &&
    (capture.signal === null || SIGNALS.has(capture.signal)) &&
    (started ? hasExitCode !== hasSignal : !hasExitCode && !hasSignal) &&
    typeof capture.timedOut === 'boolean' && typeof capture.spawnFailed === 'boolean' &&
    (capture.startedAtUtc === null || validUtc(capture.startedAtUtc)) &&
    (capture.endedAtUtc === null || validUtc(capture.endedAtUtc));
}

export async function readCompletedBrowserCapture(privateRoot, liveRecord, { expectedArgv, expectedCwd }) {
  if (!isPlainRecord(liveRecord) || liveRecord.captureFailed === true || liveRecord.endedAtUtc === null ||
      !Array.isArray(expectedArgv) || typeof expectedCwd !== 'string') throw failure('CAPTURE_NOT_COMPLETE');
  const processPath = path.join(privateRoot, 'browser.process.json');
  const captureBytes = await readRegularNoFollow(processPath, 16 * 1024);
  let capture;
  try { capture = JSON.parse(captureBytes.toString('utf8')); } catch { throw failure('CAPTURE_RECORD_INVALID'); }
  if (!validCaptureShape(capture, liveRecord, expectedArgv, expectedCwd)) throw failure('CAPTURE_RECORD_INVALID');

  const stderrPath = path.join(privateRoot, 'browser.stderr.raw');
  const stderrBytes = await readRegularNoFollow(stderrPath, MAX_STDERR_BYTES, capture.stderr.capturedBytes);
  if (hash(stderrBytes) !== capture.stderr.sha256) throw failure('CAPTURE_STREAM_MISMATCH');
  const started = capture.pid !== null;
  if (started && (!validUtc(capture.startedAtUtc) || !validUtc(capture.endedAtUtc) ||
      Date.parse(capture.endedAtUtc) < Date.parse(capture.startedAtUtc))) throw failure('CAPTURE_RECORD_INVALID');
  const process = {
    started,
    exitCode: started ? capture.exitCode : null,
    signal: started ? capture.signal : null,
    startedAtUtc: started ? capture.startedAtUtc : null,
    endedAtUtc: started ? capture.endedAtUtc : null,
    timedOut: started && capture.timedOut,
    spawnFailed: capture.spawnFailed,
    cleanupRequested: false,
  };
  return { process, diagnostics: sanitizeStderr(stderrBytes, { truncated: capture.stderr.truncated }) };
}

export function noBrowserCapture() {
  return {
    process: {
      started: false, exitCode: null, signal: null, startedAtUtc: null, endedAtUtc: null,
      timedOut: false, spawnFailed: false, cleanupRequested: false,
    },
    diagnostics: { stderrCategories: ['UNKNOWN'], stderrTruncated: false, stderrStatus: 'NOT_STARTED' },
  };
}

export function validateFailureSummary(value, binding, allowedReasons) {
  if (!validBinding(binding) || !(allowedReasons instanceof Set) ||
      !exactKeys(value, ['schema', 'status', 'runId', 'runAttempt', 'candidateSha', 'phase', 'reason', 'process', 'diagnostics']) ||
      value.schema !== FAILURE_SUMMARY_SCHEMA || value.status !== 'FAIL' ||
      value.runId !== binding.runId || value.runAttempt !== binding.runAttempt || value.candidateSha !== binding.candidateSha ||
      !allowedReasons.has(value.phase) || !allowedReasons.has(value.reason)) return false;

  const processKeys = ['started', 'exitCode', 'signal', 'startedAtUtc', 'endedAtUtc', 'timedOut', 'spawnFailed', 'cleanupRequested'];
  const process = value.process;
  if (!exactKeys(process, processKeys) || typeof process.started !== 'boolean' ||
      typeof process.timedOut !== 'boolean' || typeof process.spawnFailed !== 'boolean' ||
      typeof process.cleanupRequested !== 'boolean' ||
      (process.exitCode !== null && (!Number.isInteger(process.exitCode) || process.exitCode < 0 || process.exitCode > 255)) ||
      (process.signal !== null && !SIGNALS.has(process.signal))) return false;
  if (!process.started) {
    if (process.exitCode !== null || process.signal !== null || process.startedAtUtc !== null || process.endedAtUtc !== null ||
        process.timedOut || process.cleanupRequested) return false;
  } else {
    if (!validUtc(process.startedAtUtc) || !validUtc(process.endedAtUtc) ||
        Date.parse(process.endedAtUtc) < Date.parse(process.startedAtUtc) ||
        ((process.exitCode !== null) === (process.signal !== null)) ||
        ((process.timedOut || process.cleanupRequested) && !process.started)) return false;
  }

  const diagnostics = value.diagnostics;
  if (!exactKeys(diagnostics, ['stderrCategories', 'stderrTruncated', 'stderrStatus']) ||
      !Array.isArray(diagnostics.stderrCategories) || diagnostics.stderrCategories.length < 1 ||
      diagnostics.stderrCategories.length > MAX_DIAGNOSTIC_CODES ||
      !diagnostics.stderrCategories.every((code) => typeof code === 'string' && code.length <= MAX_DIAGNOSTIC_CODE_LENGTH && DIAGNOSTIC_CODES.has(code)) ||
      typeof diagnostics.stderrTruncated !== 'boolean' || !STDERR_STATUSES.has(diagnostics.stderrStatus)) return false;
  if (process.started && diagnostics.stderrStatus === 'NOT_STARTED') return false;
  if ((diagnostics.stderrStatus === 'TRUNCATED') !== diagnostics.stderrTruncated) return false;
  if (diagnostics.stderrStatus === 'NOT_STARTED' &&
      (!isDeepStrictEqual(diagnostics.stderrCategories, ['UNKNOWN']) || process.started)) return false;
  return true;
}

export function buildFailureSummary({ binding, phase, reason, process, diagnostics, allowedReasons }) {
  const value = {
    schema: FAILURE_SUMMARY_SCHEMA,
    status: 'FAIL',
    runId: binding.runId,
    runAttempt: binding.runAttempt,
    candidateSha: binding.candidateSha,
    phase,
    reason,
    process,
    diagnostics,
  };
  if (!validateFailureSummary(value, binding, allowedReasons)) throw failure('SUMMARY_INVALID');
  return value;
}

async function readResultForPublication(directory, expectedResult) {
  const resultPath = path.join(directory, RESULT_FILENAME);
  const bytes = await readRegularNoFollow(resultPath, 16 * 1024);
  let result;
  try { result = JSON.parse(bytes.toString('utf8')); } catch { throw failure('RESULT_BINDING_INVALID'); }
  if (!isDeepStrictEqual(result, expectedResult) || result.status !== 'FAIL') throw failure('RESULT_BINDING_INVALID');
}

export async function publishFailureSummary(directory, value, { binding, allowedReasons, expectedResult }) {
  if (!validateFailureSummary(value, binding, allowedReasons)) throw failure('SUMMARY_INVALID');
  if (!isPlainRecord(expectedResult) || expectedResult.status !== 'FAIL' ||
      expectedResult.runId !== binding.runId || expectedResult.runAttempt !== binding.runAttempt ||
      expectedResult.candidateSha !== binding.candidateSha || expectedResult.reason !== value.reason) {
    throw failure('RESULT_BINDING_INVALID');
  }
  const root = path.resolve(directory);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o077) !== 0 || await realpath(root) !== root) {
    throw failure('OUTPUT_ROOT_INVALID');
  }
  const entries = await readdir(root);
  if (entries.length !== 1 || entries[0] !== RESULT_FILENAME) throw failure('OUTPUT_ROOT_STALE');
  await readResultForPublication(root, expectedResult);

  const destination = path.join(root, FAILURE_SUMMARY_FILENAME);
  const temporary = path.join(root, `.failure-summary-${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (bytes.length > MAX_SUMMARY_BYTES) throw failure('SUMMARY_TOO_LARGE');
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, destination);
    await unlink(temporary);
    const directoryHandle = await open(root, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return destination;
}

export async function validateFailureSummaryFiles({ artifactRoot, binding, allowedReasons, expectedResult }) {
  if (!validBinding(binding) || typeof artifactRoot !== 'string' || !path.isAbsolute(artifactRoot)) throw failure('RUN_BINDING_INVALID');
  const root = path.resolve(artifactRoot);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o077) !== 0 || await realpath(root) !== root) {
    throw failure('OUTPUT_ROOT_INVALID');
  }
  const entries = (await readdir(root)).sort();
  if (!isDeepStrictEqual(entries, [FAILURE_SUMMARY_FILENAME, RESULT_FILENAME].sort())) throw failure('OUTPUT_ROOT_STALE');
  const resultBytes = await readRegularNoFollow(path.join(root, RESULT_FILENAME), 16 * 1024);
  let result;
  try { result = JSON.parse(resultBytes.toString('utf8')); } catch { throw failure('RESULT_BINDING_INVALID'); }
  if (!isDeepStrictEqual(result, expectedResult) || result.status !== 'FAIL' ||
      result.runId !== binding.runId || result.runAttempt !== binding.runAttempt || result.candidateSha !== binding.candidateSha) {
    throw failure('RESULT_BINDING_INVALID');
  }
  const summaryPath = path.join(root, FAILURE_SUMMARY_FILENAME);
  const summaryBytes = await readRegularNoFollow(summaryPath, MAX_SUMMARY_BYTES);
  let summary;
  try { summary = JSON.parse(summaryBytes.toString('utf8')); } catch { throw failure('SUMMARY_INVALID'); }
  if (!validateFailureSummary(summary, binding, allowedReasons) || summary.reason !== result.reason) throw failure('SUMMARY_INVALID');
  return summary;
}
