// A2-382 (AEV E03.03): read-only probe for switching the outbox relay on.
//
// OUTBOX_RELAY_ENABLED=true makes the relay deliver every pending outbox event
// to the work-outcome-ledger consumer, which writes one work_outcome_records row
// per outcome event (task:completed / task:failed / task:terminal_failed /
// task:cancelled). This script answers, from outside the process, the questions
// docs/how-to/enable-outbox-relay.md asks before and after the switch:
//
//   - how many outbox events sit in each delivery status, per event type;
//   - how many outcome transitions happened (task_execution_transitions — the
//     authority's own record, not the outbox), how many outcome events were
//     delivered, and how many ledger rows exist, in the same window;
//   - whether any invariant is breached (duplicates, rows without a delivered
//     event, rows on a non-terminal transition, quarantine, ...).
//
// One JSON document on stdout, from one REPEATABLE READ READ ONLY transaction in
// a session opened with default_transaction_read_only=on: it cannot write.
//
//   DATABASE_URL=... node apps/api/scripts/outbox-relay-probe.mjs \
//     [--since <ISO-8601>] [--fail-on-breach]
//
// --since limits the outcome/ledger comparison to events recorded at or after
// that instant (the switch-on time); breaches are always checked globally.
// --fail-on-breach exits 3 when any breach count is non-zero.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const nodeRequire = createRequire(import.meta.url);

export const BREACH_EXIT_CODE = 3;
export const LEDGER_CONSUMER_ID = 'work-outcome-ledger';
export const OUTCOME_EVENT_TYPES = Object.freeze([
  'task:completed',
  'task:failed',
  'task:terminal_failed',
  'task:cancelled',
]);
// deriveOutboxEventType (src/outbox/outbox.types.ts): these transition types,
// and only these, produce an outcome event.
export const TERMINAL_TRANSITION_TYPES = Object.freeze([
  'attempt:succeeded',
  'attempt:failed',
  'attempt:cancelled',
]);

const BREACH_SQL = `SELECT
  (SELECT COUNT(*) FROM (
     SELECT outbox_event_id FROM public.work_outcome_records
      GROUP BY outbox_event_id HAVING COUNT(*) > 1) d)::int
    AS duplicate_ledger_events,
  (SELECT COUNT(*) FROM public.work_outcome_records r
     LEFT JOIN public.outbox_leases l ON l.outbox_event_id = r.outbox_event_id
    WHERE l.delivery_status IS DISTINCT FROM 'delivered')::int
    AS ledger_rows_without_delivered_event,
  (SELECT COUNT(*) FROM public.work_outcome_records r
     JOIN public.task_outbox_events e ON e.id = r.outbox_event_id
    WHERE e.event_type <> r.event_type)::int
    AS ledger_rows_with_mismatched_event_type,
  (SELECT COUNT(*) FROM public.work_outcome_records r
     JOIN public.task_outbox_events e ON e.id = r.outbox_event_id
     JOIN public.task_execution_transitions t ON t.id = e.transition_id
    WHERE t.event_type <> ALL($2::text[]))::int
    AS ledger_rows_on_non_terminal_transition,
  (SELECT COUNT(*) FROM public.task_outbox_events e
     JOIN public.outbox_leases l ON l.outbox_event_id = e.id
    WHERE l.delivery_status = 'delivered' AND e.event_type = ANY($1::text[])
      AND NOT EXISTS (SELECT 1 FROM public.work_outcome_records r WHERE r.outbox_event_id = e.id))::int
    AS delivered_outcome_events_without_ledger_row,
  (SELECT COUNT(*) FROM public.outbox_leases l
    WHERE l.delivery_status = 'delivered'
      AND NOT EXISTS (SELECT 1 FROM public.consumer_inbox i
                       WHERE i.outbox_event_id = l.outbox_event_id AND i.consumer_id = $3))::int
    AS delivered_events_without_inbox_row,
  (SELECT COUNT(*) FROM public.outbox_leases WHERE delivery_status = 'quarantined')::int
    AS quarantined_events`;

const WINDOW_SQL = `SELECT
  (SELECT COUNT(*) FROM public.task_execution_transitions
    WHERE event_type = ANY($2::text[]) AND recorded_at >= $3)::int AS terminal_transitions,
  (SELECT COUNT(*) FROM public.task_outbox_events
    WHERE event_type = ANY($1::text[]) AND recorded_at >= $3)::int AS outcome_events,
  (SELECT COUNT(*) FROM public.task_outbox_events e
     JOIN public.outbox_leases l ON l.outbox_event_id = e.id
    WHERE e.event_type = ANY($1::text[]) AND e.recorded_at >= $3
      AND l.delivery_status = 'delivered')::int AS outcome_events_delivered,
  (SELECT COUNT(*) FROM public.work_outcome_records
    WHERE outcome_recorded_at >= $3)::int AS ledger_rows,
  (SELECT COUNT(DISTINCT outbox_event_id) FROM public.work_outcome_records
    WHERE outcome_recorded_at >= $3)::int AS ledger_distinct_events`;

export async function readRelayProbe(client, { since = null } = {}) {
  const sinceTs = since ?? new Date(0).toISOString();
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const ro = await client.query('SHOW transaction_read_only');
    const now = await client.query('SELECT now() AS now');
    const byTypeStatus = await client.query(
      `SELECT e.event_type, COALESCE(l.delivery_status, '<no lease>') AS status, COUNT(*)::int AS n
         FROM public.task_outbox_events e
         LEFT JOIN public.outbox_leases l ON l.outbox_event_id = e.id
        GROUP BY 1, 2 ORDER BY 1, 2`,
    );
    const attempts = await client.query(
      `SELECT disposition, COUNT(*)::int AS n FROM public.delivery_attempt_evidence
        GROUP BY 1 ORDER BY 1`,
    );
    const inbox = await client.query(
      `SELECT COUNT(*)::int AS n FROM public.consumer_inbox WHERE consumer_id = $1`,
      [LEDGER_CONSUMER_ID],
    );
    const retrying = await client.query(
      `SELECT COUNT(*)::int AS n FROM public.outbox_leases
        WHERE failure_count > 0 AND delivery_status IN ('pending', 'leased')`,
    );
    const windowed = await client.query(WINDOW_SQL, [
      OUTCOME_EVENT_TYPES, TERMINAL_TRANSITION_TYPES, sinceTs,
    ]);
    const breaches = await client.query(BREACH_SQL, [
      OUTCOME_EVENT_TYPES, TERMINAL_TRANSITION_TYPES, LEDGER_CONSUMER_ID,
    ]);
    await client.query('COMMIT');

    const statusCounts = {};
    const typeStatus = {};
    let total = 0;
    for (const r of byTypeStatus.rows) {
      statusCounts[r.status] = (statusCounts[r.status] ?? 0) + r.n;
      (typeStatus[r.event_type] ??= {})[r.status] = r.n;
      total += r.n;
    }
    const w = windowed.rows[0];
    const b = { ...breaches.rows[0] };
    // Within the window a ledger row can only come from a terminal transition;
    // more rows than such transitions means an effect was applied twice or
    // attributed to the wrong event.
    b.ledger_rows_exceed_terminal_transitions = Math.max(0, w.ledger_rows - w.terminal_transitions);
    const breached = Object.entries(b).filter(([, n]) => n > 0).map(([k]) => k);

    return {
      schema: 'OutboxRelayProbe/v1',
      captured_at_utc: new Date().toISOString(),
      db_now: new Date(now.rows[0].now).toISOString(),
      transaction_read_only: ro.rows[0].transaction_read_only,
      window_since: since,
      outbox_events_total: total,
      lease_status_counts: statusCounts,
      by_event_type: typeStatus,
      delivery_attempts_by_disposition: Object.fromEntries(attempts.rows.map((r) => [r.disposition, r.n])),
      retrying_events: retrying.rows[0].n,
      ledger_inbox_rows: inbox.rows[0].n,
      window: {
        terminal_transitions: w.terminal_transitions,
        outcome_events: w.outcome_events,
        outcome_events_delivered: w.outcome_events_delivered,
        outcome_events_pending: w.outcome_events - w.outcome_events_delivered,
        ledger_rows: w.ledger_rows,
        ledger_distinct_events: w.ledger_distinct_events,
        // drained = every outcome event of the window has exactly its one row.
        drained: w.outcome_events === w.ledger_rows && w.ledger_rows === w.terminal_transitions,
      },
      breaches: b,
      verdict: breached.length === 0 ? 'clean' : 'breach',
      breached,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

export function parseArgs(argv) {
  const out = { since: null, failOnBreach: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fail-on-breach') out.failOnBreach = true;
    else if (argv[i] === '--since') {
      const v = argv[++i];
      if (!v || Number.isNaN(Date.parse(v))) throw new Error('--since needs an ISO-8601 instant');
      out.since = new Date(v).toISOString();
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}

async function main(argv) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write('outbox-relay-probe: DATABASE_URL is not set\n');
    return 2;
  }
  const args = parseArgs(argv);
  const { Client } = nodeRequire('pg');
  const client = new Client({ connectionString: url, options: '-c default_transaction_read_only=on' });
  await client.connect();
  try {
    const probe = await readRelayProbe(client, { since: args.since });
    process.stdout.write(`${JSON.stringify(probe, null, 2)}\n`);
    return args.failOnBreach && probe.verdict !== 'clean' ? BREACH_EXIT_CODE : 0;
  } finally {
    await client.end();
  }
}

// Run as a file, or piped into a production container that does not ship
// scripts/ (`docker exec -i -w /app/apps/api <c> node --input-type=module -
// [args] < outbox-relay-probe.mjs`): then argv[1] is '-' and `pg` resolves from
// the working directory.
if (process.argv[1] === '-' || import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`outbox-relay-probe: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
