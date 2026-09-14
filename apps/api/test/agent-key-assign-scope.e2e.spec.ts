/**
 * MUN-0051 (e2e) — three findings of MUN-0050, over real HTTP against the
 * DATABASE_URL database.
 *
 * 1. `POST /agents/tasks/:taskId/assign` had no scope: any valid key assigned
 *    any agent to any task with any role, and since MUN-0050 an executor row
 *    moves status — "assign yourself, then move the card" was open to every key.
 *    Now a key assigns only on a task it created (any role) or executes
 *    (executor/reviewer), only agents of its own workspace; a JWT is not
 *    narrowed; every assignment writes a `task:agent_assigned` activity row.
 * 2. A creator without an assignment could not read or comment on its own task;
 *    now it can, and the project listing includes the tasks it created.
 * 3. `validateApiKey` bcrypt-compared the presented key against every stored
 *    key; now one indexed lookup by `lookup_hash`, one comparison, and a key
 *    created before the migration still works and is back-filled on first use.
 */
import supertest from 'supertest';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
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
import { AGENT_ASSIGNED_ACTION } from '../src/agents/agents.service.js';

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

describe('MUN-0051 — agent-key assign scope, creator read, keyed key lookup (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;

  let userId: string;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;
  const ids: Record<string, string> = {};
  const keys: Record<string, string> = {};

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [TestAppModule] })
      .overrideProvider(KanbanService)
      .useValue({ notify: () => void 0 })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
    authSvc = moduleRef.get(AuthService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const id = uuidv4().slice(0, 8);
    const user = await prisma.user.create({ data: { name: `mun0051-${id}` } });
    userId = user.id;
    workspaceId = (
      await prisma.workspace.create({ data: { slug: `ws-${id}`, name: `WS ${id}`, ownerId: user.id } })
    ).id;
    otherWorkspaceId = (
      await prisma.workspace.create({ data: { slug: `ws-o-${id}`, name: `Other ${id}`, ownerId: user.id } })
    ).id;
    projectId = (
      await prisma.project.create({ data: { workspaceId, slug: `proj-${id}`, name: `Proj ${id}` } })
    ).id;
    for (const [name, ws] of [
      ['creator', workspaceId],
      ['executor', workspaceId],
      ['lead', workspaceId],
      ['reviewer', workspaceId],
      ['stranger', workspaceId],
      ['target', workspaceId],
      ['foreign', otherWorkspaceId],
    ] as const) {
      ids[name] = (await prisma.agent.create({ data: { workspaceId: ws, name: `${name}-${id}` } })).id;
      keys[name] = (await authSvc.createApiKey(ids[name], name)).key;
    }
  });

  afterEach(async () => {
    const taskIds = await prisma.task
      .findMany({ where: { projectId }, select: { id: true } })
      .then((rows) => rows.map((r) => r.id));
    if (taskIds.length > 0) {
      await prisma.taskAgent.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.taskFieldState.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.activityLog.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    }
    await prisma.project.delete({ where: { id: projectId } }).catch(() => void 0);
    for (const wid of [workspaceId, otherWorkspaceId]) {
      await prisma.activityLog.deleteMany({ where: { workspaceId: wid } });
      // explicit, not by cascade: leaked keys slow every later test's legacy scan
      await prisma.apiKey.deleteMany({ where: { agent: { workspaceId: wid } } });
      await prisma.agent.deleteMany({ where: { workspaceId: wid } });
      await prisma.workspace.delete({ where: { id: wid } }).catch(() => void 0);
    }
    await prisma.user.delete({ where: { id: userId } }).catch(() => void 0);
  });

  /** A task as `POST /tasks` with the creator's key records it. */
  async function agentTask() {
    const task = await prisma.task.create({
      data: {
        projectId,
        title: 'MUN-0051 task',
        status: 'todo',
        priority: 'medium',
        createdById: ids.creator,
        actorType: 'agent',
      },
    });
    await prisma.taskAgent.createMany({
      data: [
        { taskId: task.id, agentId: ids.executor, role: 'executor' },
        { taskId: task.id, agentId: ids.lead, role: 'lead' },
        { taskId: task.id, agentId: ids.reviewer, role: 'reviewer' },
      ],
    });
    return task;
  }

  const http = () => supertest(app.getHttpServer());
  const assign = (taskId: string, bearer: string, agentId: string, role: string) =>
    http().post(`/agents/tasks/${taskId}/assign`).set('Authorization', `Bearer ${bearer}`).send({ agentId, role });
  const rowOf = (taskId: string, agentId: string) =>
    prisma.taskAgent.findUnique({ where: { taskId_agentId: { taskId, agentId } } });
  const assignedRows = (taskId: string) =>
    prisma.activityLog.findMany({ where: { taskId, action: AGENT_ASSIGNED_ACTION }, orderBy: { createdAt: 'asc' } });

  // -------------------------------------------------------------------------
  // 1. the assign route
  // -------------------------------------------------------------------------

  it('the creator assigns an agent of its workspace with any role, attributed to the agent', async () => {
    const task = await agentTask();
    const res = await assign(task.id, keys.creator, ids.target, 'lead').expect(201);
    expect(res.body).toEqual(expect.objectContaining({ taskId: task.id, agentId: ids.target, role: 'lead' }));

    const rows = await assignedRows(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].actorType).toBe('agent');
    expect(rows[0].actorId).toBe(ids.creator);
    expect(rows[0].payload).toEqual({ agentId: ids.target, role: 'lead', basis: 'creator' });
  });

  it('the executor grants executor or reviewer, never lead', async () => {
    const task = await agentTask();
    await assign(task.id, keys.executor, ids.target, 'lead').expect(403);
    expect(await rowOf(task.id, ids.target)).toBeNull();
    await assign(task.id, keys.executor, ids.target, 'reviewer').expect(201);
    const rows = await assignedRows(task.id);
    expect(rows.map((r) => (r.payload as { basis: string }).basis)).toEqual(['executor']);
  });

  it('THE PRIVILEGE PATH IS CLOSED: a stranger cannot assign itself executor and then move the card', async () => {
    const task = await agentTask();
    await assign(task.id, keys.stranger, ids.stranger, 'executor').expect(403);
    expect(await rowOf(task.id, ids.stranger)).toBeNull();
    await http()
      .patch(`/tasks/${task.id}/status`)
      .set('Authorization', `Bearer ${keys.stranger}`)
      .send({ status: 'in_progress' })
      .expect(403);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('todo');
    expect(await assignedRows(task.id)).toHaveLength(0);
  });

  it('a lead or reviewer assignment grants no authority to assign', async () => {
    const task = await agentTask();
    await assign(task.id, keys.lead, ids.target, 'reviewer').expect(403);
    await assign(task.id, keys.reviewer, ids.target, 'reviewer').expect(403);
    await assign(task.id, keys.lead, ids.lead, 'executor').expect(403);
    expect(await rowOf(task.id, ids.target)).toBeNull();
    expect((await rowOf(task.id, ids.lead))?.role).toBe('lead');
  });

  it('another workspace: its key cannot assign here, and the creator cannot assign its agent', async () => {
    const task = await agentTask();
    await assign(task.id, keys.foreign, ids.foreign, 'executor').expect(403);
    await assign(task.id, keys.creator, ids.foreign, 'reviewer').expect(403);
    expect(await rowOf(task.id, ids.foreign)).toBeNull();
    // unknown and malformed task ids answer like a foreign one
    await assign(uuidv4(), keys.creator, ids.target, 'reviewer').expect(403);
    await assign('not-a-uuid', keys.creator, ids.target, 'reviewer').expect(403);
  });

  it('a human-created task: no agent key assigns on it; a JWT still does, recorded with basis jwt', async () => {
    const task = await prisma.task.create({
      data: { projectId, title: 'human task', status: 'todo', priority: 'medium', createdById: userId, actorType: 'human' },
    });
    await assign(task.id, keys.creator, ids.creator, 'executor').expect(403);
    await assign(task.id, keys.target, ids.target, 'executor').expect(403);

    const jwt = authSvc.signAccess(userId);
    await assign(task.id, jwt, ids.target, 'executor').expect(201);
    const rows = await assignedRows(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].actorType).toBe('human');
    expect(rows[0].actorId).toBe(userId);
    expect(rows[0].payload).toEqual({ agentId: ids.target, role: 'executor', basis: 'jwt' });
  });

  it('a repeat assignment answers 409 and writes nothing more; an unknown task 404 for a JWT', async () => {
    const task = await agentTask();
    await assign(task.id, keys.creator, ids.target, 'reviewer').expect(201);
    await assign(task.id, keys.creator, ids.target, 'reviewer').expect(409);
    expect(await assignedRows(task.id)).toHaveLength(1);
    await assign(uuidv4(), authSvc.signAccess(userId), ids.target, 'reviewer').expect(404);
  });

  // -------------------------------------------------------------------------
  // 2. the creator reads its own task
  // -------------------------------------------------------------------------

  it('the creator without an assignment reads, comments, reads activity and lists its task', async () => {
    const task = await prisma.task.create({
      data: { projectId, title: 'created, unassigned', status: 'todo', priority: 'medium', createdById: ids.creator, actorType: 'agent' },
    });
    await http().get(`/tasks/${task.id}`).set('Authorization', `Bearer ${keys.creator}`).expect(200);
    await http()
      .post(`/tasks/${task.id}/comments`)
      .set('Authorization', `Bearer ${keys.creator}`)
      .send({ body: 'creator comment' })
      .expect(201);
    const activity = await http().get(`/tasks/${task.id}/activity`).set('Authorization', `Bearer ${keys.creator}`).expect(200);
    expect(JSON.stringify(activity.body)).toContain('creator comment');
    const list = await http().get(`/tasks/project/${projectId}`).set('Authorization', `Bearer ${keys.creator}`).expect(200);
    expect((list.body as { id: string }[]).map((t) => t.id)).toContain(task.id);

    // not widened for anybody else, and a forged creator (agent id under a human actor type) is not a creator
    await http().get(`/tasks/${task.id}`).set('Authorization', `Bearer ${keys.stranger}`).expect(403);
    await http().get(`/tasks/${task.id}`).set('Authorization', `Bearer ${keys.foreign}`).expect(403);
    const forged = await prisma.task.create({
      data: { projectId, title: 'forged', status: 'todo', priority: 'medium', createdById: ids.creator, actorType: 'human' },
    });
    await http().get(`/tasks/${forged.id}`).set('Authorization', `Bearer ${keys.creator}`).expect(403);
    const list2 = await http().get(`/tasks/project/${projectId}`).set('Authorization', `Bearer ${keys.stranger}`).expect(200);
    expect(list2.body).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 3. the key lookup
  // -------------------------------------------------------------------------

  it('a new key is stored with its sha256 lookup id and authenticates through it', async () => {
    const stored = await prisma.apiKey.findFirstOrThrow({ where: { agentId: ids.stranger } });
    expect(stored.lookupHash).toBe(createHash('sha256').update(keys.stranger).digest('hex'));
    await http().get('/agents/tasks').set('Authorization', `Bearer ${keys.stranger}`).expect(200);
  });

  it('a key created before the migration (no lookup id) still authenticates and is back-filled', async () => {
    const raw = `mun_sk_${uuidv4().replace(/-/g, '')}`;
    const legacy = await prisma.apiKey.create({
      data: { agentId: ids.target, keyHash: await bcrypt.hash(raw, 4), label: 'legacy' },
    });
    expect(legacy.lookupHash).toBeNull();

    await http().get('/agents/tasks').set('Authorization', `Bearer ${raw}`).expect(200);

    // the back-fill is fire-and-forget; poll briefly for it
    let filled: string | null = null;
    for (let i = 0; i < 50 && !filled; i++) {
      filled = (await prisma.apiKey.findUniqueOrThrow({ where: { id: legacy.id } })).lookupHash;
      if (!filled) await new Promise((r) => setTimeout(r, 20));
    }
    expect(filled).toBe(createHash('sha256').update(raw).digest('hex'));
    await http().get('/agents/tasks').set('Authorization', `Bearer ${raw}`).expect(200);
  });

  it('an unknown, a revoked and an expired key all answer 401', async () => {
    await http().get('/agents/tasks').set('Authorization', `Bearer mun_sk_${'0'.repeat(32)}`).expect(401);
    await prisma.apiKey.updateMany({ where: { agentId: ids.lead }, data: { revokedAt: new Date() } });
    await http().get('/agents/tasks').set('Authorization', `Bearer ${keys.lead}`).expect(401);
    await prisma.apiKey.updateMany({ where: { agentId: ids.reviewer }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await http().get('/agents/tasks').set('Authorization', `Bearer ${keys.reviewer}`).expect(401);
  });
});
