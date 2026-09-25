// A2-366 (AEV E03.03): read-only outbox reconciliation for operators and monitors.
//
// The relay records quarantine as durable rows (quarantine_evidence, and the
// lease row moves to 'quarantined'), but until now the only reader was
// OutboxRelay.reconciliation() — an in-process method nothing calls. This
// script makes the same facts readable from outside the process: one JSON
// document on stdout, from one READ ONLY transaction.
//
//   DATABASE_URL=... node apps/api/scripts/outbox-reconcile.mjs [--fail-on-quarantine]
//
// --fail-on-quarantine exits 3 when any event is quarantined, so a cron or CI
// probe goes red instead of a poison event sitting there unseen.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const nodeRequire = createRequire(import.meta.url);

export const QUARANTINE_EXIT_CODE = 3;

export async function readReconciliation(client) {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const leases = await client.query(
      `SELECT delivery_status, COUNT(*)::int AS n
         FROM public.outbox_leases GROUP BY delivery_status ORDER BY delivery_status`,
    );
    const quarantined = await client.query(
      `SELECT outbox_event_id, delivery_ordinal, failure_count, last_error_code, quarantined_at
         FROM public.quarantine_evidence ORDER BY quarantined_at, outbox_event_id`,
    );
    const inbox = await client.query(
      `SELECT consumer_id, COUNT(*)::int AS n
         FROM public.consumer_inbox GROUP BY consumer_id ORDER BY consumer_id`,
    );
    const totals = await client.query(
      `SELECT (SELECT COUNT(*)::int FROM public.task_outbox_events) AS outbox_events,
              (SELECT COUNT(*)::int FROM public.delivery_attempt_evidence) AS delivery_attempts`,
    );
    await client.query('COMMIT');
    return {
      schema: 'OutboxReconciliation/v1',
      captured_at_utc: new Date().toISOString(),
      outbox_events_total: totals.rows[0].outbox_events,
      delivery_attempts_total: totals.rows[0].delivery_attempts,
      lease_status_counts: Object.fromEntries(
        leases.rows.map((r) => [r.delivery_status, r.n]),
      ),
      quarantined_count: quarantined.rows.length,
      quarantined: quarantined.rows.map((r) => ({
        outbox_event_id: r.outbox_event_id,
        delivery_ordinal: Number(r.delivery_ordinal),
        failure_count: Number(r.failure_count),
        last_error_code: r.last_error_code,
        quarantined_at: new Date(r.quarantined_at).toISOString(),
      })),
      inbox_by_consumer: Object.fromEntries(inbox.rows.map((r) => [r.consumer_id, r.n])),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function main(argv) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write('outbox-reconcile: DATABASE_URL is not set\n');
    return 2;
  }
  const { Client } = nodeRequire('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const snapshot = await readReconciliation(client);
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    if (argv.includes('--fail-on-quarantine') && snapshot.quarantined_count > 0) {
      return QUARANTINE_EXIT_CODE;
    }
    return 0;
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`outbox-reconcile: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
