// A2-366 (AEV E03.03, acceptance AEV-AC013 / AEV-AC014): replay harness for the
// MUN-0021 outbox relay against real PostgreSQL.
//
// The side effect is a ROW in a harness table, written by the consumer inside
// the relay's transaction, and counted with SQL after every delivery — not a
// mock call count. The effect table deliberately has NO unique constraint:
// if inbox deduplication were lost, a replay would show up as a second row.
//
// A replay is what a restarted relay sees after a crash between commit and
// acknowledgement: the lease row is back to 'pending' (DELETE + INSERT, the
// forward-only trigger forbids an UPDATE rewind — same technique as test 9 of
// outbox.relay.postgres.spec.ts) and a NEW OutboxRelay instance runs cycle().
//
// The per-delivery counters are printed as one `[replay-harness]` JSON line in afterAll.

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as url from 'node:url';

import { createDisposablePostgres } from './support/disposable-postgres.js';
import { OutboxRelay } from '../src/outbox/outbox.relay.js';
import { normaliseConfig } from '../src/outbox/outbox.types.js';
import type { OutboxConsumer, OutboxEvent } from '../src/outbox/outbox.types.js';

const nodeRequire = createRequire(import.meta.url);
const thisDir = path.dirname(url.fileURLToPath(import.meta.url));
const RECONCILE_SCRIPT = path.join(thisDir, '..', 'scripts', 'outbox-reconcile.mjs');

const pg = createDisposablePostgres('replay');
const replayLog: Array<Record<string, unknown>> = [];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
let projectId: string | null = null;
let aggregateCounter = 100;

beforeAll(async () => {
  await pg.start();
  const { PrismaClient } = nodeRequire('@prisma/client');
  const { PrismaPg } = nodeRequire('@prisma/adapter-pg');
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: pg.url() }) });
  await prisma.$executeRawUnsafe(
    `CREATE TABLE replay_harness_effects (
       id bigserial PRIMARY KEY,
       consumer_id text NOT NULL,
       outbox_event_id uuid NOT NULL,
       outcome text NOT NULL
     )`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE TABLE replay_harness_read_model (
       task_id uuid PRIMARY KEY,
       revision integer NOT NULL
     )`,
  );
}, 120_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  console.log(`[replay-harness] ${JSON.stringify(replayLog)}`);
  await pg.stop();
}, 30_000);

// -- seed helpers (same FK chain as outbox.relay.postgres.spec.ts) ----------

async function seedTask(): Promise<string> {
  if (!projectId) {
    const ownerId = randomUUID();
    const workspaceId = randomUUID();
    projectId = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.users (id, name, created_at, updated_at) VALUES ($1, 'replay-user', NOW(), NOW())`,
      ownerId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.workspaces (id, slug, name, owner_id, created_at) VALUES ($1, $2, 'replay-ws', $3, NOW())`,
      workspaceId, `ws-${randomUUID().slice(0, 6)}`, ownerId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.projects (id, workspace_id, slug, name, created_at) VALUES ($1, $2, $3, 'replay-project', NOW())`,
      projectId, workspaceId, `prj-${randomUUID().slice(0, 6)}`,
    );
  }
  const taskId = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO public.tasks (id, project_id, title, status, created_at, updated_at)
     VALUES ($1, $2, 'replay-harness-task', 'todo', NOW(), NOW())`,
    taskId, projectId,
  );
  return taskId;
}

async function seedEvent(
  taskId: string,
  opts: { aggregateVersion?: number; eventPayload?: Record<string, unknown> } = {},
): Promise<string> {
  const attemptId = randomUUID();
  const transitionId = randomUUID();
  const eventId = randomUUID();
  const aggregateVersion = opts.aggregateVersion ?? ++aggregateCounter;
  const attemptOrdinal = ++aggregateCounter;
  await prisma.$executeRawUnsafe(
    `INSERT INTO public.task_execution_attempts (attempt_id, task_id, ordinal, status, issued_at)
     VALUES ($1, $2, $3, 'issued', NOW())`,
    attemptId, taskId, attemptOrdinal,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO public.task_execution_transitions
       (id, task_id, attempt_id, aggregate_version, event_type,
        idempotency_key, command_digest, causation_id, correlation_id, recorded_at)
     VALUES ($1, $2, $3, $4, 'attempt:succeeded', $5, $6, 'cause-replay', 'corr-replay', NOW())`,
    transitionId, taskId, attemptId, aggregateVersion, randomUUID(),
    `sha256:${randomUUID().slice(0, 16)}`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO public.task_outbox_events
       (id, task_id, aggregate_version, attempt_id, transition_id, event_type, event_payload, recorded_at)
     VALUES ($1, $2, $3, $4, $5, 'task:completed', $6::jsonb, NOW())`,
    eventId, taskId, aggregateVersion, attemptId, transitionId,
    JSON.stringify(opts.eventPayload ?? {
      schema: 'muneral-outbox-v1',
      transitionEventType: 'attempt:succeeded',
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

/** A restarted relay finds the event pending again (crash before ack). */
async function rewindToPending(eventId: string): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM public.outbox_leases WHERE outbox_event_id = $1`, eventId);
  await prisma.$executeRawUnsafe(
    `INSERT INTO public.outbox_leases (outbox_event_id, delivery_status, delivery_ordinal, failure_count)
     VALUES ($1, 'pending', 0, 0)`,
    eventId,
  );
}

function freshRelay(tag: string): OutboxRelay {
  return new OutboxRelay(
    prisma,
    { now: () => new Date() },
    { generate: () => randomUUID() },
    normaliseConfig({ relayId: `${tag}-${randomUUID().slice(0, 6)}` }),
  );
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
  const rows = await prisma.$queryRawUnsafe(sql, ...params);
  return Number(rows[0].n);
}

function effectConsumer(consumerId: string): OutboxConsumer & { invocations: number } {
  const consumer = {
    consumerId,
    invocations: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async consume(event: OutboxEvent, tx: any) {
      consumer.invocations++;
      await tx.$executeRawUnsafe(
        `INSERT INTO replay_harness_effects (consumer_id, outbox_event_id, outcome) VALUES ($1, $2::uuid, 'applied')`,
        consumerId, event.id,
      );
      return { digest: `sha256:effect-${event.id}` };
    },
  };
  return consumer;
}

describe('Outbox replay harness — one event, one side effect (AEV-AC013)', () => {
  it('ten deliveries of one event, each by a restarted relay, leave exactly one effect row', async () => {
    const taskId = await seedTask();
    const eventId = await seedEvent(taskId);
    const consumer = effectConsumer('evolutio-replay');
    const effectsAfterDelivery: number[] = [];
    const deliveredPerCycle: number[] = [];

    for (let delivery = 1; delivery <= 10; delivery++) {
      if (delivery > 1) await rewindToPending(eventId);
      const relay = freshRelay('replay'); // a new process after each crash
      await relay.resume();
      const result = await relay.cycle(consumer);
      deliveredPerCycle.push(result.delivered);
      effectsAfterDelivery.push(await count(
        `SELECT COUNT(*) AS n FROM replay_harness_effects WHERE outbox_event_id = $1::uuid`, eventId,
      ));
    }

    const inboxRows = await count(
      `SELECT COUNT(*) AS n FROM public.consumer_inbox WHERE outbox_event_id = $1::uuid AND consumer_id = $2`,
      eventId, consumer.consumerId,
    );
    const attemptRows = await count(
      `SELECT COUNT(*) AS n FROM public.delivery_attempt_evidence
        WHERE outbox_event_id = $1::uuid AND disposition = 'delivered'`,
      eventId,
    );
    replayLog.push({
      case: 'AC013-replay-x10', eventId, effectsAfterDelivery, deliveredPerCycle,
      consumerInvocations: consumer.invocations, inboxRows, deliveredAttemptRows: attemptRows,
    });

    expect(effectsAfterDelivery).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(deliveredPerCycle).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(consumer.invocations).toBe(1);
    expect(inboxRows).toBe(1);
    // The audit keeps every delivery attempt, not only the one that applied.
    expect(attemptRows).toBe(10);
  }, 60_000);

  it('a second consumer of the same event gets its own single effect (dedup is per consumer)', async () => {
    const taskId = await seedTask();
    const eventId = await seedEvent(taskId);
    const first = effectConsumer('evolutio-replay-a');
    const second = effectConsumer('evolutio-replay-b');
    for (const consumer of [first, second, first, second]) {
      await rewindToPending(eventId);
      const relay = freshRelay('per-consumer');
      await relay.resume();
      await relay.cycle(consumer);
    }
    const perConsumer = await prisma.$queryRawUnsafe(
      `SELECT consumer_id, COUNT(*)::int AS n FROM replay_harness_effects
        WHERE outbox_event_id = $1::uuid GROUP BY consumer_id ORDER BY consumer_id`,
      eventId,
    );
    replayLog.push({ case: 'per-consumer', eventId, perConsumer });
    expect(perConsumer).toEqual([
      { consumer_id: 'evolutio-replay-a', n: 1 },
      { consumer_id: 'evolutio-replay-b', n: 1 },
    ]);
  }, 60_000);
});

describe('Outbox replay harness — quarantine is visible from outside the process', () => {
  it('an unparseable event is quarantined, never reaches the consumer, and the reconcile script reports it', async () => {
    const before = spawnSync(process.execPath, [RECONCILE_SCRIPT], {
      env: { ...process.env, DATABASE_URL: pg.url() }, encoding: 'utf8',
    });
    expect(before.status).toBe(0);
    const quarantinedBefore = JSON.parse(before.stdout).quarantined_count as number;

    const taskId = await seedTask();
    const eventId = await seedEvent(taskId, { eventPayload: { garbage: true } });
    const consumer = effectConsumer('evolutio-poison');
    const relay = freshRelay('poison');
    await relay.resume();
    const result = await relay.cycle(consumer);

    const after = spawnSync(process.execPath, [RECONCILE_SCRIPT, '--fail-on-quarantine'], {
      env: { ...process.env, DATABASE_URL: pg.url() }, encoding: 'utf8',
    });
    const snapshot = JSON.parse(after.stdout);
    replayLog.push({
      case: 'quarantine-visible', eventId, cycle: result, quarantinedBefore,
      quarantinedAfter: snapshot.quarantined_count, reconcileExit: after.status,
      entry: snapshot.quarantined.find((q: { outbox_event_id: string }) => q.outbox_event_id === eventId),
    });

    expect(result.quarantined).toBe(1);
    expect(consumer.invocations).toBe(0);
    expect(snapshot.schema).toBe('OutboxReconciliation/v1');
    expect(snapshot.quarantined_count).toBe(quarantinedBefore + 1);
    expect(snapshot.quarantined).toEqual(expect.arrayContaining([
      expect.objectContaining({ outbox_event_id: eventId, last_error_code: 'MALFORMED_EVENT' }),
    ]));
    expect(snapshot.lease_status_counts.quarantined).toBeGreaterThanOrEqual(1);
    // A monitor using the flag goes red instead of the poison event sitting unseen.
    expect(after.status).toBe(3);
  }, 60_000);
});

describe('Outbox replay harness — a late revision does not roll the read model back (AEV-AC014)', () => {
  // The relay orders by recorded_at and gives no cross-event ordering promise,
  // so monotonicity is the consumer's job: it keys the read model on the
  // event's aggregateVersion and refuses to move it backwards.
  function monotonicConsumer(consumerId: string): OutboxConsumer {
    return {
      consumerId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async consume(event: OutboxEvent, tx: any) {
        const applied = await tx.$queryRawUnsafe(
          `INSERT INTO replay_harness_read_model (task_id, revision) VALUES ($1::uuid, $2)
           ON CONFLICT (task_id) DO UPDATE SET revision = EXCLUDED.revision
             WHERE replay_harness_read_model.revision < EXCLUDED.revision
           RETURNING revision`,
          event.taskId, event.aggregateVersion,
        );
        const outcome = applied.length === 1 ? 'applied' : 'late_ignored';
        await tx.$executeRawUnsafe(
          `INSERT INTO replay_harness_effects (consumer_id, outbox_event_id, outcome) VALUES ($1, $2::uuid, $3)`,
          consumerId, event.id, outcome,
        );
        return { digest: `sha256:${outcome}-${event.id}` };
      },
    };
  }

  it('revision 4 then revision 2: the read model keeps 4 and the late event is marked, not applied', async () => {
    const taskId = await seedTask();
    const consumer = monotonicConsumer('evolutio-read-model');
    const rev4 = await seedEvent(taskId, { aggregateVersion: 4 });
    const relay1 = freshRelay('rev4');
    await relay1.resume();
    const r1 = await relay1.cycle(consumer);
    const rev2 = await seedEvent(taskId, { aggregateVersion: 2 });
    const relay2 = freshRelay('rev2');
    await relay2.resume();
    const r2 = await relay2.cycle(consumer);

    const model = await prisma.$queryRawUnsafe(
      `SELECT revision FROM replay_harness_read_model WHERE task_id = $1::uuid`, taskId,
    );
    const outcomes = await prisma.$queryRawUnsafe(
      `SELECT outbox_event_id::text AS id, outcome FROM replay_harness_effects
        WHERE consumer_id = 'evolutio-read-model' ORDER BY replay_harness_effects.id`,
    );
    replayLog.push({ case: 'AC014-late-revision', taskId, rev4, rev2, cycles: [r1, r2], model, outcomes });

    expect(r1.delivered).toBe(1);
    expect(r2.delivered).toBe(1); // handled safely, not quarantined
    expect(model).toEqual([{ revision: 4 }]);
    expect(outcomes).toEqual([
      { id: rev4, outcome: 'applied' },
      { id: rev2, outcome: 'late_ignored' },
    ]);
  }, 60_000);
});
