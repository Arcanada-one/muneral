/**
 * A2-336 (e2e) — `done` requires an evidence attachment when
 * MUNERAL_DONE_REQUIRES_EVIDENCE_ENABLED=true, over real HTTP against the
 * DATABASE_URL database.
 *
 * The evidence the guard counts is written by the REAL writer —
 * `POST /tasks/:taskId/evidence` — never by a row this spec inserts itself, so
 * the guard is measured against what the attach route actually stores.
 *
 * Both states of the switch are measured on every guarded writer:
 *
 *   PATCH /tasks/:id/status             off → 200 with no evidence
 *                                       on  → 409 EVIDENCE_REQUIRED_FOR_DONE,
 *                                             row and activity log untouched;
 *                                             200 once an attachment exists
 *   POST /tasks {status: done}          off → 201; on → 409
 *   POST /migration/work-items/:id/transitions
 *                                       off → 200; on → 409, then 200 after attach
 *
 * and the switch does not reach what it must not: a move to any other status,
 * a same-status repeat on a task already `done`, and a value other than the
 * exact string `true`.
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
import { MigrationModule } from '../src/migration/migration.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KanbanService } from '../src/ws/kanban.service.js';
import { DONE_REQUIRES_EVIDENCE_ENV } from '../src/tasks/evidence/done-evidence-guard.js';

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule, MigrationModule],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

const CODE = 'EVIDENCE_REQUIRED_FOR_DONE';
const RECEIPT = {
  uri: 'https://github.com/Arcanada-one/muneral/blob/main/receipts/graph/a2-336.json',
  sha256: 'c3'.repeat(32),
  contentType: 'application/json',
};

describe('done requires an evidence attachment behind a switch (A2-336, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;

  let workspaceId: string;
  let projectId: string;
  let agentId: string;
  let agentKey: string;
  const saved = process.env[DONE_REQUIRES_EVIDENCE_ENV];

  const http = () => supertest(app.getHttpServer());
  const setSwitch = (value: string | undefined) => {
    if (value === undefined) delete process.env[DONE_REQUIRES_EVIDENCE_ENV];
    else process.env[DONE_REQUIRES_EVIDENCE_ENV] = value;
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [TestAppModule] })
      .overrideProvider(KanbanService)
      .useValue({ notify: () => void 0 })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = moduleRef.get(PrismaService);
    authSvc = moduleRef.get(AuthService);
  });

  afterAll(async () => {
    setSwitch(saved);
    await app.close();
  });

  beforeEach(async () => {
    const id = uuidv4().slice(0, 8);
    const user = await prisma.user.create({ data: { name: `a2336-${id}` } });
    workspaceId = (
      await prisma.workspace.create({ data: { slug: `ws-a2336-${id}`, name: `WS ${id}`, ownerId: user.id } })
    ).id;
    projectId = (
      await prisma.project.create({ data: { workspaceId, slug: `proj-a2336-${id}`, name: `Proj ${id}` } })
    ).id;
    const agent = await prisma.agent.create({ data: { workspaceId, name: `executor-${id}` } });
    agentId = agent.id;
    agentKey = (await authSvc.createApiKey(agent.id, 'executor')).key;
  });

  afterEach(async () => {
    setSwitch(saved);
    const taskIds = (await prisma.task.findMany({ where: { projectId }, select: { id: true } })).map((r) => r.id);
    if (taskIds.length > 0) {
      await prisma.taskAgent.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.taskFieldState.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.activityLog.deleteMany({ where: { taskId: { in: taskIds } } });
      // A task that recorded an execution transition is append-only (MUN-0040)
      // and stays, as in tasks-agent-status.e2e.spec.ts; the rest goes.
      const kept = new Set(
        (
          await prisma.taskExecutionTransition.findMany({
            where: { taskId: { in: taskIds } },
            select: { taskId: true },
            distinct: ['taskId'],
          })
        ).map((r) => r.taskId),
      );
      const deletable = taskIds.filter((t) => !kept.has(t));
      if (deletable.length > 0) await prisma.task.deleteMany({ where: { id: { in: deletable } } });
    }
    await prisma.project.delete({ where: { id: projectId } }).catch(() => void 0);
    await prisma.activityLog.deleteMany({ where: { workspaceId } });
    await prisma.apiKey.deleteMany({ where: { agentId } });
    await prisma.agent.delete({ where: { id: agentId } }).catch(() => void 0);
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => void 0);
  });

  /** A task the agent created, sitting in `status`. */
  const ownTask = (status: 'review' | 'done' | 'in_progress' = 'review') =>
    prisma.task.create({
      data: {
        projectId,
        title: 'A2-336 fixture',
        status,
        priority: 'medium',
        createdById: agentId,
        actorType: 'agent',
      },
    });

  const move = (taskId: string, status: string) =>
    http().patch(`/tasks/${taskId}/status`).set('Authorization', `Bearer ${agentKey}`).send({ status });

  const attach = (taskId: string) =>
    http().post(`/tasks/${taskId}/evidence`).set('Authorization', `Bearer ${agentKey}`).send(RECEIPT);

  const migrate = (taskId: string, toStatus: string) =>
    http()
      .post(`/migration/work-items/${taskId}/transitions`)
      .set('Authorization', `Bearer ${agentKey}`)
      .send({ expectedRevision: 0, toStatus, idempotencyKey: `a2336-${uuidv4()}`, basis: 'a2-336' });

  // ---- PATCH /tasks/:id/status ----

  it('switch OFF (unset): review → done with no evidence is 200, as before', async () => {
    setSwitch(undefined);
    const task = await ownTask();
    const res = await move(task.id, 'done').expect(200);
    expect(res.body.status).toBe('done');
  });

  it('switch ON: review → done with no evidence is 409 EVIDENCE_REQUIRED_FOR_DONE and writes nothing', async () => {
    setSwitch('true');
    const task = await ownTask();

    const res = await move(task.id, 'done').expect(409);
    expect(res.body).toMatchObject({ code: CODE, taskId: task.id, toStatus: 'done', evidenceCount: 0 });

    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe('review');
    const moved = await prisma.activityLog.count({
      where: { taskId: task.id, action: 'task:status_changed' },
    });
    expect(moved).toBe(0);
  });

  it('switch ON: once the attach route stored a receipt, review → done is 200', async () => {
    setSwitch('true');
    const task = await ownTask();

    await move(task.id, 'done').expect(409);
    await attach(task.id).expect(201);
    const res = await move(task.id, 'done').expect(200);
    expect(res.body.status).toBe('done');
  });

  it('switch ON: a move to a status other than done is not affected', async () => {
    setSwitch('true');
    const task = await ownTask();
    const res = await move(task.id, 'blocked').expect(200);
    expect(res.body.status).toBe('blocked');
  });

  it('switch ON: a same-status repeat on a task already done stays 200 idempotent', async () => {
    setSwitch('true');
    const task = await ownTask('done');
    const res = await move(task.id, 'done').expect(200);
    expect(res.body.idempotent).toBe(true);
  });

  it.each(['1', 'TRUE', 'yes', ''])('switch value %j is not `true`: the rule stays off', async (value) => {
    setSwitch(value);
    const task = await ownTask();
    await move(task.id, 'done').expect(200);
  });

  // ---- POST /tasks with status done ----

  it('POST /tasks {status: done}: 201 with the switch off, 409 with it on', async () => {
    const body = { projectId, title: 'A2-336 born done', status: 'done' };

    setSwitch(undefined);
    await http().post('/tasks').set('Authorization', `Bearer ${agentKey}`).send(body).expect(201);

    setSwitch('true');
    const res = await http()
      .post('/tasks')
      .set('Authorization', `Bearer ${agentKey}`)
      .send({ ...body, title: 'A2-336 born done, refused' })
      .expect(409);
    expect(res.body.code).toBe(CODE);
    expect(
      await prisma.task.count({ where: { projectId, title: 'A2-336 born done, refused' } }),
    ).toBe(0);
  });

  // ---- POST /migration/work-items/:id/transitions ----

  it('migration transition review → done: 200 with the switch off', async () => {
    setSwitch(undefined);
    const task = await ownTask();
    const res = await migrate(task.id, 'done').expect(200);
    expect(res.body.toStatus).toBe('done');
  });

  it('migration transition review → done: 409 with the switch on, 200 after attach', async () => {
    setSwitch('true');
    const task = await ownTask();

    const refused = await migrate(task.id, 'done').expect(409);
    expect(refused.body.code).toBe(CODE);
    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row).toMatchObject({ status: 'review', revision: 0 });

    await attach(task.id).expect(201);
    const res = await migrate(task.id, 'done').expect(200);
    expect(res.body).toMatchObject({ toStatus: 'done', revision: 1 });
  });
});
