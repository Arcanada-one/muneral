// A2-375 (AEV E03.03, AEV-AC014 on the PRODUCTION read model).
//
// A2-366 proved AC014 on a harness consumer and a harness table. This spec
// proves it on what production runs: the real WorkOutcomeLedgerConsumer (the
// consumer OutboxRelayWorker binds, A2-370) writing the real
// work_outcome_records table, read back through the one read rule for that
// ledger (src/outbox/work-outcome-ledger.reader.ts).
//
// Given: revision 4 of a task's outcome is delivered, then revision 2 arrives
// late (it was pending longer). Expected: the task's current outcome stays at
// revision 4, the late row is kept as evidence and marked late_ignored, the
// delivery itself is `delivered` (not quarantined). The state is read with
// SQL through Prisma from the table, not from a mock.
//
// Counters are printed as one `[ledger-ac014]` JSON line in afterAll.

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

import { createDisposablePostgres } from './support/disposable-postgres.js';
import { OutboxRelay } from '../src/outbox/outbox.relay.js';
import { normaliseConfig } from '../src/outbox/outbox.types.js';
import { WorkOutcomeLedgerConsumer } from '../src/outbox/work-outcome-ledger.consumer.js';
import { foldWorkOutcomes, readWorkOutcome } from '../src/outbox/work-outcome-ledger.reader.js';

const nodeRequire = createRequire(import.meta.url);

const pg = createDisposablePostgres('ledger014');
const ledgerLog: Array<Record<string, unknown>> = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
let projectId: string | null = null;
let aggregateCounter = 100;

beforeAll(async () => {
  await pg.start();
  const { PrismaClient } = nodeRequire('@prisma/client');
  const { PrismaPg } = nodeRequire('@prisma/adapter-pg');
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: pg.url() }) });
}, 120_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  console.log(`[ledger-ac014] ${JSON.stringify(ledgerLog)}`);
  await pg.stop();
}, 30_000);

const TRANSITION_FOR: Record<string, string> = {
  'task:completed': 'attempt:succeeded',
  'task:failed': 'attempt:failed', // retryCount 0 < retryBudget 3
  'task:cancelled': 'attempt:cancelled',
};

// -- seed helpers (same FK chain as outbox.relay.postgres.spec.ts) ----------

async function seedTask(): Promise<string> {
  if (!projectId) {
    const ownerId = randomUUID();
    const workspaceId = randomUUID();
    projectId = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.users (id, name, created_at, updated_at) VALUES ($1, 'ledger-user', NOW(), NOW())`,
      ownerId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.workspaces (id, slug, name, owner_id, created_at) VALUES ($1, $2, 'ledger-ws', $3, NOW())`,
      workspaceId, `ws-${randomUUID().slice(0, 6)}`, ownerId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.projects (id, workspace_id, slug, name, created_at) VALUES ($1, $2, $3, 'ledger-project', NOW())`,
      projectId, workspaceId, `prj-${randomUUID().slice(0, 6)}`,
    );
  }
  const taskId = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO public.tasks (id, project_id, title, status, created_at, updated_at)
     VALUES ($1, $2, 'ledger-ac014-task', 'todo', NOW(), NOW())`,
    taskId, projectId,
  );
  return taskId;
}

async function seedEvent(
  taskId: string,
  opts: { aggregateVersion?: number; eventType?: string; eventPayload?: Record<string, unknown> } = {},
): Promise<string> {
  const attemptId = randomUUID();
  const transitionId = randomUUID();
  const eventId = randomUUID();
  const aggregateVersion = opts.aggregateVersion ?? ++aggregateCounter;
  const attemptOrdinal = ++aggregateCounter;
  // The relay validates the outbox event type against the transition it came
  // from (deriveOutboxEventType); the fixture writes the consistent pair.
  const eventType = opts.eventType ?? 'task:completed';
  const transitionEventType = TRANSITION_FOR[eventType];
  await prisma.$executeRawUnsafe(
    `INSERT INTO public.task_execution_attempts (attempt_id, task_id, ordinal, status, issued_at)
     VALUES ($1, $2, $3, 'issued', NOW())`,
    attemptId, taskId, attemptOrdinal,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO public.task_execution_transitions
       (id, task_id, attempt_id, aggregate_version, event_type,
        idempotency_key, command_digest, causation_id, correlation_id, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'cause-ledger', 'corr-ledger', NOW())`,
    transitionId, taskId, attemptId, aggregateVersion, transitionEventType, randomUUID(),
    `sha256:${randomUUID().slice(0, 16)}`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO public.task_outbox_events
       (id, task_id, aggregate_version, attempt_id, transition_id, event_type, event_payload, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())`,
    eventId, taskId, aggregateVersion, attemptId, transitionId, eventType,
    JSON.stringify(opts.eventPayload ?? {
      schema: 'muneral-outbox-v1',
      transitionEventType,
      committedResult: { status: 'done' },
      idempotencyKey: randomUUID(),
      aggregateVersion,
      attemptId,
      attemptOrdinal,
      retryCount: 0,
      retryBudget: 3,
    }),
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO public.outbox_leases (outbox_event_id, delivery_status, delivery_ordinal, failure_count)
     VALUES ($1, 'pending', 0, 0)`,
    eventId,
  );
  return eventId;
}

function freshRelay(tag: string): OutboxRelay {
  return new OutboxRelay(
    prisma,
    { now: () => new Date() },
    { generate: () => randomUUID() },
    normaliseConfig({ relayId: `${tag}-${randomUUID().slice(0, 6)}` }),
  );
}

async function deliver(consumer: WorkOutcomeLedgerConsumer, tag: string) {
  const relay = freshRelay(tag); // each delivery by a separate relay instance
  await relay.resume();
  return relay.cycle(consumer);
}

describe('work-outcome-ledger — a late revision does not roll the task outcome back (AEV-AC014)', () => {
  it('revision 4 then revision 2: current outcome stays 4, the late row is kept and marked late_ignored', async () => {
    const consumer = new WorkOutcomeLedgerConsumer({ generate: () => randomUUID() });
    const taskId = await seedTask();

    const rev4 = await seedEvent(taskId, { aggregateVersion: 4, eventType: 'task:completed' });
    const c1 = await deliver(consumer, 'rev4');
    const afterRev4 = await readWorkOutcome(prisma, taskId);

    const rev2 = await seedEvent(taskId, { aggregateVersion: 2, eventType: 'task:failed' });
    const c2 = await deliver(consumer, 'rev2');
    const view = await readWorkOutcome(prisma, taskId);

    const quarantined = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM public.outbox_leases
        WHERE outbox_event_id = ANY($1::uuid[]) AND delivery_status <> 'delivered'`,
      [rev4, rev2],
    );
    const ledgerRows = await prisma.$queryRawUnsafe(
      `SELECT outbox_event_id::text AS id, aggregate_version::int AS v FROM public.work_outcome_records
        WHERE task_id = $1::uuid ORDER BY consumed_at`,
      taskId,
    );
    const dispositions = view.rows.map((r) => ({ id: r.outboxEventId, v: Number(r.aggregateVersion), d: r.disposition }));
    ledgerLog.push({
      case: 'AC014-ledger-late-revision', taskId, rev4, rev2,
      cycles: [c1, c2],
      currentAfterRev4: Number(afterRev4.current?.aggregateVersion),
      currentAfterRev2: Number(view.current?.aggregateVersion),
      ledgerRows, dispositions, notDelivered: quarantined[0].n,
    });

    expect(c1.delivered).toBe(1);
    expect(c2.delivered).toBe(1); // handled safely, not quarantined
    expect(quarantined[0].n).toBe(0);
    expect(ledgerRows).toEqual([{ id: rev4, v: 4 }, { id: rev2, v: 2 }]); // evidence kept, append-only
    expect(Number(afterRev4.current?.aggregateVersion)).toBe(4);
    expect(view.current?.outboxEventId).toBe(rev4);
    expect(view.current?.eventType).toBe('task:completed');
    expect(dispositions).toEqual([
      { id: rev4, v: 4, d: 'applied' },
      { id: rev2, v: 2, d: 'late_ignored' },
    ]);
  }, 60_000);

  it('in-order delivery (2 then 4) applies both and ends at 4 — the rule does not freeze state', async () => {
    const consumer = new WorkOutcomeLedgerConsumer({ generate: () => randomUUID() });
    const taskId = await seedTask();
    const rev2 = await seedEvent(taskId, { aggregateVersion: 2, eventType: 'task:failed' });
    await deliver(consumer, 'in-order-2');
    const rev4 = await seedEvent(taskId, { aggregateVersion: 4, eventType: 'task:completed' });
    await deliver(consumer, 'in-order-4');
    const view = await readWorkOutcome(prisma, taskId);
    const dispositions = view.rows.map((r) => ({ id: r.outboxEventId, d: r.disposition }));
    ledgerLog.push({ case: 'AC014-ledger-in-order', taskId, dispositions, current: Number(view.current?.aggregateVersion) });

    expect(view.current?.outboxEventId).toBe(rev4);
    expect(dispositions).toEqual([
      { id: rev2, d: 'applied' },
      { id: rev4, d: 'applied' },
    ]);
  }, 60_000);
});

describe('foldWorkOutcomes — the read rule without a database', () => {
  const row = (v: number, ms: number) => ({
    id: `r${v}`, outboxEventId: `e${v}`, taskId: 't', eventType: 'task:completed',
    aggregateVersion: BigInt(v), consumedAt: new Date(ms),
  });

  it('a tie on consumed_at never rolls back: the lower revision is the one marked late', () => {
    const view = foldWorkOutcomes('t', [row(4, 1000), row(2, 1000)]);
    expect(Number(view.current?.aggregateVersion)).toBe(4);
    expect(view.rows.map((r) => r.disposition)).toEqual(['applied', 'applied']);
  });

  it('an empty ledger has no current outcome', () => {
    expect(foldWorkOutcomes('t', []).current).toBeNull();
  });
});
