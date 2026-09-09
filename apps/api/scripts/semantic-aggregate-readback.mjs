import { pathToFileURL } from 'node:url';

const BEGIN_READ_ONLY =
  'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY';

const COUNT_FIELDS = Object.freeze({
  execution_state_count: 'executionStates',
  attempt_count: 'attempts',
  transition_count: 'transitions',
  committed_result_ref_count: 'committedResultRefs',
  outbox_event_count: 'outboxEvents',
  pending_lease_count: 'pendingLeases',
  leased_lease_count: 'leasedLeases',
  delivered_lease_count: 'deliveredLeases',
  quarantined_lease_count: 'quarantinedLeases',
  delivery_attempt_count: 'deliveryAttempts',
  quarantine_evidence_count: 'quarantineEvidence',
  consumer_inbox_count: 'consumerInbox',
});

const FAILURE_FIELDS = Object.freeze({
  transition_without_outbox_count: 'transitionsWithoutOutbox',
  outbox_without_lease_count: 'outboxEventsWithoutLease',
  delivered_without_evidence_count: 'deliveredWithoutEvidence',
  quarantined_without_evidence_count: 'quarantinedWithoutEvidence',
  committed_ref_without_transition_count: 'committedRefsWithoutTransition',
});

export const AGGREGATE_SQL = `WITH semantic_counts AS (
  SELECT
    (SELECT COUNT(*)::bigint FROM public.task_execution_state)
      AS execution_state_count,
    (SELECT COUNT(*)::bigint FROM public.task_execution_attempts)
      AS attempt_count,
    (SELECT COUNT(*)::bigint FROM public.task_execution_transitions)
      AS transition_count,
    (SELECT COUNT(*)::bigint FROM public.task_committed_result_refs)
      AS committed_result_ref_count,
    (SELECT COUNT(*)::bigint FROM public.task_outbox_events)
      AS outbox_event_count,
    (SELECT COUNT(*)::bigint FROM public.outbox_leases
      WHERE delivery_status = 'pending') AS pending_lease_count,
    (SELECT COUNT(*)::bigint FROM public.outbox_leases
      WHERE delivery_status = 'leased') AS leased_lease_count,
    (SELECT COUNT(*)::bigint FROM public.outbox_leases
      WHERE delivery_status = 'delivered') AS delivered_lease_count,
    (SELECT COUNT(*)::bigint FROM public.outbox_leases
      WHERE delivery_status = 'quarantined') AS quarantined_lease_count,
    (SELECT COUNT(*)::bigint FROM public.delivery_attempt_evidence)
      AS delivery_attempt_count,
    (SELECT COUNT(*)::bigint FROM public.quarantine_evidence)
      AS quarantine_evidence_count,
    (SELECT COUNT(*)::bigint FROM public.consumer_inbox)
      AS consumer_inbox_count,
    (SELECT COUNT(*)::bigint
       FROM public.task_execution_transitions AS transition
       LEFT JOIN public.task_outbox_events AS event
         ON event.transition_id = transition.id
      WHERE event.id IS NULL) AS transition_without_outbox_count,
    (SELECT COUNT(*)::bigint
       FROM public.task_outbox_events AS event
       LEFT JOIN public.outbox_leases AS lease
         ON lease.outbox_event_id = event.id
      WHERE lease.outbox_event_id IS NULL) AS outbox_without_lease_count,
    (SELECT COUNT(*)::bigint
       FROM public.outbox_leases AS lease
      WHERE lease.delivery_status = 'delivered'
        AND NOT EXISTS (
          SELECT 1 FROM public.delivery_attempt_evidence AS evidence
           WHERE evidence.outbox_event_id = lease.outbox_event_id
             AND evidence.delivery_ordinal = lease.delivery_ordinal
             AND evidence.disposition = 'delivered'
        )) AS delivered_without_evidence_count,
    (SELECT COUNT(*)::bigint
       FROM public.outbox_leases AS lease
      WHERE lease.delivery_status = 'quarantined'
        AND NOT EXISTS (
          SELECT 1 FROM public.quarantine_evidence AS evidence
           WHERE evidence.outbox_event_id = lease.outbox_event_id
             AND evidence.delivery_ordinal = lease.delivery_ordinal
        )) AS quarantined_without_evidence_count,
    (SELECT COUNT(*)::bigint
       FROM public.task_committed_result_refs AS result_ref
       LEFT JOIN public.task_execution_transitions AS transition
         ON transition.id = result_ref.transition_id
        AND transition.task_id = result_ref.task_id
        AND transition.attempt_id = result_ref.attempt_id
        AND transition.aggregate_version = result_ref.aggregate_version
      WHERE transition.id IS NULL) AS committed_ref_without_transition_count
)
SELECT * FROM semantic_counts`;

function readBoundedCount(row, field) {
  const raw = row[field];
  if (!/^(0|[1-9][0-9]*)$/.test(String(raw))) {
    throw codedError('INVALID_AGGREGATE_ROW');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw codedError('INVALID_AGGREGATE_ROW');
  }
  return value;
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function parseAggregateRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw codedError('INVALID_AGGREGATE_ROW');
  }
  const expected = [...Object.keys(COUNT_FIELDS), ...Object.keys(FAILURE_FIELDS)].sort();
  const actual = Object.keys(row).sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    throw codedError('INVALID_AGGREGATE_ROW');
  }

  const counts = {};
  for (const [field, output] of Object.entries(COUNT_FIELDS)) {
    counts[output] = readBoundedCount(row, field);
  }

  const integrityFailures = {};
  let total = 0;
  for (const [field, output] of Object.entries(FAILURE_FIELDS)) {
    const value = readBoundedCount(row, field);
    integrityFailures[output] = value;
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw codedError('INVALID_AGGREGATE_ROW');
    }
  }
  integrityFailures.total = total;

  return {
    schema: 'muneral-semantic-readback-v1',
    transactionReadOnly: true,
    counts,
    integrityFailures,
    integrityOk: total === 0,
  };
}

export async function collectSemanticAggregate(client) {
  let transactionStarted = false;
  try {
    await client.query(BEGIN_READ_ONLY);
    transactionStarted = true;

    const mode = await client.query('SHOW transaction_read_only');
    if (mode?.rows?.length !== 1 || mode.rows[0]?.transaction_read_only !== 'on') {
      throw codedError('READ_ONLY_REQUIRED');
    }

    const aggregate = await client.query(AGGREGATE_SQL);
    if (aggregate?.rows?.length !== 1) {
      throw codedError('INVALID_AGGREGATE_ROW');
    }
    return parseAggregateRow(aggregate.rows[0]);
  } finally {
    if (transactionStarted) await client.query('ROLLBACK');
  }
}

export function safeErrorCode(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{5,32}$/.test(code)
    ? code
    : 'UNEXPECTED';
}

async function main() {
  if (!process.env.DATABASE_URL) throw codedError('DATABASE_URL_MISSING');

  const { Client } = await import('pg');
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    application_name: 'muneral-semantic-readback-v1',
    connectionTimeoutMillis: 10_000,
    query_timeout: 20_000,
    statement_timeout: 15_000,
  });

  try {
    await client.connect();
    const snapshot = await collectSemanticAggregate(client);
    process.stdout.write(
      `MUNERAL_AGGREGATE_READBACK_V1 ${JSON.stringify(snapshot)}\n`,
    );
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `MUNERAL_AGGREGATE_READBACK_FAIL code=${safeErrorCode(error)}\n`,
    );
    process.exitCode = 1;
  });
}
