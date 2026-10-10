/**
 * A2-382 (AEV E03.03): the switch-on probe (scripts/outbox-relay-probe.mjs)
 * reads what the REAL components write.
 *
 *   PATCH /tasks/:taskId/status → TaskExecutionRecorderService →
 *   ExecutionAuthorityService (task_execution_transitions, task_outbox_events,
 *   outbox_leases) → OutboxRelayWorker.tick() → WorkOutcomeLedgerConsumer
 *   (work_outcome_records, consumer_inbox)
 *
 * On its own disposable database, so the probe's global invariants see only
 * this spec's rows. The probe runs as a child process, exactly as an operator
 * runs it. The red control inserts a duplicate ledger row (the table is
 * append-only, INSERT is allowed) and the probe must go red with exit 3.
 * Counters are printed as one `[relay-probe]` JSON line.
 */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as url from 'node:url';
import supertest from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, Module } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { createDisposablePostgres } from './support/disposable-postgres.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { TasksModule } from '../src/tasks/tasks.module.js';
import { AgentsModule } from '../src/agents/agents.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { ActivityModule } from '../src/activity/activity.module.js';
import { OutboxModule } from '../src/outbox/outbox.module.js';
import { OutboxRelayWorker } from '../src/outbox/outbox-relay.worker.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KanbanService } from '../src/ws/kanban.service.js';
import { TaskFieldStateService } from '../src/tasks/field-state/task-field-state.service.js';

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule, OutboxModule],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

const thisDir = path.dirname(url.fileURLToPath(import.meta.url));
const PROBE_SCRIPT = path.join(thisDir, '..', 'scripts', 'outbox-relay-probe.mjs');
const MAX_CYCLES = 200;

const pg = createDisposablePostgres('relayprobe');

describe('outbox relay switch-on probe reads the real relay (postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let worker: OutboxRelayWorker;
  let fsSvc: TaskFieldStateService;
  let projectId: string;
  let agentId: string;
  let key: string;
  const savedUrl = process.env.DATABASE_URL;
  const log: Record<string, unknown> = {};

  beforeAll(async () => {
    await pg.start();
    process.env.DATABASE_URL = pg.url();
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
    fsSvc = moduleRef.get(TaskFieldStateService);

    const id = uuidv4().slice(0, 8);
    const user = await prisma.user.create({ data: { name: `a2-382-${id}` } });
    const workspaceId = (
      await prisma.workspace.create({ data: { slug: `ws-a2382-${id}`, name: `WS ${id}`, ownerId: user.id } })
    ).id;
    projectId = (
      await prisma.project.create({ data: { workspaceId, slug: `proj-${id}`, name: `Proj ${id}` } })
    ).id;
    agentId = (await prisma.agent.create({ data: { workspaceId, name: `creator-${id}` } })).id;
    key = (await moduleRef.get(AuthService).createApiKey(agentId, 'a2-382')).key;
  }, 180_000);

  afterAll(async () => {
    console.log(`[relay-probe] ${JSON.stringify(log)}`);
    if (app) await app.close();
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
    await pg.stop();
  }, 60_000);

  async function createTask(): Promise<string> {
    const task = await prisma.task.create({
      data: {
        projectId,
        title: 'A2-382 relay-probe task',
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

  async function walk(taskId: string, statuses: string[]): Promise<void> {
    for (const status of statuses) {
      const res = await supertest(app.getHttpServer())
        .patch(`/tasks/${taskId}/status`)
        .set('Authorization', `Bearer ${key}`)
        .send({ status });
      expect(res.status).toBe(200);
    }
  }

  function probe(...args: string[]) {
    const r = spawnSync(process.execPath, [PROBE_SCRIPT, ...args], {
      env: { ...process.env, DATABASE_URL: pg.url() },
      encoding: 'utf8',
    });
    if (r.status !== 0 && r.status !== 3) throw new Error(`probe exit ${r.status}: ${r.stderr}`);
    return { exit: r.status, doc: JSON.parse(r.stdout) };
  }

  /** What OUTBOX_RELAY_ENABLED=true does at bootstrap: resume, then cycles. */
  async function drain(): Promise<number> {
    await worker.relay.resume();
    for (let i = 1; i <= MAX_CYCLES; i++) {
      await worker.tick();
      const open = await prisma.outboxLease.count({
        where: { deliveryStatus: { in: ['pending', 'leased'] } },
      });
      if (open === 0) return i;
    }
    throw new Error(`outbox not drained within ${MAX_CYCLES} cycles`);
  }

  let completedEventId: string;

  it('backlog with the relay off, then drained: ledger rows = terminal transitions, clean', async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const running = await createTask();
    const done = await createTask();
    const cancelled = await createTask();
    await walk(running, ['in_progress']);
    await walk(done, ['in_progress', 'review', 'done']);
    await walk(cancelled, ['in_progress', 'cancelled']);

    const before = probe('--since', since, '--fail-on-breach');
    log.before = { window: before.doc.window, leases: before.doc.lease_status_counts };
    expect(before.exit).toBe(0);
    expect(before.doc.schema).toBe('OutboxRelayProbe/v1');
    expect(before.doc.transaction_read_only).toBe('on');
    expect(before.doc.lease_status_counts).toEqual({ pending: 8 });
    expect(before.doc.window).toMatchObject({
      terminal_transitions: 2, outcome_events: 2, outcome_events_delivered: 0, ledger_rows: 0, drained: false,
    });

    log.cycles = await drain();
    const after = probe('--since', since, '--fail-on-breach');
    log.after = { window: after.doc.window, leases: after.doc.lease_status_counts, inbox: after.doc.ledger_inbox_rows };
    expect(after.exit).toBe(0);
    expect(after.doc.verdict).toBe('clean');
    expect(after.doc.lease_status_counts).toEqual({ delivered: 8 });
    expect(after.doc.ledger_inbox_rows).toBe(8);
    expect(after.doc.window).toMatchObject({
      terminal_transitions: 2, outcome_events: 2, outcome_events_delivered: 2,
      ledger_rows: 2, ledger_distinct_events: 2, drained: true,
    });
    expect(after.doc.by_event_type['task:completed']).toEqual({ delivered: 1 });
    expect(after.doc.by_event_type['task:cancelled']).toEqual({ delivered: 1 });

    completedEventId = (
      await prisma.taskOutboxEvent.findFirstOrThrow({ where: { taskId: done, eventType: 'task:completed' } })
    ).id;
  }, 120_000);

  it('red control: a duplicate ledger row turns the probe red with exit 3', async () => {
    const row = await prisma.workOutcomeRecord.findFirstOrThrow({ where: { outboxEventId: completedEventId } });
    await prisma.workOutcomeRecord.create({ data: { ...row, id: uuidv4() } });

    const red = probe('--fail-on-breach');
    log.red = { exit: red.exit, breached: red.doc.breached, breaches: red.doc.breaches };
    expect(red.exit).toBe(3);
    expect(red.doc.verdict).toBe('breach');
    expect(red.doc.breaches.duplicate_ledger_events).toBe(1);
    expect(red.doc.breaches.ledger_rows_exceed_terminal_transitions).toBe(1);
    // Without --fail-on-breach the probe reports and exits 0.
    expect(probe().exit).toBe(0);
  }, 60_000);
});
