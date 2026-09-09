import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGGREGATE_SQL,
  collectSemanticAggregate,
  safeErrorCode,
} from './semantic-aggregate-readback.mjs';

const countFields = [
  'execution_state_count',
  'attempt_count',
  'transition_count',
  'committed_result_ref_count',
  'outbox_event_count',
  'pending_lease_count',
  'leased_lease_count',
  'delivered_lease_count',
  'quarantined_lease_count',
  'delivery_attempt_count',
  'quarantine_evidence_count',
  'consumer_inbox_count',
];

const failureFields = [
  'transition_without_outbox_count',
  'outbox_without_lease_count',
  'delivered_without_evidence_count',
  'quarantined_without_evidence_count',
  'committed_ref_without_transition_count',
];

function aggregateRow(overrides = {}) {
  const row = Object.fromEntries(
    [...countFields, ...failureFields].map((field) => [field, '0']),
  );
  return { ...row, ...overrides };
}

function fakeClient({ readOnly = 'on', row = aggregateRow(), failAt } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      if (failAt && String(sql).includes(failAt)) {
        const error = new Error('sensitive database detail must stay hidden');
        error.code = 'XX001';
        throw error;
      }
      if (sql === 'SHOW transaction_read_only') {
        return { rows: [{ transaction_read_only: readOnly }] };
      }
      if (sql === AGGREGATE_SQL) return { rows: [row] };
      return { rows: [] };
    },
  };
}

test('runs the fixed aggregate query inside repeatable-read read-only and rolls back', async () => {
  const client = fakeClient({
    row: aggregateRow({
      transition_count: '7',
      outbox_event_count: '7',
      delivered_lease_count: '5',
    }),
  });

  const snapshot = await collectSemanticAggregate(client);

  assert.deepEqual(client.calls, [
    'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'SHOW transaction_read_only',
    AGGREGATE_SQL,
    'ROLLBACK',
  ]);
  assert.equal(snapshot.schema, 'muneral-semantic-readback-v1');
  assert.equal(snapshot.transactionReadOnly, true);
  assert.equal(snapshot.counts.transitions, 7);
  assert.equal(snapshot.counts.outboxEvents, 7);
  assert.equal(snapshot.counts.deliveredLeases, 5);
  assert.equal(snapshot.integrityFailures.total, 0);
  assert.equal(snapshot.integrityOk, true);
});

test('fails closed when PostgreSQL does not confirm a read-only transaction', async () => {
  const client = fakeClient({ readOnly: 'off' });

  await assert.rejects(
    collectSemanticAggregate(client),
    (error) => error?.code === 'READ_ONLY_REQUIRED',
  );
  assert.equal(client.calls.at(-1), 'ROLLBACK');
  assert.equal(client.calls.includes(AGGREGATE_SQL), false);
});

test('rolls back and emits only a safe code when the aggregate query fails', async () => {
  const client = fakeClient({ failAt: 'WITH semantic_counts' });

  await assert.rejects(
    collectSemanticAggregate(client),
    (error) => error?.code === 'XX001',
  );
  assert.equal(client.calls.at(-1), 'ROLLBACK');
  assert.equal(safeErrorCode({ code: 'XX001', message: 'secret' }), 'XX001');
  assert.equal(
    safeErrorCode({ code: 'READ_ONLY_REQUIRED', message: 'secret' }),
    'READ_ONLY_REQUIRED',
  );
  assert.equal(safeErrorCode({ code: 'not safe', message: 'secret' }), 'UNEXPECTED');
});

test('rejects negative, fractional, oversized, missing, and extra aggregate fields', async () => {
  for (const row of [
    aggregateRow({ attempt_count: '-1' }),
    aggregateRow({ attempt_count: '1.5' }),
    aggregateRow({ attempt_count: String(Number.MAX_SAFE_INTEGER + 1) }),
    Object.fromEntries(Object.entries(aggregateRow()).slice(1)),
    { ...aggregateRow(), unexpected: '0' },
  ]) {
    const client = fakeClient({ row });
    await assert.rejects(
      collectSemanticAggregate(client),
      (error) => error?.code === 'INVALID_AGGREGATE_ROW',
    );
    assert.equal(client.calls.at(-1), 'ROLLBACK');
  }
});

test('fixed SQL selects counts and invariants without payload or credential fields', () => {
  assert.match(AGGREGATE_SQL, /COUNT\(\*\)/);
  assert.match(AGGREGATE_SQL, /task_committed_result_refs/);
  assert.match(AGGREGATE_SQL, /task_outbox_events/);
  assert.doesNotMatch(
    AGGREGATE_SQL,
    /\bevent_payload\b|\bcommitted_result\b|\btransition_payload\b|\berror_detail\b|database_url|password/i,
  );
});
