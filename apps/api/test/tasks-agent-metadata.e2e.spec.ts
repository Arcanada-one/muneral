/**
 * MUN-0077 (e2e) — `PATCH /tasks/:taskId` agent-safe metadata under `'task'`
 * scope, against a task-owned disposable PostgreSQL.
 *
 * Measured gap: PATCH /tasks/:taskId → HTTP 404 Cannot PATCH. Agents had no
 * route for priority/dueDate/estimateHours/sprintId; title/status abuse must
 * stay refused (status has its own route; title needs redaction).
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
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KanbanService } from '../src/ws/kanban.service.js';
import { TaskFieldStateService } from '../src/tasks/field-state/task-field-state.service.js';
import { createDisposablePostgres } from './support/disposable-postgres.js';

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

const UPDATE_ACTION = 'task:updated';

describe('PATCH /tasks/:taskId agent-safe metadata (e2e)', () => {
  const pg = createDisposablePostgres('mun-0077-metadata');
  let app: INestApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;
  let fsSvc: TaskFieldStateService;
  const savedUrl = process.env.DATABASE_URL;

  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;
  let creatorAgentId: string;
  let strangerAgentId: string;
  let foreignAgentId: string;
  let creatorKey: string;
  let strangerKey: string;
  let foreignKey: string;

  beforeAll(async () => {
    await pg.start();
    process.env.DATABASE_URL = pg.url();
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
    fsSvc = moduleRef.get(TaskFieldStateService);
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await pg.stop();
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
  }, 120_000);

  beforeEach(async () => {
    const id = uuidv4().slice(0, 8);
    const user = await prisma.user.create({ data: { name: `mun0077-${id}` } });
    workspaceId = (
      await prisma.workspace.create({
        data: { slug: `ws-${id}`, name: `WS ${id}`, ownerId: user.id },
      })
    ).id;
    otherWorkspaceId = (
      await prisma.workspace.create({
        data: { slug: `ws-other-${id}`, name: `Other ${id}`, ownerId: user.id },
      })
    ).id;
    projectId = (
      await prisma.project.create({
        data: { workspaceId, slug: `proj-${id}`, name: `Proj ${id}` },
      })
    ).id;

    const mk = async (name: string, ws = workspaceId) =>
      (await prisma.agent.create({ data: { workspaceId: ws, name: `${name}-${id}` } })).id;
    creatorAgentId = await mk('creator');
    strangerAgentId = await mk('stranger');
    foreignAgentId = await mk('foreign', otherWorkspaceId);

    const key = async (agentId: string, label: string) =>
      (await authSvc.createApiKey(agentId, label)).key;
    creatorKey = await key(creatorAgentId, 'creator');
    strangerKey = await key(strangerAgentId, 'stranger');
    foreignKey = await key(foreignAgentId, 'foreign');
  });

  async function createTask() {
    const task = await prisma.task.create({
      data: {
        projectId,
        title: 'MUN-0077 task',
        status: 'todo',
        priority: 'medium',
        createdById: creatorAgentId,
        actorType: 'agent',
      },
    });
    await prisma.$transaction(async (tx) => {
      await fsSvc.recompute(tx, task);
    });
    return task;
  }

  const patch = (taskId: string, key: string, body: Record<string, unknown>) =>
    supertest(app.getHttpServer())
      .patch(`/tasks/${taskId}`)
      .set('Authorization', `Bearer ${key}`)
      .send(body);

  it('lets the creator update priority and returns auditEventId with a task:updated row', async () => {
    const task = await createTask();
    const res = await patch(task.id, creatorKey, { priority: 'high' }).expect(200);
    expect(res.body.priority).toBe('high');
    expect(res.body.status).toBe('todo');
    expect(res.body.title).toBe('MUN-0077 task');
    expect(typeof res.body.auditEventId).toBe('string');
    expect(res.body.auditEventId.length).toBeGreaterThan(10);

    const rows = await prisma.activityLog.findMany({
      where: { taskId: task.id, action: UPDATE_ACTION },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(res.body.auditEventId);
    expect(rows[0].actorType).toBe('agent');
    expect(rows[0].actorId).toBe(creatorAgentId);
    expect(rows[0].payload).toEqual({ priority: 'high' });

    const stored = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(stored.priority).toBe('high');
    expect(stored.status).toBe('todo');
  });

  it('refuses title and status abuse with HTTP 400 and writes nothing', async () => {
    const task = await createTask();
    await patch(task.id, creatorKey, { title: 'hijack' }).expect(400);
    await patch(task.id, creatorKey, { status: 'done' }).expect(400);
    await patch(task.id, creatorKey, { priority: 'high', status: 'done' }).expect(400);
    await patch(task.id, creatorKey, {}).expect(400);

    const stored = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(stored.title).toBe('MUN-0077 task');
    expect(stored.status).toBe('todo');
    expect(stored.priority).toBe('medium');
    expect(await prisma.activityLog.count({ where: { taskId: task.id, action: UPDATE_ACTION } })).toBe(
      0,
    );
  });

  it('refuses a stranger and a foreign-workspace key with 403', async () => {
    const task = await createTask();
    await patch(task.id, strangerKey, { priority: 'low' }).expect(403);
    await patch(task.id, foreignKey, { priority: 'low' }).expect(403);
    const stored = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(stored.priority).toBe('medium');
  });
});
