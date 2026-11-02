import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  MAX_DIAGNOSTIC_LINE_BYTES,
  MAX_DIAGNOSTIC_LINES,
  MAX_DIAGNOSTIC_TOTAL_BYTES,
  MAX_STDERR_BYTES,
  STDERR_REDACTION_MARKER,
  sanitizeStderr,
} from './sanitize-browser-stderr.mjs';

const command = fileURLToPath(new URL('./sanitize-browser-stderr.mjs', import.meta.url));

function runCli(input, args = []) {
  return spawnSync(process.execPath, [command, ...args], {
    input,
    encoding: null,
    timeout: 5000,
    maxBuffer: 16 * 1024,
  });
}

function parseOneJsonLine(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.stderr.length, 0);
  const stdout = result.stdout.toString('utf8');
  assert.ok(Buffer.byteLength(stdout, 'utf8') <= MAX_DIAGNOSTIC_TOTAL_BYTES + 1024);
  assert.match(stdout, /^\{[^\n]*\}\n$/);
  return JSON.parse(stdout);
}

test('keeps only the three safe phrases and redacts surrounding/private data', () => {
  const input = Buffer.from([
    'browser INFO No usable sandbox! at /home/private/profile',
    "DevToolsActivePort file doesn't exist url=https://user:pass@example.invalid/path",
    'Missing X server or $DISPLAY email=person@example.invalid token=secret-value',
    'quoted "private words" \u001b[31mred\u001b[0m \u202ehidden',
  ].join('\n'));
  const diagnostics = sanitizeStderr(input);
  const json = JSON.stringify(diagnostics);

  assert.deepEqual(diagnostics.stderrCategories, ['STDERR_WITHHELD']);
  assert.deepEqual(diagnostics.stderrLines, [
    '[REDACTED] No usable sandbox! [REDACTED]',
    "DevToolsActivePort file doesn't exist [REDACTED]",
    'Missing X server or $DISPLAY [REDACTED]',
    '[REDACTED]',
  ]);
  assert.equal(diagnostics.stderrStatus, 'WITHHELD');
  assert.equal(diagnostics.stderrRedacted, true);
  for (const secret of ['/home/private', 'https://', 'user:pass', 'person@example.invalid', 'secret-value', 'hidden', 'red']) {
    assert.equal(json.includes(secret), false, 'serialized output must not contain private input');
  }
});

test('classifies exact approved phrases without claiming withheld text is classified', () => {
  const diagnostics = sanitizeStderr(Buffer.from("DevToolsActivePort file doesn't exist\n"));
  assert.deepEqual(diagnostics.stderrCategories, ['BROWSER_STARTUP_FAILURE']);
  assert.deepEqual(diagnostics.stderrLines, ["DevToolsActivePort file doesn't exist"]);
  assert.equal(diagnostics.stderrStatus, 'CLASSIFIED');
  assert.equal(diagnostics.stderrRedacted, false);
  assert.equal(diagnostics.stderrTruncated, false);
});

test('bounds lines, each UTF-8 line, and total output while preserving truncation', () => {
  const tooManyLines = sanitizeStderr(Buffer.from(('No usable sandbox!\n').repeat(MAX_DIAGNOSTIC_LINES + 2)));
  assert.equal(tooManyLines.stderrLines.length, MAX_DIAGNOSTIC_LINES);
  assert.equal(tooManyLines.stderrTruncated, true);
  assert.equal(tooManyLines.stderrStatus, 'TRUNCATED');

  const longLine = sanitizeStderr(Buffer.from(('No usable sandbox! ').repeat(80)));
  assert.ok(longLine.stderrLines.every((line) => Buffer.byteLength(line, 'utf8') <= MAX_DIAGNOSTIC_LINE_BYTES));
  assert.ok(longLine.stderrLines.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8'), 0) <= MAX_DIAGNOSTIC_TOTAL_BYTES);
  assert.equal(longLine.stderrTruncated, true);
});

test('withholds malformed UTF-8 and represents empty input safely', () => {
  const malformed = sanitizeStderr(Buffer.from([0x4e, 0x6f, 0x20, 0xc3, 0x28]));
  assert.deepEqual(malformed.stderrCategories, ['UNKNOWN']);
  assert.deepEqual(malformed.stderrLines, [STDERR_REDACTION_MARKER]);
  assert.equal(malformed.stderrStatus, 'WITHHELD');
  assert.equal(malformed.stderrRedacted, true);

  const empty = sanitizeStderr(Buffer.alloc(0));
  assert.deepEqual(empty, {
    stderrCategories: ['UNKNOWN'],
    stderrLines: [],
    stderrTruncated: false,
    stderrRedacted: false,
    stderrStatus: 'EMPTY',
  });
});

test('CLI reads stdin and emits exactly one bounded JSON diagnostics line', () => {
  const result = runCli(Buffer.from('No usable sandbox!\n'));
  assert.equal(result.status, 0);
  const diagnostics = parseOneJsonLine(result);
  assert.deepEqual(diagnostics.stderrCategories, ['BROWSER_SANDBOX_UNAVAILABLE']);
  assert.deepEqual(diagnostics.stderrLines, ['No usable sandbox!']);

  const empty = runCli(Buffer.alloc(0));
  assert.equal(empty.status, 0);
  assert.equal(parseOneJsonLine(empty).stderrStatus, 'EMPTY');

  const overflow = runCli(Buffer.concat([
    Buffer.from('No usable sandbox!\n'),
    Buffer.alloc(MAX_STDERR_BYTES + 100, 0x78),
    Buffer.from('private-overflow-marker'),
  ]));
  assert.equal(overflow.status, 0);
  const overflowDiagnostics = parseOneJsonLine(overflow);
  assert.equal(overflowDiagnostics.stderrTruncated, true);
  assert.equal(overflowDiagnostics.stderrStatus, 'TRUNCATED');
  assert.equal(overflow.stdout.includes(Buffer.from('private-overflow-marker')), false);
});

test('CLI stdin boundary leaves exactly capped input untruncated when EOF follows', () => {
  const prefix = Buffer.from('No usable sandbox!\n');
  const exactLimit = Buffer.concat([
    prefix,
    Buffer.alloc(MAX_STDERR_BYTES - prefix.length, 0x78),
  ]);
  assert.equal(exactLimit.length, MAX_STDERR_BYTES);

  const result = runCli(exactLimit);
  assert.equal(result.status, 0);
  const diagnostics = parseOneJsonLine(result);
  assert.equal(diagnostics.stderrTruncated, false);
  assert.equal(diagnostics.stderrStatus, 'WITHHELD');
  assert.equal(diagnostics.stderrLines.length, 2);
});

test('CLI closes stdin and exits after the first overflow byte without waiting for EOF', async (t) => {
  const child = spawn(process.execPath, [command], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdin.on('error', () => {});

  let closed = false;
  const closeResult = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      closed = true;
      resolve({ code, signal });
    });
  });
  t.after(() => {
    if (!closed) child.kill('SIGKILL');
  });

  child.stdin.write(Buffer.concat([
    Buffer.from('No usable sandbox!\n'),
    Buffer.alloc(MAX_STDERR_BYTES + 1, 0x78),
    Buffer.from(' private-after-overflow-marker'),
  ]));

  let timeout;
  const outcome = await Promise.race([
    closeResult.then((result) => ({ kind: 'closed', ...result })),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve({ kind: 'timeout' }), 2000);
    }),
  ]);
  clearTimeout(timeout);
  if (outcome.kind === 'timeout') {
    child.kill('SIGKILL');
    await closeResult;
    assert.fail('CLI did not exit while stdin remained open after overflow');
  }

  assert.equal(outcome.code, 0);
  assert.equal(outcome.signal, null);
  assert.equal(child.stdin.writableEnded, false, 'the test must not send EOF');
  assert.equal(Buffer.concat(stderr).length, 0);
  const output = Buffer.concat(stdout);
  assert.ok(output.length <= MAX_DIAGNOSTIC_TOTAL_BYTES + 1024);
  assert.equal(output.includes(Buffer.from('private-after-overflow-marker')), false);
  assert.match(output.toString('utf8'), /^\{[^\n]*\}\n$/);
  const diagnostics = JSON.parse(output.toString('utf8'));
  assert.equal(diagnostics.stderrTruncated, true);
  assert.equal(diagnostics.stderrStatus, 'TRUNCATED');
});

test('CLI rejects arguments with a fixed safe JSON error and supports static help', () => {
  const invalid = runCli(Buffer.from('private argument payload'), ['--output', '/private/path']);
  assert.equal(invalid.status, 2);
  const error = parseOneJsonLine(invalid);
  assert.equal(error.error, 'INVALID_ARGUMENTS');
  assert.equal(invalid.stdout.includes(Buffer.from('/private/path')), false);
  assert.equal(invalid.stdout.includes(Buffer.from('private argument payload')), false);

  const help = runCli(Buffer.alloc(0), ['--help']);
  assert.equal(help.status, 0);
  assert.equal(help.stdout.toString('utf8'), 'Usage: node sanitize-browser-stderr.mjs [--help] < stderr-bytes\n');
  assert.equal(help.stderr.length, 0);
});
