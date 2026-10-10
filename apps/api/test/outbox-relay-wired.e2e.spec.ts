/**
 * A2-370 (AEV E03.03, "relay wired") — the outbox relay runs in the Nest app,
 * against the DATABASE_URL database, fed by a REAL route and delivering to a
 * REAL consumer.
 *
 *   PATCH /tasks/:taskId/status (todo → in_progress → review → done)
 *     → TasksService → TaskExecutionRecorderService → ExecutionAuthorityService
 *       writes task_outbox_events + outbox_leases (MUN-0040 / MUN-0021)
 *     → OutboxRelayWorker (OutboxModule) → OutboxRelay.cycle()
 *     → WorkOutcomeLedgerConsumer writes ONE work_outcome_records row for the
 *       task:completed event (AEV work.outcome.recorded)
 *
 * The events are the ones the production code path writes, not seeded rows,
 * so the consumer reads what the real producer writes.
 *
 * Replay: a restarted relay after a crash between commit and acknowledgement
 * sees the lease back at 'pending' (DELETE + INSERT; the forward-only trigger
 * forbids an UPDATE rewind — same technique as outbox.relay.postgres.spec.ts
 * test 9). Each replay runs on a NEW worker/relay instance. The effect is
 * counted with SQL after every delivery; delivery_attempt_evidence proves the
 * event really was redelivered. Counters are printed as one `[relay-wired]`
 * JSON line.
 */
import supertest from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, Module } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { TasksModule } from '../src/tasks/tasks.module.js';
import { AgentsModule } from '../src/agents/agents.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { ActivityModule } from '../src/activity/activity.module.js';
import { OutboxModule } from '../src/outbox/outbox.module.js';
import { OutboxRelayWorker } from '../src/outbox/outbox-relay.worker.js';
import { WORK_OUTCOME_LEDGER_CONSUMER_ID } from '../src/outbox/work-outcome-ledger.consumer.js';
import {
  SYSTEM_CLOCK,
  UUID_ID_SOURCE,
} from '../src/execution-authority/execution-authority.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KanbanService } from '../src/ws/kanban.service.js';
import { TaskFieldStateService } from '../src/tasks/field-state/task-field-state.service.js';

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule, OutboxModule],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

const REPLAYS = 5;
const MAX_CYCLES = 200;

describe('outbox relay wired: route → outbox → relay → consumer (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: OutboxRelayWorker;
  let authSvc: AuthService;
  let fsSvc: TaskFieldStateService;
  let workspaceId: string;
  let projectId: string;
  let agentId: string;
  let key: string;
  const log: Record<string, unknown> = {};

  beforeAll(async () => {
    delete process.env.OUTBOX_RELAY_ENABLED;
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [TestAppModule] })
      .overrideProvider(KanbanService)
      .useValue({ notify: () => void 0 })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
    worker = moduleRef.get(OutboxRelayWorker);
    authSvc = moduleRef.get(AuthService);
    fsSvc = moduleRef.get(TaskFieldStateService);

    const id = uuidv4().slice(0, 8);
    const user = await prisma.user.create({ data: { name: `a2-370-${id}` } });
    workspaceId = (
      await prisma.workspace.create({ data: { slug: `ws-a2370-${id}`, name: `WS ${id}`, ownerId: user.id } })
    ).id;
    projectId = (
      await prisma.project.create({ data: { workspaceId, slug: `proj-${id}`, name: `Proj ${id}` } })
    ).id;
    agentId = (await prisma.agent.create({ data: { workspaceId, name: `creator-${id}` } })).id;
    key = (await authSvc.createApiKey(agentId, 'a2-370')).key;
  });

  afterAll(async () => {
    // Tasks with execution transitions are undeletable by design (append-only,
    // Restrict) — see tasks-agent-status.e2e.spec.ts. Remove the key/agent so
    // later suites do not pay for another bcrypt comparison.
    await prisma.apiKey.deleteMany({ where: { agentId } }).catch(() => void 0);
    console.log(`[relay-wired] ${JSON.stringify(log)}`);
    await app.close();
  });

  async function createTask(): Promise<string> {
    const task = await prisma.task.create({
      data: {
        projectId,
        title: 'A2-370 relay-wired task',
        status: 'todo',
        priority: 'medium',
        createdById: agentId,
        actorType: 'agent',
      },
    });
    await prisma.$transaction(async (tx) => {
      await fsSvc.recompute(tx, task);
    });
    return task.id;
  }

  const patch = (taskId: string, status: string) =>
    supertest(app.getHttpServer())
      .patch(`/tasks/${taskId}/status`)
      .set('Authorization', `Bearer ${key}`)
      .send({ status });

  const eventsOf = (taskId: string) =>
    prisma.taskOutboxEvent.findMany({
      where: { taskId },
      include: { lease: true },
      orderBy: { recordedAt: 'asc' },
    });

  const effectsOf = (taskId: string) => prisma.workOutcomeRecord.count({ where: { taskId } });

  const deliveredAttempts = (eventId: string) =>
    prisma.deliveryAttemptEvidence.count({
      where: { outboxEventId: eventId, disposition: 'delivered' },
    });

  /** Run relay cycles until every event of the task is delivered. */
  async function drain(w: OutboxRelayWorker, taskId: string): Promise<number> {
    for (let i = 1; i <= MAX_CYCLES; i++) {
      await w.tick();
      const rows = await eventsOf(taskId);
      if (rows.every((r) => r.lease?.deliveryStatus === 'delivered')) return i;
    }
    throw new Error(`events of ${taskId} not delivered within ${MAX_CYCLES} cycles`);
  }

  async function rewindLease(eventId: string): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM public.outbox_leases WHERE outbox_event_id = $1::uuid`, eventId);
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.outbox_leases (outbox_event_id, delivery_status, delivery_ordinal, failure_count)
       VALUES ($1::uuid, 'pending', 0, 0)`,
      eventId,
    );
  }

  it('disabled by default: wired, but nothing polls while OUTBOX_RELAY_ENABLED is unset', async () => {
    const taskId = await createTask();
    expect((await patch(taskId, 'in_progress')).status).toBe(200);
    const before = await eventsOf(taskId);
    expect(before.length).toBeGreaterThan(0);

    const idle = await worker.tick();
    expect(idle).toEqual({ polled: 0, leased: 0, delivered: 0, quarantined: 0, skipped: 0 });
    const after = await eventsOf(taskId);
    expect(after.map((r) => r.lease?.deliveryStatus)).toEqual(before.map(() => 'pending'));
    log.disabledByDefault = { events: before.length, cycle: idle, statusesAfter: after.map((r) => r.lease?.deliveryStatus) };
  });

  it('one request chain → outbox → delivery → ONE effect; replays add none', async () => {
    const taskId = await createTask();
    for (const status of ['in_progress', 'review', 'done']) {
      const res = await patch(taskId, status);
      expect(res.status).toBe(200);
    }

    const events = await eventsOf(taskId);
    const types = events.map((e) => e.eventType);
    log.eventTypes = types;
    expect(types.filter((t) => t === 'task:completed')).toHaveLength(1);
    expect(events.every((e) => e.lease?.deliveryStatus === 'pending')).toBe(true);
    expect(await effectsOf(taskId)).toBe(0);

    await worker.relay.resume();
    const cycles = await drain(worker, taskId);
    const completed = events.find((e) => e.eventType === 'task:completed')!;

    const effectsAfter: number[] = [await effectsOf(taskId)];
    const attemptsAfter: number[] = [await deliveredAttempts(completed.id)];
    const inbox = await prisma.consumerInbox.count({
      where: { consumerId: WORK_OUTCOME_LEDGER_CONSUMER_ID, outboxEventId: { in: events.map((e) => e.id) } },
    });
    const record = await prisma.workOutcomeRecord.findFirstOrThrow({ where: { taskId } });
    expect(record.outboxEventId).toBe(completed.id);
    expect(record.eventType).toBe('task:completed');
    expect(record.idempotencyKey).toBe(
      (completed.eventPayload as Record<string, unknown>).idempotencyKey,
    );

    for (let r = 1; r <= REPLAYS; r++) {
      await rewindLease(completed.id);
      const restarted = new OutboxRelayWorker(prisma, worker.consumer, SYSTEM_CLOCK, UUID_ID_SOURCE);
      await restarted.relay.resume();
      await drain(restarted, taskId);
      effectsAfter.push(await effectsOf(taskId));
      attemptsAfter.push(await deliveredAttempts(completed.id));
    }

    log.chain = {
      taskId,
      cyclesToDeliver: cycles,
      inboxRows: inbox,
      effectsAfterDelivery: effectsAfter,
      deliveredAttemptsOfCompleted: attemptsAfter,
    };
    expect(inbox).toBe(events.length);
    // Every replay was a real delivery (evidence grew by one each time) …
    expect(attemptsAfter).toEqual(Array.from({ length: REPLAYS + 1 }, (_, i) => i + 1));
    // … and none of them added an effect.
    expect(effectsAfter).toEqual(Array.from({ length: REPLAYS + 1 }, () => 1));
  });
});
