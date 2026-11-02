import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link, lstat, open, realpath, readdir, unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const FAILURE_SUMMARY_SCHEMA = 'ActivityVisibleCountFailureSummary/v2';
export const MAX_STDERR_BYTES = 64 * 1024;
export const MAX_SUMMARY_BYTES = 8 * 1024;
export const MAX_DIAGNOSTIC_CODES = 8;
export const MAX_DIAGNOSTIC_CODE_LENGTH = 256;
export const MAX_DIAGNOSTIC_LINES = 8;
export const MAX_DIAGNOSTIC_LINE_BYTES = 256;
export const MAX_FIRST_RELEVANT_DIAGNOSTIC_BYTES = 300;
export const MAX_DIAGNOSTIC_TOTAL_BYTES = 2048;
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
const RELEVANT_DIAGNOSTIC_TOKEN = /\b(?:FATAL|sandbox|namespace)\b/i;
const STDERR_STATUSES = new Set(['NOT_STARTED', 'EMPTY', 'CLASSIFIED', 'WITHHELD', 'TRUNCATED']);
const STDERR_REDACTION_MARKER = '[REDACTED]';
const STDERR_SAFE_SEGMENTS = [STDERR_REDACTION_MARKER, 'FATAL', 'sandbox', 'namespace', ...STDERR_PHRASES.keys()];
const escapeRegex = (value) => value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
const STDERR_SAFE_SEGMENT_PATTERN = STDERR_SAFE_SEGMENTS.map(escapeRegex).join('|');
const STDERR_SAFE_LINE_PATTERN = new RegExp(
  '^(?:' + STDERR_SAFE_SEGMENT_PATTERN + ')(?: (?:' + STDERR_SAFE_SEGMENT_PATTERN + '))*$',
);
const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|.)/g;
const UNSAFE_CODEPOINT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const URL_OR_EMAIL = /(?:\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s<>"']+)|(?:\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/gi;
const ABSOLUTE_PATH = /(?<![A-Za-z0-9])(?:\/[^\s<>"']+|[A-Za-z]:\\[^\s<>"']+)/g;
const PRIVATE_ASSIGNMENT = /\b(?:pass(?:word|wd)?|token|secret|credential|authorization|cookie|api[-_]?key|access[-_]?key)\b\s*[:=].*$/i;

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

function maskQuotedSegments(value) {
  let output = '';
  let redacted = false;
  for (let index = 0; index < value.length;) {
    const quote = value[index];
    const prior = value[index - 1];
    const startsQuote = quote === '"' || quote === '\x60' ||
      (quote === "'" && (prior === undefined || !/[A-Za-z0-9_]/.test(prior)));
    if (!startsQuote) {
      output += quote;
      index += 1;
      continue;
    }
    redacted = true;
    let cursor = index + 1;
    let closed = false;
    while (cursor < value.length) {
      if (value[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (value[cursor] === quote) {
        cursor += 1;
        closed = true;
        break;
      }
      cursor += 1;
    }
    output += '\u0000';
    index = closed ? cursor : value.length;
  }
  return { value: output, redacted };
}

function maskMatches(value, pattern) {
  let redacted = false;
  const masked = value.replace(pattern, () => {
    redacted = true;
    return '\u0000';
  });
  return { value: masked, redacted };
}

function projectDiagnosticLine(sourceLine) {
  let value = sourceLine.endsWith('\r') ? sourceLine.slice(0, -1) : sourceLine;
  let redacted = false;
  const ansi = maskMatches(value, ANSI_ESCAPE);
  value = ansi.value;
  redacted ||= ansi.redacted;
  const controls = maskMatches(value, UNSAFE_CODEPOINT);
  value = controls.value;
  redacted ||= controls.redacted;
  const quoted = maskQuotedSegments(value);
  value = quoted.value;
  redacted ||= quoted.redacted;
  for (const pattern of [URL_OR_EMAIL, ABSOLUTE_PATH, PRIVATE_ASSIGNMENT]) {
    const masked = maskMatches(value, pattern);
    value = masked.value;
    redacted ||= masked.redacted;
  }

  const matches = [];
  for (const phrase of STDERR_PHRASES.keys()) {
    let offset = 0;
    while (offset < value.length) {
      const start = value.indexOf(phrase, offset);
      if (start < 0) break;
      const end = start + phrase.length;
      const before = value[start - 1];
      const after = value[end];
      const hasSafeBoundaries = (before === undefined || !/[A-Za-z0-9_]/.test(before)) &&
        (after === undefined || !/[A-Za-z0-9_]/.test(after));
      if (hasSafeBoundaries) matches.push({ start, end, phrase });
      offset = end;
    }
  }
  for (const match of value.matchAll(/\b(?:FATAL|sandbox|namespace)\b/gi)) {
    const token = match[0].toLowerCase() === 'fatal' ? 'FATAL' : match[0].toLowerCase();
    matches.push({ start: match.index, end: match.index + match[0].length, phrase: token });
  }
  matches.sort((left, right) => left.start - right.start || right.end - left.end);

  const parts = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) continue;
    const gap = value.slice(cursor, match.start);
    if (/\S/.test(gap)) {
      parts.push(STDERR_REDACTION_MARKER);
      redacted = true;
    }
    parts.push(match.phrase);
    cursor = match.end;
  }
  if (/\S/.test(value.slice(cursor))) {
    parts.push(STDERR_REDACTION_MARKER);
    redacted = true;
  }
  if (parts.length === 0) {
    parts.push(STDERR_REDACTION_MARKER);
    redacted = true;
  }

  let output = '';
  let truncated = false;
  const writtenParts = [];
  for (const part of parts) {
    const next = output.length === 0 ? part : ' ' + part;
    if (Buffer.byteLength(output + next, 'utf8') > MAX_DIAGNOSTIC_LINE_BYTES) {
      truncated = true;
      break;
    }
    writtenParts.push(part);
    output += next;
  }
  if (truncated && redacted && !writtenParts.includes(STDERR_REDACTION_MARKER)) {
    while (writtenParts.length > 0 &&
        Buffer.byteLength(writtenParts.concat(STDERR_REDACTION_MARKER).join(' '), 'utf8') > MAX_DIAGNOSTIC_LINE_BYTES) {
      writtenParts.pop();
    }
    writtenParts.push(STDERR_REDACTION_MARKER);
    output = writtenParts.join(' ');
  }
  return { line: output, redacted, truncated };
}

export function sanitizeStderr(bytes, { truncated = false } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length > MAX_STDERR_BYTES || typeof truncated !== 'boolean') {
    throw failure('STDERR_INPUT_INVALID');
  }
  if (bytes.length === 0) {
    return {
      stderrCategories: ['UNKNOWN'], stderrLines: [], stderrTruncated: truncated,
      stderrFirstRelevantLine: null, stderrRedacted: false, stderrStatus: truncated ? 'TRUNCATED' : 'EMPTY',
    };
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return {
      stderrCategories: ['UNKNOWN'], stderrLines: [STDERR_REDACTION_MARKER],
      stderrTruncated: truncated, stderrFirstRelevantLine: null, stderrRedacted: true,
      stderrStatus: truncated ? 'TRUNCATED' : 'WITHHELD',
    };
  }

  const lines = text.split('\n');
  const categories = [];
  const stderrLines = [];
  let withheld = false;
  let considered = 0;
  let outputTruncated = truncated;
  let stderrRedacted = false;
  let stderrFirstRelevantLine = null;
  for (const sourceLine of lines) {
    const line = sourceLine.endsWith('\r') ? sourceLine.slice(0, -1) : sourceLine;
    if (line.length === 0) continue;
    considered += 1;
    const projected = projectDiagnosticLine(sourceLine);
    const keepLine = stderrLines.length < MAX_DIAGNOSTIC_LINES;
    if (keepLine) stderrLines.push(projected.line);
    else outputTruncated = true;
    if (stderrFirstRelevantLine === null && RELEVANT_DIAGNOSTIC_TOKEN.test(line)) {
      stderrFirstRelevantLine = projected.line;
      stderrRedacted ||= projected.redacted;
    }
    const category = STDERR_PHRASES.get(line);
    if (category) categories.push(category);
    else withheld = true;
    if (keepLine) stderrRedacted ||= projected.redacted;
    outputTruncated ||= projected.truncated;
    withheld ||= projected.redacted;
  }
  if (considered === 0) {
    withheld = true;
    stderrRedacted = true;
    stderrLines.push(STDERR_REDACTION_MARKER);
  }

  if (withheld && categories.length < MAX_DIAGNOSTIC_CODES) categories.push('STDERR_WITHHELD');
  if (outputTruncated && categories.length < MAX_DIAGNOSTIC_CODES && !categories.includes('STDERR_WITHHELD')) {
    categories.push('STDERR_WITHHELD');
  }
  if (categories.length === 0) categories.push('UNKNOWN');
  return {
    stderrCategories: categories.slice(0, MAX_DIAGNOSTIC_CODES),
    stderrLines,
    stderrTruncated: outputTruncated,
    stderrFirstRelevantLine,
    stderrRedacted,
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
    diagnostics: {
      stderrCategories: ['UNKNOWN'], stderrLines: [], stderrTruncated: false,
      stderrFirstRelevantLine: null, stderrRedacted: false, stderrStatus: 'NOT_STARTED',
    },
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
  const diagnosticsWithFirstLine = exactKeys(diagnostics, [
    'stderrCategories', 'stderrLines', 'stderrTruncated', 'stderrFirstRelevantLine', 'stderrRedacted', 'stderrStatus',
  ]);
  const legacyDiagnostics = exactKeys(diagnostics, [
    'stderrCategories', 'stderrLines', 'stderrTruncated', 'stderrRedacted', 'stderrStatus',
  ]);
  if ((!diagnosticsWithFirstLine && !legacyDiagnostics) ||
      !Array.isArray(diagnostics.stderrCategories) || diagnostics.stderrCategories.length < 1 ||
      diagnostics.stderrCategories.length > MAX_DIAGNOSTIC_CODES ||
      !diagnostics.stderrCategories.every((code) => typeof code === 'string' && code.length <= MAX_DIAGNOSTIC_CODE_LENGTH && DIAGNOSTIC_CODES.has(code)) ||
      !Array.isArray(diagnostics.stderrLines) || diagnostics.stderrLines.length > MAX_DIAGNOSTIC_LINES ||
      !diagnostics.stderrLines.every((line) => typeof line === 'string' &&
        !line.includes('\n') && !line.includes('\r') &&
        Buffer.byteLength(line, 'utf8') <= MAX_DIAGNOSTIC_LINE_BYTES && STDERR_SAFE_LINE_PATTERN.test(line)) ||
      diagnostics.stderrLines.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8'), 0) > MAX_DIAGNOSTIC_TOTAL_BYTES ||
      !(diagnostics.stderrFirstRelevantLine === undefined || diagnostics.stderrFirstRelevantLine === null || (typeof diagnostics.stderrFirstRelevantLine === 'string' &&
        Buffer.byteLength(diagnostics.stderrFirstRelevantLine, 'utf8') <= MAX_FIRST_RELEVANT_DIAGNOSTIC_BYTES &&
        STDERR_SAFE_LINE_PATTERN.test(diagnostics.stderrFirstRelevantLine))) ||
      typeof diagnostics.stderrTruncated !== 'boolean' || typeof diagnostics.stderrRedacted !== 'boolean' ||
      !STDERR_STATUSES.has(diagnostics.stderrStatus)) return false;
  const hasRedactionMarker = diagnostics.stderrLines.some((line) => line.includes(STDERR_REDACTION_MARKER));
  if (diagnostics.stderrRedacted !== (hasRedactionMarker || diagnostics.stderrFirstRelevantLine?.includes(STDERR_REDACTION_MARKER) === true)) return false;
  if (process.started && diagnostics.stderrStatus === 'NOT_STARTED') return false;
  if ((diagnostics.stderrStatus === 'TRUNCATED') !== diagnostics.stderrTruncated) return false;
  if (diagnostics.stderrStatus === 'NOT_STARTED' &&
      (!isDeepStrictEqual(diagnostics.stderrCategories, ['UNKNOWN']) || diagnostics.stderrLines.length !== 0 ||
        diagnostics.stderrRedacted || process.started)) return false;
  if (diagnostics.stderrStatus === 'EMPTY' &&
      (!isDeepStrictEqual(diagnostics.stderrCategories, ['UNKNOWN']) || diagnostics.stderrLines.length !== 0 ||
        diagnostics.stderrRedacted || diagnostics.stderrTruncated)) return false;
  if (diagnostics.stderrStatus === 'WITHHELD' &&
      (diagnostics.stderrLines.length === 0 ||
        (!diagnostics.stderrCategories.includes('STDERR_WITHHELD') &&
          !isDeepStrictEqual(diagnostics.stderrCategories, ['UNKNOWN'])))) return false;
  if (diagnostics.stderrStatus === 'CLASSIFIED' &&
      (diagnostics.stderrRedacted || diagnostics.stderrTruncated || diagnostics.stderrLines.length === 0 ||
        diagnostics.stderrCategories.includes('STDERR_WITHHELD'))) return false;
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
