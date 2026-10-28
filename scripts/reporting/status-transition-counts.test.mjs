import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildReport, readBounded } from './status-transition-counts.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const taskA = '11111111-1111-4111-8111-111111111111';
const taskB = '22222222-2222-4222-8222-222222222222';
const evidenceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const base = {
  schemaVersion: 1,
  scope: {
    taskIds: [taskA],
    startInclusiveUtc: '2026-10-27T23:30:00Z',
    endExclusiveUtc: '2026-10-28T01:00:00Z',
  },
  completeness: { state: 'complete', evidenceId },
  events: [],
};

function transition(id, taskId, createdAt, from = 'todo', to = 'in_progress', extra = {}) {
  return { id, taskId, action: 'task:status_changed', createdAt, from, to, ...extra };
}

function eventId(number) {
  return `aaaaaaaa-aaaa-4aaa-8aaa-${String(number).padStart(12, '0')}`;
}

test('counts transition actions only; comments and updatedAt snapshots are not transitions', () => {
  const report = buildReport({
    ...base,
    events: [
      transition(eventId(1), taskA, '2026-10-27T23:30:00Z', 'todo', 'in_progress', {
        payload: { description: 'PRIVATE FREE TEXT MUST NOT APPEAR' },
        updatedAt: '2026-10-28T00:20:00Z',
      }),
      { id: eventId(2), taskId: taskA, action: 'task:comment_added', createdAt: '2026-10-28T00:20:00Z', text: 'PRIVATE COMMENT' },
      { id: eventId(3), taskId: taskA, action: 'task:updated', createdAt: '2026-10-28T00:25:00Z', updatedAt: '2026-10-28T00:25:00Z' },
    ],
  });
  assert.equal(report.transitions.verdict, 'MEASURED');
  assert.equal(report.transitions.observedTotal, 1);
  assert.deepEqual(report.transitions.dailyCounts, [
    { dateUtc: '2026-10-27', count: 1 },
    { dateUtc: '2026-10-28', count: 0 },
  ]);
});

test('counts the UTC start boundary and excludes the end boundary across UTC dates', () => {
  const report = buildReport({
    ...base,
    events: [
      transition(eventId(1), taskA, '2026-10-27T23:30:00Z'),
      transition(eventId(2), taskA, '2026-10-28T00:00:00Z', 'in_progress', 'review'),
      transition(eventId(3), taskA, '2026-10-28T00:59:59.999Z', 'review', 'done'),
      transition(eventId(4), taskA, '2026-10-28T01:00:00Z', 'done', 'archived'),
    ],
  });
  assert.equal(report.transitions.observedTotal, 3);
  assert.deepEqual(report.transitions.dailyCounts, [
    { dateUtc: '2026-10-27', count: 1 },
    { dateUtc: '2026-10-28', count: 2 },
  ]);
});

test('excludes valid transition events outside the explicit cohort', () => {
  const report = buildReport({
    ...base,
    events: [transition(eventId(1), taskB, '2026-10-28T00:10:00Z')],
  });
  assert.equal(report.scope.cohortTaskCount, 1);
  assert.equal(report.transitions.observedTotal, 0);
});

test('deduplicates exact stable identities once, including sanitized from/to values', () => {
  const row = transition(eventId(1), taskA, '2026-10-28T00:10:00Z', 'todo', 'in_progress');
  const report = buildReport({ ...base, events: [row, { ...row, payload: { ignored: true } }] });
  assert.equal(report.transitions.observedTotal, 1);
});

test('fails closed when a duplicate ID changes any sanitized identity/value field', async (t) => {
  const original = transition(eventId(1), taskA, '2026-10-28T00:10:00Z');
  const variants = [
    { ...original, taskId: taskB },
    { ...original, action: 'task:comment_added' },
    { ...original, createdAt: '2026-10-28T00:11:00Z' },
    { ...original, from: 'review', to: 'done' },
    { ...original, to: 'review' },
  ];
  for (const variant of variants) {
    await t.test(JSON.stringify({ taskId: variant.taskId, action: variant.action, createdAt: variant.createdAt, from: variant.from, to: variant.to }), () => {
      assert.throws(
        () => buildReport({ ...base, events: [original, variant] }),
        (error) => error.code === 'INPUT_INVALID' && !error.message.includes(variant.to),
      );
    });
  }
});

test('rejects malformed IDs, non-UTC/invalid timestamps, missing or invalid transition states, and equal states', () => {
  const valid = transition(eventId(1), taskA, '2026-10-28T00:10:00Z');
  const malformed = [
    { ...valid, id: 'not-a-uuid' },
    { ...valid, createdAt: '2026-10-28T00:10:00+00:00' },
    { ...valid, createdAt: '2026-02-30T00:10:00Z' },
    { ...valid, from: undefined },
    { ...valid, to: 'unknown_status' },
    { ...valid, to: 'todo' },
  ];
  for (const row of malformed) {
    assert.throws(() => buildReport({ ...base, events: [row] }), (error) => error.code === 'INPUT_INVALID');
  }
});

test('distinguishes explicit complete zero from incomplete input and never calls incomplete zero measured', () => {
  const complete = buildReport({ ...base, events: [] });
  const incomplete = buildReport({ ...base, completeness: { state: 'incomplete', evidenceId }, events: [] });
  assert.equal(complete.transitions.verdict, 'MEASURED');
  assert.equal(complete.transitions.observedTotal, 0);
  assert.deepEqual(complete.transitions.dailyCounts, [
    { dateUtc: '2026-10-27', count: 0 },
    { dateUtc: '2026-10-28', count: 0 },
  ]);
  assert.equal(incomplete.transitions.verdict, 'NOT_MEASURED');
  assert.equal(incomplete.transitions.observedTotal, 0);
  assert.deepEqual(incomplete.transitions.dailyCounts, []);
  assert.equal(incomplete.rates.verdict, 'NOT_MEASURED');
  assert.equal(incomplete.comparability.verdict, 'NOT_MEASURED');
});

test('reports incomplete observed days without representing absent days as zero', () => {
  const report = buildReport({
    ...base,
    completeness: { state: 'incomplete', evidenceId },
    events: [transition(eventId(1), taskA, '2026-10-27T23:45:00Z')],
  });
  assert.equal(report.transitions.verdict, 'NOT_MEASURED');
  assert.deepEqual(report.transitions.dailyCounts, [{ dateUtc: '2026-10-27', count: 1 }]);
  assert.match(report.transitions.dailyCountsMeaning, /absent dates are not zero/);
});

test('emits only allowlisted fields and no supplied free text or unknown payloads', () => {
  const secret = 'PRIVATE FREE TEXT SHOULD NEVER LEAK';
  const report = buildReport({
    ...base,
    events: [transition(eventId(1), taskA, '2026-10-28T00:10:00Z', 'todo', 'in_progress', {
      description: secret,
      payload: { body: secret, unexpected: { nested: secret } },
      actorName: secret,
    })],
  });
  const output = JSON.stringify(report);
  assert.equal(output.includes(secret), false);
  assert.deepEqual(Object.keys(report), [
    'schemaVersion', 'scope', 'inputCompleteness', 'transitions', 'rates', 'comparability',
  ]);
});

test('requires explicit completeness evidence and a unique canonical cohort with a strict UTC window', () => {
  const invalidInputs = [
    { ...base, completeness: undefined },
    { ...base, completeness: { state: 'complete' } },
    { ...base, scope: { ...base.scope, taskIds: [taskA, taskA] } },
    { ...base, scope: { ...base.scope, startInclusiveUtc: '2026-10-27T23:30:00+00:00' } },
    { ...base, scope: { ...base.scope, endExclusiveUtc: '2026-10-27T23:30:00Z' } },
  ];
  for (const input of invalidInputs) {
    assert.throws(() => buildReport(input), (error) => error.code === 'INPUT_INVALID');
  }
});

test('bounded reader accepts valid input exactly at its byte limit', async () => {
  const source = Buffer.from(JSON.stringify(base));
  const readable = Readable.from([
    source.subarray(0, 4),
    source.subarray(4, 8),
    source.subarray(8),
  ]);
  const result = await readBounded(readable, source.length);
  assert.deepEqual(result, source);
  const report = buildReport(JSON.parse(result.toString('utf8')));
  assert.equal(report.transitions.verdict, 'MEASURED');
  assert.equal(report.transitions.observedTotal, 0);
});

test('bounded reader rejects the first over-limit chunk and stops consuming input', async () => {
  let advancedPastOverflow = false;
  async function* chunks() {
    yield Buffer.from('12345');
    yield Buffer.from('678');
    advancedPastOverflow = true;
    yield Buffer.from('later input');
  }

  await assert.rejects(readBounded(chunks(), 6), (error) => error.code === 'INPUT_TOO_LARGE');
  assert.equal(advancedPastOverflow, false);
});

test('CLI reads the checked-in synthetic sanitized fixture and emits valid JSON', () => {
  const cli = path.join(here, 'status-transition-counts.mjs');
  const fixture = path.join(here, 'fixtures', 'complete-one-transition.json');
  const result = spawnSync(process.execPath, [cli, fixture], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.transitions.verdict, 'MEASURED');
  assert.equal(report.transitions.observedTotal, 1);
  assert.deepEqual(report.transitions.dailyCounts, [
    { dateUtc: '2026-10-27', count: 0 },
    { dateUtc: '2026-10-28', count: 1 },
  ]);
});
