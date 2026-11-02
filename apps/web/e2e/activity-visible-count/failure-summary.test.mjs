import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  FAILURE_SUMMARY_FILENAME,
  FAILURE_SUMMARY_SCHEMA,
  MAX_DIAGNOSTIC_CODES,
  MAX_DIAGNOSTIC_LINES,
  MAX_DIAGNOSTIC_LINE_BYTES,
  MAX_DIAGNOSTIC_TOTAL_BYTES,
  MAX_FIRST_RELEVANT_DIAGNOSTIC_BYTES,
  MAX_STDERR_BYTES,
  buildFailureSummary,
  noBrowserCapture,
  publishFailureSummary,
  readCompletedBrowserCapture,
  sanitizeStderr,
  validateFailureSummary,
  validateFailureSummaryFiles,
} from './failure-summary.mjs';
import { __test as driver } from './run.mjs';

const binding = {
  runId: '41471512074',
  runAttempt: 1,
  candidateSha: 'a'.repeat(40),
};
const reasons = new Set(driver.FAILURE_REASONS);
const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryDirectory = path.resolve(fixtureDirectory, '../../../..');
const reason = 'BROWSER_SPAWN_FAILED';

function startedProcess(overrides = {}) {
  return {
    started: true,
    exitCode: 23,
    signal: null,
    startedAtUtc: '2026-11-02T15:50:00.000Z',
    endedAtUtc: '2026-11-02T15:50:01.000Z',
    timedOut: false,
    spawnFailed: false,
    cleanupRequested: false,
    ...overrides,
  };
}

function summaryFor(process, diagnostics = sanitizeStderr(Buffer.alloc(0)), identity = binding) {
  return buildFailureSummary({
    binding: identity,
    phase: reason,
    reason,
    process,
    diagnostics,
    allowedReasons: reasons,
  });
}

function failedResult(identity = binding) {
  return {
    schema: driver.RESULT_SCHEMA,
    status: 'FAIL',
    reason,
    candidateSha: identity.candidateSha,
    runId: identity.runId,
    runAttempt: identity.runAttempt,
    componentSha256: driver.EXPECTED_COMPONENT_SHA256,
    browserVersionOutcome: 'VERSION_FAILED',
    browserVersion: null,
    browserSha256: null,
    scenarioVerdicts: Object.fromEntries(driver.SCENARIOS.map((scenario) => [scenario, 'NOT_MEASURED'])),
    counts: {
      localAssetRequests: 0,
      blockedNetworkRequests: 0,
      networkViolations: 0,
      websocketAttempts: 0,
      syntheticGetAttempts: 0,
      syntheticGetSuccesses: 0,
      rejectedAdapterCalls: 0,
      mutationAttempts: 0,
    },
  };
}

async function makeOutputRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'activity-failure-summary-'));
  const result = failedResult();
  await writeFile(path.join(root, 'result.json'), `${JSON.stringify(result)}\n`, { mode: 0o600, flag: 'wx' });
  return { root, result };
}

test('stderr uses only exact finite category mappings and withholds arbitrary text', () => {
  const hostile = [
    'No usable sandbox!',
    'https://user:password@private.example/path?token=secret',
    '/home/runner/private/profile/cookies',
    'TOKEN=secret-value PATH=/private/bin',
    '\u001b[31mNo usable sandbox!\u001b[0m',
    'No usable sandbox! extra credential=secret',
    'line one\nline two',
    'unicode: \u202e private user@example.invalid',
  ].join('\n');
  const result = sanitizeStderr(Buffer.from(hostile));
  const serialized = JSON.stringify(result);
  assert.ok(result.stderrCategories.includes('BROWSER_SANDBOX_UNAVAILABLE'));
  assert.ok(result.stderrCategories.includes('STDERR_WITHHELD'));
  assert.ok(result.stderrCategories.length <= MAX_DIAGNOSTIC_CODES);
  assert.ok(result.stderrCategories.every((item) => item.length <= 256));
  for (const secret of ['password', 'private.example', '/home/runner', 'secret-value', 'credential', 'user@example.invalid']) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(result.stderrStatus, 'TRUNCATED');
  assert.equal(result.stderrTruncated, true);
});

test('stderr bounds bytes, lines, invalid UTF-8, and truncation without publishing source text', () => {
  assert.throws(() => sanitizeStderr(Buffer.alloc(MAX_STDERR_BYTES + 1)), { code: 'STDERR_INPUT_INVALID' });
  const tooManyLines = Buffer.from(`${Array.from({ length: 12 }, () => 'untrusted diagnostic').join('\n')}\n`);
  const lineBounded = sanitizeStderr(tooManyLines);
  assert.equal(lineBounded.stderrTruncated, true);
  assert.ok(lineBounded.stderrCategories.length <= MAX_DIAGNOSTIC_CODES);
  assert.deepEqual(sanitizeStderr(Buffer.from([0xff])).stderrCategories, ['UNKNOWN']);
  const fullBound = sanitizeStderr(Buffer.alloc(MAX_STDERR_BYTES, 0x78), { truncated: true });
  assert.equal(fullBound.stderrTruncated, true);
  assert.ok(fullBound.stderrCategories.every((item) => !item.includes('x')));
});

test('NEW stderr projection keeps prefixed safe diagnostics and visibly redacts private segments', () => {
  const quotedPhrase = String.fromCharCode(96) + 'Missing X server or $DISPLAY' + String.fromCharCode(96);
  const input = [
    '[123:456:ERROR:chrome/zygote_host/zygote_host_impl_linux.cc(100)] No usable sandbox! /home/dev/private/profile',
    "INFO: DevToolsActivePort file doesn't exist https://user:password@example.invalid/path?token=secret",
    'Missing X server or $DISPLAY; contact user@example.invalid token=opaque-secret-value',
    'quoted "No usable sandbox!" and ' + quotedPhrase,
    'ANSI \u001b[31mNo usable sandbox!\u001b[0m\u0007 \u202e hidden',
    'No usable sandbox! credential=private-credential-value',
  ].join('\n');
  const diagnostics = sanitizeStderr(Buffer.from(input));
  assert.deepEqual(diagnostics.stderrLines, [
    '[REDACTED] No usable sandbox! [REDACTED]',
    '[REDACTED] DevToolsActivePort file doesn\'t exist [REDACTED]',
    'Missing X server or $DISPLAY [REDACTED]',
    '[REDACTED]',
    '[REDACTED] No usable sandbox! [REDACTED]',
    'No usable sandbox! [REDACTED]',
  ]);
  assert.equal(diagnostics.stderrRedacted, true);
  assert.equal(diagnostics.stderrStatus, 'WITHHELD');
  assert.ok(diagnostics.stderrCategories.includes('STDERR_WITHHELD'));

  const serialized = JSON.stringify(summaryFor(startedProcess(), diagnostics));
  for (const privateValue of [
    '/home/dev/private/profile', 'user:password', 'example.invalid', 'token=secret',
    'user@example.invalid', 'opaque-secret-value', 'quoted', 'private-credential-value', 'hidden',
  ]) {
    assert.equal(serialized.includes(privateValue), false, privateValue);
  }
  assert.match(serialized, /No usable sandbox!/);
  assert.match(serialized, /DevToolsActivePort file doesn.t exist/);
});

test('NEW stderr projection fails closed on invalid UTF-8 and bounds line count, line bytes, and total bytes', () => {
  const invalid = sanitizeStderr(Buffer.from([0x4e, 0x6f, 0x20, 0xff]));
  assert.deepEqual(invalid.stderrLines, ['[REDACTED]']);
  assert.equal(invalid.stderrRedacted, true);
  assert.equal(invalid.stderrStatus, 'WITHHELD');

  const empty = summaryFor(startedProcess(), sanitizeStderr(Buffer.alloc(0)));
  assert.equal(empty.diagnostics.stderrStatus, 'EMPTY');
  assert.equal(validateFailureSummary(empty, binding, reasons), true);
  const paddedDiagnostic = summaryFor(startedProcess(), sanitizeStderr(Buffer.from(' No usable sandbox! ')));
  assert.deepEqual(paddedDiagnostic.diagnostics.stderrLines, ['No usable sandbox!']);
  assert.equal(paddedDiagnostic.diagnostics.stderrStatus, 'WITHHELD');
  assert.equal(paddedDiagnostic.diagnostics.stderrRedacted, false);
  assert.equal(validateFailureSummary(paddedDiagnostic, binding, reasons), true);
  const notStarted = noBrowserCapture();
  const notStartedSummary = summaryFor(notStarted.process, notStarted.diagnostics);
  assert.equal(notStartedSummary.diagnostics.stderrStatus, 'NOT_STARTED');
  assert.equal(validateFailureSummary(notStartedSummary, binding, reasons), true);

  const tooManyLines = sanitizeStderr(Buffer.from(Array.from(
    { length: MAX_DIAGNOSTIC_LINES + 2 },
    () => 'No usable sandbox!',
  ).join('\n')));
  assert.equal(tooManyLines.stderrLines.length, MAX_DIAGNOSTIC_LINES);
  assert.equal(tooManyLines.stderrTruncated, true);
  assert.equal(tooManyLines.stderrStatus, 'TRUNCATED');

  const longLine = sanitizeStderr(Buffer.from(Array.from(
    { length: 80 },
    () => 'No usable sandbox!',
  ).join(' ') + ' private-tail=opaque-long-token'));
  assert.equal(longLine.stderrLines.length, 1);
  assert.ok(Buffer.byteLength(longLine.stderrLines[0], 'utf8') <= MAX_DIAGNOSTIC_LINE_BYTES);
  assert.equal(longLine.stderrTruncated, true);
  assert.equal(longLine.stderrRedacted, true);
  assert.ok(longLine.stderrLines[0].includes('[REDACTED]'));
  assert.ok(longLine.stderrLines.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8'), 0) <= MAX_DIAGNOSTIC_TOTAL_BYTES);

  const valid = summaryFor(startedProcess(), sanitizeStderr(Buffer.from(
    '[12:ERROR] No usable sandbox! token=do-not-retain',
  )));
  assert.equal(valid.schema, 'ActivityVisibleCountFailureSummary/v2');
  assert.equal(valid.diagnostics.stderrLines[0], '[REDACTED] No usable sandbox! [REDACTED]');
  assert.equal(validateFailureSummary(valid, binding, reasons), true);
  const legacyDiagnostics = { ...valid.diagnostics };
  delete legacyDiagnostics.stderrFirstRelevantLine;
  assert.equal(validateFailureSummary({ ...valid, diagnostics: legacyDiagnostics }, binding, reasons), true);
  assert.equal(validateFailureSummary({
    ...valid,
    diagnostics: { ...valid.diagnostics, stderrLines: ['No usable sandbox! password=raw'] },
  }, binding, reasons), false);
  assert.equal(validateFailureSummary({
    ...valid,
    diagnostics: { ...valid.diagnostics, stderrLines: [...valid.diagnostics.stderrLines], rawStderr: 'private' },
  }, binding, reasons), false);
  assert.equal(validateFailureSummary({
    ...valid,
    diagnostics: { ...valid.diagnostics, stderrLines: ['No usable sandbox!\n'] },
  }, binding, reasons), false);
  assert.equal(validateFailureSummary({
    ...valid,
    diagnostics: {
      ...valid.diagnostics,
      stderrLines: Array.from({ length: MAX_DIAGNOSTIC_LINES + 1 }, () => 'No usable sandbox!'),
    },
  }, binding, reasons), false);
  assert.equal(validateFailureSummary({
    ...valid,
    diagnostics: { ...valid.diagnostics, stderrLines: ['No usable sandbox! '.repeat(20)] },
  }, binding, reasons), false);
  assert.equal(validateFailureSummary({ ...valid, schema: 'ActivityVisibleCountFailureSummary/v1' }, binding, reasons), false);
  assert.equal(validateFailureSummary({ ...valid, candidateSha: 'b'.repeat(40) }, binding, reasons), false);
  assert.equal(validateFailureSummary({
    ...valid,
    diagnostics: { ...valid.diagnostics, stderrRedacted: false },
  }, binding, reasons), false);
  assert.equal(validateFailureSummary({
    ...valid,
    diagnostics: { ...valid.diagnostics, stderrLines: [42] },
  }, binding, reasons), false);
  assert.equal(validateFailureSummary({
    ...valid,
    diagnostics: { ...valid.diagnostics, stderrFirstRelevantLine: 'FATAL token=private' },
  }, binding, reasons), false);
});

test('first relevant stderr diagnostic scans the full bounded capture and exposes only safe tokens', () => {
  const input = [
    ...Array.from({ length: MAX_DIAGNOSTIC_LINES + 2 }, (_, index) => `irrelevant prefix ${index}`),
    'FATAL: sandbox initialization failed at /private/profile https://example.invalid/path?token=secret',
    'namespace sandbox later diagnostic',
  ].join('\n');
  const diagnostics = sanitizeStderr(Buffer.from(input));
  assert.equal(diagnostics.stderrLines.length, MAX_DIAGNOSTIC_LINES);
  assert.equal(diagnostics.stderrFirstRelevantLine, 'FATAL [REDACTED] sandbox [REDACTED]');
  assert.ok(Buffer.byteLength(diagnostics.stderrFirstRelevantLine, 'utf8') <= MAX_FIRST_RELEVANT_DIAGNOSTIC_BYTES);
  assert.equal(diagnostics.stderrTruncated, true);
  for (const privateValue of ['/private/profile', 'example.invalid', 'token=secret', 'initialization failed']) {
    assert.equal(JSON.stringify(diagnostics).includes(privateValue), false);
  }

  const order = sanitizeStderr(Buffer.from('namespace failure\nsandbox failure\nFATAL failure'));
  assert.equal(order.stderrFirstRelevantLine, 'namespace [REDACTED]');
  assert.equal(sanitizeStderr(Buffer.from('Fatal sandbox error')).stderrFirstRelevantLine, 'FATAL sandbox [REDACTED]');
  const noMatch = sanitizeStderr(Buffer.from('ordinary startup text\nno relevant marker'));
  assert.equal(noMatch.stderrFirstRelevantLine, null);

  const unicode = sanitizeStderr(Buffer.from(`FATAL ${'界'.repeat(400)}`));
  assert.ok(Buffer.byteLength(unicode.stderrFirstRelevantLine, 'utf8') <= MAX_FIRST_RELEVANT_DIAGNOSTIC_BYTES);
  assert.ok(unicode.stderrFirstRelevantLine.length <= 300);
});

test('known namespace permission diagnostics use fixed labels while spoofed or unknown text stays withheld', () => {
  const label = 'BROWSER_NAMESPACE_PERMISSION_DENIED';
  const synthetic = sanitizeStderr(Buffer.from(
    'FATAL: sandbox initialization failed: user namespace creation returned EPERM',
  ));
  assert.deepEqual(synthetic.stderrCategories, [label]);
  assert.deepEqual(synthetic.stderrLines, [label]);
  assert.equal(synthetic.stderrFirstRelevantLine, label);
  assert.equal(synthetic.stderrStatus, 'CLASSIFIED');
  assert.equal(synthetic.stderrRedacted, false);
  assert.equal(validateFailureSummary(summaryFor(startedProcess(), synthetic), binding, reasons), true);

  // This fixed diagnostic is present in Chromium's sandbox/linux/suid/sandbox.c.
  const chromium = sanitizeStderr(Buffer.from(
    'Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted',
  ));
  assert.deepEqual(chromium.stderrCategories, [label]);
  assert.deepEqual(chromium.stderrLines, [label]);
  assert.equal(chromium.stderrFirstRelevantLine, label);

  const unusableSandbox = sanitizeStderr(Buffer.from('No usable sandbox!'));
  assert.deepEqual(unusableSandbox.stderrCategories, ['BROWSER_SANDBOX_UNAVAILABLE']);
  assert.deepEqual(unusableSandbox.stderrLines, ['No usable sandbox!']);

  const spoofed = sanitizeStderr(Buffer.from([
    'message="FATAL: sandbox initialization failed: user namespace creation returned EPERM"',
    'FATAL: sandbox initialization failed: user namespace creation returned EPERM /private/profile',
    'FATAL: sandbox initialization failed: user namespace creation returned EPERM https://private.invalid/path?token=secret',
    'FATAL: sandbox initialization failed: user namespace creation returned \u001b[31mEPERM\u001b[0m',
    'FATAL: unrelated sandbox failure: namespace setup rejected with EPERM',
  ].join('\n')));
  const serialized = JSON.stringify(spoofed);
  assert.equal(spoofed.stderrCategories.includes(label), false);
  assert.equal(serialized.includes('private.invalid'), false);
  assert.equal(serialized.includes('/private/profile'), false);
  assert.equal(serialized.includes('token=secret'), false);
  assert.equal(serialized.includes('EPERM'), false);
  assert.equal(spoofed.stderrCategories.includes('STDERR_WITHHELD'), true);

  const tamperedLabel = summaryFor(startedProcess(), structuredClone(synthetic));
  tamperedLabel.diagnostics.stderrLines = ['BROWSER_NAMESPACE_PERMISSION_DENIED secret=leak'];
  assert.equal(validateFailureSummary(tamperedLabel, binding, reasons), false);
  const tamperedCategory = summaryFor(startedProcess(), structuredClone(synthetic));
  tamperedCategory.diagnostics.stderrCategories = ['BROWSER_NAMESPACE_PERMISSION_DENIED secret'];
  assert.equal(validateFailureSummary(tamperedCategory, binding, reasons), false);
});

test('failure summary preserves not-started, exit, signal, timeout, and requested-cleanup states', () => {
  const notStarted = noBrowserCapture();
  const noProcess = summaryFor(notStarted.process, notStarted.diagnostics);
  assert.equal(noProcess.process.started, false);
  assert.equal(noProcess.process.exitCode, null);
  assert.equal(noProcess.diagnostics.stderrStatus, 'NOT_STARTED');

  const exited = summaryFor(startedProcess({ exitCode: 17 }));
  assert.equal(exited.process.exitCode, 17);
  assert.equal(exited.process.signal, null);

  const cleanupSignal = summaryFor(startedProcess({ exitCode: null, signal: 'SIGTERM', cleanupRequested: true }));
  assert.equal(cleanupSignal.process.signal, 'SIGTERM');
  assert.equal(cleanupSignal.process.cleanupRequested, true);
  const unexpectedSignal = summaryFor(startedProcess({ exitCode: null, signal: 'SIGABRT', cleanupRequested: false }));
  assert.equal(unexpectedSignal.process.signal, 'SIGABRT');
  assert.equal(unexpectedSignal.process.cleanupRequested, false);

  const timeout = summaryFor(startedProcess({ exitCode: null, signal: 'SIGKILL', timedOut: true }));
  assert.equal(timeout.process.timedOut, true);
  assert.equal(timeout.process.cleanupRequested, false);
  assert.equal(validateFailureSummary({ ...timeout, process: { ...timeout.process, exitCode: 1 } }, binding, reasons), false);
});

test('completed summary requires exactly one exit code or signal', () => {
  const valid = summaryFor(startedProcess());
  const zeroExit = summaryFor(startedProcess({ exitCode: 0 }));
  assert.equal(zeroExit.process.exitCode, 0);
  assert.equal(validateFailureSummary(zeroExit, binding, reasons), true);
  for (const process of [
    { ...valid.process, exitCode: null, signal: null },
    { ...valid.process, exitCode: 23, signal: 'SIGTERM' },
  ]) {
    assert.equal(validateFailureSummary({ ...valid, process }, binding, reasons), false);
  }
});

test('summary schema, run/head/attempt binding, phase, reason, UTC and enums fail closed', () => {
  const value = summaryFor(startedProcess());
  assert.equal(value.schema, FAILURE_SUMMARY_SCHEMA);
  assert.equal(validateFailureSummary(value, binding, reasons), true);
  assert.equal(validateFailureSummary({ ...value, candidateSha: 'b'.repeat(40) }, binding, reasons), false);
  assert.equal(validateFailureSummary({ ...value, runAttempt: 2 }, binding, reasons), false);
  assert.equal(validateFailureSummary({ ...value, extra: 'private' }, binding, reasons), false);
  assert.equal(validateFailureSummary({ ...value, phase: 'untrusted failure' }, binding, reasons), false);
  assert.equal(validateFailureSummary({ ...value, process: { ...value.process, startedAtUtc: 'yesterday' } }, binding, reasons), false);
  assert.equal(validateFailureSummary({ ...value, diagnostics: { ...value.diagnostics, stderrCategories: ['https://secret.invalid/'] } }, binding, reasons), false);
});

test('completed direct-child capture is bound to process metadata and only stderr is read', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'activity-browser-capture-'));
  const privateRoot = path.join(root, 'private');
  await mkdir(privateRoot, { mode: 0o700 });
  const stderr = Buffer.from('No usable sandbox!\nsecret=https://user:pass@example.invalid\n');
  const record = {
    argv: [driver.EXPECTED_BROWSER_PATH, ...driver.browserArguments(path.join(privateRoot, 'browser-profile'))],
    cwd: privateRoot,
    pid: 1234,
    processGroup: 1234,
    startedAtUtc: '2026-11-02T15:50:00.000Z',
    endedAtUtc: '2026-11-02T15:50:01.000Z',
    exitCode: 23,
    signal: null,
    timedOut: false,
    spawnFailed: false,
  };
  const stream = { file: 'browser.stderr.raw', capturedBytes: stderr.length, observedBytes: stderr.length, truncated: false, sha256: createHash('sha256').update(stderr).digest('hex') };
  const capture = {
    schema: 'ActivityVisibleCountProcess/v1',
    label: 'browser',
    argv: record.argv,
    cwd: record.cwd,
    pid: record.pid,
    processGroup: record.processGroup,
    startedAtUtc: record.startedAtUtc,
    endedAtUtc: record.endedAtUtc,
    exitCode: record.exitCode,
    signal: record.signal,
    timedOut: record.timedOut,
    spawnFailed: record.spawnFailed,
    stdout: { file: 'browser.stdout.raw', capturedBytes: 0, observedBytes: 0, truncated: false, sha256: '0'.repeat(64) },
    stderr: stream,
  };
  try {
    await writeFile(path.join(privateRoot, 'browser.process.json'), JSON.stringify(capture), { mode: 0o600, flag: 'wx' });
    await writeFile(path.join(privateRoot, 'browser.stderr.raw'), stderr, { mode: 0o600, flag: 'wx' });
    const read = await readCompletedBrowserCapture(privateRoot, record, { expectedArgv: record.argv, expectedCwd: privateRoot });
    assert.equal(read.process.started, true);
    assert.equal(read.process.exitCode, 23);
    assert.deepEqual(read.diagnostics.stderrCategories, ['BROWSER_SANDBOX_UNAVAILABLE', 'STDERR_WITHHELD']);
    const serialized = JSON.stringify(read);
    for (const privateValue of ['example.invalid', privateRoot, driver.EXPECTED_BROWSER_PATH, 'browser-profile']) {
      assert.equal(serialized.includes(privateValue), false);
    }
    await assert.rejects(lstat(path.join(privateRoot, 'browser.stdout.raw')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('completed capture reader rejects missing or conflicting process outcomes', async () => {
  for (const outcome of [
    { exitCode: null, signal: null },
    { exitCode: 23, signal: 'SIGTERM' },
  ]) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'activity-browser-invalid-capture-'));
    const privateRoot = path.join(root, 'private');
    await mkdir(privateRoot, { mode: 0o700 });
    const stderr = Buffer.alloc(0);
    const record = {
      argv: [driver.EXPECTED_BROWSER_PATH, ...driver.browserArguments(path.join(privateRoot, 'browser-profile'))],
      cwd: privateRoot,
      pid: 1234,
      processGroup: 1234,
      startedAtUtc: '2026-11-02T15:50:00.000Z',
      endedAtUtc: '2026-11-02T15:50:01.000Z',
      timedOut: false,
      spawnFailed: false,
      ...outcome,
    };
    const capture = {
      schema: 'ActivityVisibleCountProcess/v1',
      label: 'browser',
      argv: record.argv,
      cwd: record.cwd,
      pid: record.pid,
      processGroup: record.processGroup,
      startedAtUtc: record.startedAtUtc,
      endedAtUtc: record.endedAtUtc,
      exitCode: record.exitCode,
      signal: record.signal,
      timedOut: record.timedOut,
      spawnFailed: record.spawnFailed,
      stdout: { file: 'browser.stdout.raw', capturedBytes: 0, observedBytes: 0, truncated: false, sha256: '0'.repeat(64) },
      stderr: { file: 'browser.stderr.raw', capturedBytes: 0, observedBytes: 0, truncated: false, sha256: createHash('sha256').update(stderr).digest('hex') },
    };
    try {
      await writeFile(path.join(privateRoot, 'browser.process.json'), JSON.stringify(capture), { mode: 0o600, flag: 'wx' });
      await writeFile(path.join(privateRoot, 'browser.stderr.raw'), stderr, { mode: 0o600, flag: 'wx' });
      await assert.rejects(
        readCompletedBrowserCapture(privateRoot, record, { expectedArgv: record.argv, expectedCwd: privateRoot }),
        { code: 'CAPTURE_RECORD_INVALID' },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('failure summary publishes exclusively and validates only the exact bound files', async () => {
  const { root, result } = await makeOutputRoot();
  try {
    const value = summaryFor(startedProcess(), sanitizeStderr(Buffer.from('unknown line with https://private.invalid/token')));
    const pathWritten = await publishFailureSummary(root, value, { binding, allowedReasons: reasons, expectedResult: result });
    assert.equal(path.basename(pathWritten), FAILURE_SUMMARY_FILENAME);
    assert.deepEqual(await validateFailureSummaryFiles({ artifactRoot: root, binding, allowedReasons: reasons, expectedResult: result }), value);
    const bytes = await readFile(pathWritten, 'utf8');
    assert.equal(bytes.includes('private.invalid'), false);
    assert.equal((await lstat(pathWritten)).mode & 0o077, 0);
    await assert.rejects(publishFailureSummary(root, value, { binding, allowedReasons: reasons, expectedResult: result }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('summary publication refuses stale roots, symlinks, non-regular result files, and PASS conversion', async () => {
  const stale = await makeOutputRoot();
  try {
    await writeFile(path.join(stale.root, 'private-profile'), 'do not publish');
    await assert.rejects(publishFailureSummary(stale.root, summaryFor(startedProcess()), {
      binding, allowedReasons: reasons, expectedResult: stale.result,
    }), { code: 'OUTPUT_ROOT_STALE' });
  } finally {
    await rm(stale.root, { recursive: true, force: true });
  }

  const linked = await makeOutputRoot();
  try {
    const target = `${linked.root}-target`;
    await symlink(target, path.join(linked.root, FAILURE_SUMMARY_FILENAME));
    await assert.rejects(validateFailureSummaryFiles({
      artifactRoot: linked.root, binding, allowedReasons: reasons, expectedResult: linked.result,
    }));
  } finally {
    await rm(linked.root, { recursive: true, force: true });
  }

  const nonRegular = await mkdtemp(path.join(os.tmpdir(), 'activity-failure-nonregular-'));
  try {
    await mkdir(path.join(nonRegular, 'result.json'));
    await assert.rejects(publishFailureSummary(nonRegular, summaryFor(startedProcess()), {
      binding, allowedReasons: reasons, expectedResult: failedResult(),
    }));
  } finally {
    await rm(nonRegular, { recursive: true, force: true });
  }

  const pass = { ...failedResult(), status: 'PASS', reason: null };
  await assert.rejects(publishFailureSummary('/tmp', summaryFor(startedProcess()), {
    binding, allowedReasons: reasons, expectedResult: pass,
  }), { code: 'RESULT_BINDING_INVALID' });
});

test('workflow validates summary before uploading exactly one summary file', async () => {
  const workflow = await readFile(path.join(repositoryDirectory, '.github/workflows/activity-visible-count-browser.yml'), 'utf8');
  const runner = await readFile(path.join(fixtureDirectory, 'run.mjs'), 'utf8');
  assert.match(workflow, /node --test apps\/web\/e2e\/activity-visible-count\/source\.test\.mjs apps\/web\/e2e\/activity-visible-count\/failure-summary\.test\.mjs/);
  const resultValidation = workflow.indexOf('run.mjs --validate-output');
  const validation = workflow.indexOf('node apps/web/e2e/activity-visible-count/run.mjs --validate-failure-summary');
  const upload = workflow.indexOf('name: Retain only the sanitized failure summary');
  assert.ok(resultValidation >= 0 && validation > resultValidation && upload > validation);
  assert.match(workflow, /steps\.validate-result\.outputs\.failure_summary_required == 'true'/);
  const uploadBlock = workflow.slice(upload, workflow.indexOf('      - name:', upload + 1));
  assert.match(uploadBlock, /steps\.validate-failure-summary\.outputs\.valid == 'true'/);
  assert.match(uploadBlock, /path: \$\{\{ steps\.allocate-output\.outputs\.artifact_root \}\}\/failure-summary\.json/);
  assert.match(uploadBlock, /if-no-files-found: error/);
  assert.doesNotMatch(uploadBlock, /browser\.stderr\.raw|browser\.stdout\.raw|private_root/);
  assert.doesNotMatch(uploadBlock, /^\s*path:\s*\$\{\{\s*steps\.allocate-output\.outputs\.artifact_root\s*\}\}\s*$/m);
  assert.match(runner, /currentHead !== candidateSha/);
  assert.ok(runner.indexOf('currentHead !== candidateSha') < runner.indexOf('await validateFailureSummaryFiles'));
  assert.match(runner, /result\.status !== 'FAIL'/);
  assert.match(runner, /process\.exitCode = 1/);
});

test('failure-summary validation binds output to the exact current checkout and component', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'activity-failure-current-source-'));
  const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const originalEnv = Object.fromEntries([
    'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'ACTIVITY_COUNT_CANDIDATE_SHA',
    'RUNNER_TEMP', 'GITHUB_WORKSPACE', 'ACTIVITY_COUNT_OUTPUT_ROOT',
  ].map((key) => [key, process.env[key]]));
  try {
    const identity = { runId: '41471512074', runAttempt: 2, candidateSha: currentHead };
    const artifactRoot = path.join(temp, 'activity-visible-count-artifacts', identity.runId, String(identity.runAttempt), identity.candidateSha);
    await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
    const result = failedResult(identity);
    await writeFile(path.join(artifactRoot, 'result.json'), `${JSON.stringify(result)}\n`, { mode: 0o600, flag: 'wx' });
    const summary = summaryFor(startedProcess(), sanitizeStderr(Buffer.from('unknown but private text')), identity);
    await publishFailureSummary(artifactRoot, summary, { binding: identity, allowedReasons: reasons, expectedResult: result });
    process.env.GITHUB_RUN_ID = identity.runId;
    process.env.GITHUB_RUN_ATTEMPT = String(identity.runAttempt);
    process.env.ACTIVITY_COUNT_CANDIDATE_SHA = identity.candidateSha;
    process.env.RUNNER_TEMP = temp;
    process.env.GITHUB_WORKSPACE = repositoryDirectory;
    process.env.ACTIVITY_COUNT_OUTPUT_ROOT = artifactRoot;
    await driver.validateFailureSummaryOutput();

    const staleIdentity = { ...identity, candidateSha: 'b'.repeat(40) };
    const staleRoot = path.join(temp, 'activity-visible-count-artifacts', staleIdentity.runId, String(staleIdentity.runAttempt), staleIdentity.candidateSha);
    await mkdir(staleRoot, { recursive: true, mode: 0o700 });
    const staleResult = failedResult(staleIdentity);
    await writeFile(path.join(staleRoot, 'result.json'), `${JSON.stringify(staleResult)}\n`, { mode: 0o600, flag: 'wx' });
    await publishFailureSummary(staleRoot, summaryFor(startedProcess(), sanitizeStderr(Buffer.alloc(0)), staleIdentity), {
      binding: staleIdentity, allowedReasons: reasons, expectedResult: staleResult,
    });
    process.env.ACTIVITY_COUNT_CANDIDATE_SHA = staleIdentity.candidateSha;
    process.env.ACTIVITY_COUNT_OUTPUT_ROOT = staleRoot;
    await assert.rejects(driver.validateFailureSummaryOutput(), (error) => error.failureReason === 'CANDIDATE_HEAD_MISMATCH');
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(temp, { recursive: true, force: true });
  }
});
