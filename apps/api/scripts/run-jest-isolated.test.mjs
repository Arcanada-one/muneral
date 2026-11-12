import test from 'node:test';
import assert from 'node:assert/strict';
import { assertEnoughTestFiles, mergeJestReports, parseListTests } from './jest-list-tests.mjs';

const files = ['/repo/apps/api/src/a.spec.ts', '/repo/apps/api/test/b.spec.ts'];

test('plain listTests output: one path per line', () => {
  assert.deepEqual(parseListTests(`${files.join('\n')}\n`), files);
});

test('--json listTests output: ONE line holding a JSON array (the MUN-JEST defect)', () => {
  assert.deepEqual(parseListTests(`${JSON.stringify(files)}\n`), files);
});

test('malformed or non-string JSON array is an error, never a bogus path', () => {
  assert.throws(() => parseListTests('["/a.spec.ts", '));
  assert.throws(() => parseListTests('[1, 2]'));
});

test('zero test files fails closed', () => {
  assert.throws(() => assertEnoughTestFiles(parseListTests('')), /0 found/);
  assert.throws(() => assertEnoughTestFiles(parseListTests('[]')), /0 found/);
  assert.throws(() => assertEnoughTestFiles(files, 3), /expected at least 3/);
  assert.doesNotThrow(() => assertEnoughTestFiles(files, 2));
  // a minimum below 1 can never switch the zero check off
  assert.throws(() => assertEnoughTestFiles([], 0), /0 found/);
});

test('per-file reports merge into one aggregate', () => {
  const a = { numTotalTests: 2, numFailedTests: 0, success: true, startTime: 20, testResults: [{ name: 'a' }], snapshot: { added: 1 } };
  const b = { numTotalTests: 3, numFailedTests: 1, success: false, startTime: 10, testResults: [{ name: 'b' }], snapshot: { added: 2 } };
  const merged = mergeJestReports([a, b]);
  assert.equal(merged.numTotalTests, 5);
  assert.equal(merged.numFailedTests, 1);
  assert.equal(merged.success, false);
  assert.equal(merged.startTime, 10);
  assert.deepEqual(merged.testResults.map((r) => r.name), ['a', 'b']);
  assert.equal(merged.snapshot.added, 3);
});
