import { jest } from '@jest/globals';
import { TaskContractBindingController } from '../src/tasks/task-contract-binding.controller.js';
import { ActivityService } from '../src/activity/activity.service.js';
import { TaskContractBindingService, CONTRACT_BINDING_ACTION } from '../src/tasks/task-contract-binding.service.js';
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

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

const DIGEST_A = `sha256:${'a1'.repeat(32)}`;
const DIGEST_B = `sha256:${'b2'.repeat(32)}`;

describe('Task contract CAS binding (af868172, real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;
  let activity: ActivityService;
  let binding: TaskContractBindingService;

  let userId: string;
  let workspaceId: string;
  let projectId: string;
  let agentId: string;
  let agentKey: string;

  const http = () => supertest(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [TestAppModule],
    })
      .overrideProvider(KanbanService)
      .useValue({ notify: () => void 0 })
      .compile();

    app = moduleRef.createNestApplication();
    // Exactly src/main.ts's pipe — see the header for why it matters here.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    prisma = moduleRef.get(PrismaService);
    authSvc = moduleRef.get(AuthService);
    activity = moduleRef.get(ActivityService);
    binding = moduleRef.get(TaskContractBindingService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const id = uuidv4().slice(0, 8);
    const user = await prisma.user.create({ data: { name: `a2267-${id}` } });
    userId = user.id;
    workspaceId = (
      await prisma.workspace.create({
        data: { slug: `ws-a2267-${id}`, name: `WS ${id}`, ownerId: user.id },
      })
    ).id;
    projectId = (
      await prisma.project.create({
        data: { workspaceId, slug: `proj-a2267-${id}`, name: `Proj ${id}` },
      })
    ).id;
    const agent = await prisma.agent.create({ data: { workspaceId, name: `intake-${id}` } });
    agentId = agent.id;
    agentKey = (await authSvc.createApiKey(agent.id, 'intake')).key;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    // None of these tasks is ever moved to in_progress/done/cancelled, so none
    // records an (append-only) execution transition and all of them delete.
    const taskIds = await prisma.task
      .findMany({ where: { projectId }, select: { id: true } })
      .then((rows) => rows.map((r) => r.id));
    if (taskIds.length > 0) {
      await prisma.taskAgent.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.taskTag.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.taskFieldState.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.activityLog.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    }
    await prisma.activityLog.deleteMany({ where: { workspaceId } });
    await prisma.project.delete({ where: { id: projectId } }).catch(() => void 0);
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => void 0);
  });

  function createWithKey(body: Record<string, unknown>) {
    return http()
      .post('/tasks')
      .set('Authorization', `Bearer ${agentKey}`)
      .send({ projectId, title: 'A2-267 intake work item', ...body });
  }

  const patch = (id: string, body: Record<string, unknown>, key = agentKey) =>
    http().patch(`/tasks/${id}/contract`).set('Authorization', `Bearer ${key}`).send(body);
  const create = async () => (await createWithKey({}).expect(201)).body.id as string;

  const conditionalGet = (id: string, etag?: string) => {
    const request = http().get(`/tasks/${id}`).set('Authorization', `Bearer ${agentKey}`);
    return etag ? request.set('If-None-Match', etag) : request;
  };

  it('invalidates the native conditional GET on bind, rebind and clear', async () => {
    const id = await create();
    let previous = await conditionalGet(id).expect(200);
    expect(previous.headers.etag).toBeDefined();
    await conditionalGet(id, previous.headers.etag).expect(304);
    for (const [expectedContractDigest, contractDigest] of [
      [null, DIGEST_A], [DIGEST_A, DIGEST_B], [DIGEST_B, null],
    ]) {
      await patch(id, { contractDigest, expectedContractDigest }).expect(200);
      const current = await conditionalGet(id, previous.headers.etag).expect(200);
      expect(current.body.contractDigest).toBe(contractDigest);
      expect(current.headers.etag).toBeDefined();
      expect(current.headers.etag).not.toBe(previous.headers.etag);
      await conditionalGet(id, current.headers.etag).expect(304);
      previous = current;
    }
  });

  it('invalidates the native conditional GET when project custody changes with the same digest', async () => {
    const id = await create();
    await patch(id, { contractDigest: DIGEST_A, expectedContractDigest: null }).expect(200);
    const previous = await conditionalGet(id).expect(200);
    const destination = await prisma.project.create({
      data: { workspaceId, slug: `etag-moved-${uuidv4()}`, name: 'Conditional read fixture' },
    });
    try {
      await prisma.task.update({ where: { id }, data: { projectId: destination.id } });
      const current = await conditionalGet(id, previous.headers.etag).expect(200);
      expect(current.body.projectId).toBe(destination.id);
      expect(current.body.contractDigest).toBe(DIGEST_A);
      expect(current.headers.etag).not.toBe(previous.headers.etag);
      await conditionalGet(id, current.headers.etag).expect(304);
      await patch(id, {
        contractDigest: DIGEST_B, expectedContractDigest: DIGEST_A, expectedProjectId: projectId,
      }).expect(409);
      await conditionalGet(id, current.headers.etag).expect(304);
    } finally {
      await prisma.task.update({ where: { id }, data: { projectId } });
      await prisma.project.delete({ where: { id: destination.id } });
    }
  });

  it('keeps the native conditional validator on a refused CAS and a no-op bind', async () => {
    const id = await create();
    const previous = await conditionalGet(id).expect(200);
    await patch(id, { contractDigest: DIGEST_A, expectedContractDigest: DIGEST_B }).expect(409);
    await conditionalGet(id, previous.headers.etag).expect(304);
    await patch(id, { contractDigest: null, expectedContractDigest: null }).expect(200);
    await conditionalGet(id, previous.headers.etag).expect(304);
  });

  it('keeps the native conditional validator when the pointer audit rolls back', async () => {
    const id = await create();
    const previous = await conditionalGet(id).expect(200);
    jest.spyOn(activity, 'log').mockRejectedValueOnce(new Error('fixture audit failure'));
    await patch(id, { contractDigest: DIGEST_A, expectedContractDigest: null }).expect(500);
    await conditionalGet(id, previous.headers.etag).expect(304);
    expect((await conditionalGet(id).expect(200)).body.contractDigest).toBeNull();
  });

  it('binds the existing creator-owned task, GET reads it, and audits the same actor and digests', async () => {
    const id = await create();
    const before = await prisma.task.count({ where: { projectId } });
    const res = await patch(id, { contractDigest: DIGEST_A, expectedContractDigest: null }).expect(200);
    expect(res.body).toMatchObject({ id, contractDigest: DIGEST_A });
    const read = await http().get(`/tasks/${id}`).set('Authorization', `Bearer ${agentKey}`).expect(200);
    expect(read.body.contractDigest).toBe(DIGEST_A);
    expect(await prisma.task.count({ where: { projectId } })).toBe(before);
    const rows = await prisma.activityLog.findMany({ where: { taskId: id, action: CONTRACT_BINDING_ACTION } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: 'agent', actorId: agentId,
      payload: { expectedProjectId: null, expectedContractDigest: null, contractDigest: DIGEST_A } });
  });

  it('refuses a changed project in the atomic write even when the agent owns both projects', async () => {
    const id = await create();
    const destination = await prisma.project.create({ data: { workspaceId, slug: `moved-${uuidv4()}`, name: 'Moved fixture' } });
    try {
      await prisma.task.update({ where: { id }, data: { projectId: destination.id } });
      await patch(id, { contractDigest: DIGEST_A, expectedContractDigest: null, expectedProjectId: projectId }).expect(409);
      expect((await prisma.task.findUniqueOrThrow({ where: { id } })).contractDigest).toBeNull();
      expect(await prisma.activityLog.count({ where: { taskId: id, action: CONTRACT_BINDING_ACTION } })).toBe(0);
      await patch(id, { contractDigest: DIGEST_A, expectedContractDigest: null, expectedProjectId: destination.id }).expect(200);
    } finally {
      await prisma.task.update({ where: { id }, data: { projectId } });
      await prisma.project.delete({ where: { id: destination.id } });
    }
  });

  it('refuses stale expected digest with 409 without mutation or audit', async () => {
    const id = await create();
    await patch(id, { contractDigest: DIGEST_A, expectedContractDigest: DIGEST_B }).expect(409);
    expect((await prisma.task.findUniqueOrThrow({ where: { id } })).contractDigest).toBeNull();
    expect(await prisma.activityLog.count({ where: { taskId: id, action: CONTRACT_BINDING_ACTION } })).toBe(0);
  });

  it('allows only one concurrent CAS from the same expected value', async () => {
    const id = await create();
    const responses = await Promise.all([
      patch(id, { contractDigest: DIGEST_A, expectedContractDigest: null }),
      patch(id, { contractDigest: DIGEST_B, expectedContractDigest: null }),
    ]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    const winner = responses.find(r => r.status === 200)!;
    expect((await prisma.task.findUniqueOrThrow({ where: { id } })).contractDigest).toBe(winner.body.contractDigest);
    expect(await prisma.activityLog.count({ where: { taskId: id, action: CONTRACT_BINDING_ACTION } })).toBe(1);
  });

  it('rebinds then clears by exact expected digest and GET returns null', async () => {
    const id = await create();
    await patch(id, { contractDigest: DIGEST_A, expectedContractDigest: null }).expect(200);
    await patch(id, { contractDigest: DIGEST_B, expectedContractDigest: DIGEST_A }).expect(200);
    await patch(id, { contractDigest: null, expectedContractDigest: DIGEST_B }).expect(200);
    const read = await http().get(`/tasks/${id}`).set('Authorization', `Bearer ${agentKey}`).expect(200);
    expect(read.body.contractDigest).toBeNull();
    expect(await prisma.activityLog.count({ where: { taskId: id, action: CONTRACT_BINDING_ACTION } })).toBe(3);
  });

  it('refuses an unrelated same-workspace agent and reviewer, but admits an existing executor', async () => {
    const id = await create();
    const other = await prisma.agent.create({ data: { workspaceId, name: `other-${uuidv4()}` } });
    const otherKey = (await authSvc.createApiKey(other.id, 'fixture')).key;
    await patch(id, { contractDigest: DIGEST_A, expectedContractDigest: null }, otherKey).expect(403);
    await prisma.taskAgent.create({ data: { taskId: id, agentId: other.id, role: 'reviewer' } });
    await patch(id, { contractDigest: DIGEST_A, expectedContractDigest: null }, otherKey).expect(403);
    await prisma.taskAgent.update({ where: { taskId_agentId: { taskId: id, agentId: other.id } }, data: { role: 'executor' } });
    await patch(id, { contractDigest: DIGEST_A, expectedContractDigest: null }, otherKey).expect(200);
  });

  it('refuses cross-workspace task even when an executor row exists', async () => {
    const id = await create();
    const foreign = await prisma.workspace.create({ data: { slug: `foreign-${uuidv4()}`, name: 'Foreign fixture', ownerId: userId } });
    try {
      const other = await prisma.agent.create({ data: { workspaceId: foreign.id, name: 'foreign fixture' } });
      const key = (await authSvc.createApiKey(other.id, 'fixture')).key;
      await prisma.taskAgent.create({ data: { taskId: id, agentId: other.id, role: 'executor' } });
      await patch(id, { contractDigest: DIGEST_A, expectedContractDigest: null }, key).expect(403);
      expect((await prisma.task.findUniqueOrThrow({ where: { id } })).contractDigest).toBeNull();
      expect(await prisma.activityLog.count({ where: { taskId: id, action: CONTRACT_BINDING_ACTION } })).toBe(0);
    } finally {
      await prisma.taskAgent.deleteMany({ where: { taskId: id, agent: { workspaceId: foreign.id } } });
      await prisma.workspace.delete({ where: { id: foreign.id } });
    }
  });

  it('refuses a broad task scope and missing authenticated workspace custody', async () => {
    const id = await create();
    const actor = { type: 'agent' as const, id: agentId, name: 'fixture agent' };
    const dto = { contractDigest: DIGEST_A, expectedContractDigest: null };
    await expect(binding.bind(id, actor, false, agentId, workspaceId, dto))
      .rejects.toMatchObject({ status: 403 });
    await expect(binding.bind(id, actor, true, agentId, undefined, dto))
      .rejects.toMatchObject({ status: 403 });
    await expect(binding.bind(id, actor, true, uuidv4(), workspaceId, dto))
      .rejects.toMatchObject({ status: 403 });
    const controller = new TaskContractBindingController(binding);
    const request = { actor, agentScope: { kind: 'task', agentId, workspaceId } };
    expect(() => controller.bind(id, request as Parameters<typeof controller.bind>[1], dto))
      .toThrow(expect.objectContaining({ status: 403 }));
    expect(() => controller.bind(id, { actor } as Parameters<typeof controller.bind>[1], dto))
      .toThrow(expect.objectContaining({ status: 403 }));
    expect((await prisma.task.findUniqueOrThrow({ where: { id } })).contractDigest).toBeNull();
    expect(await prisma.activityLog.count({ where: { taskId: id, action: CONTRACT_BINDING_ACTION } })).toBe(0);
  });

  it('rechecks ownership in the service after the outer guard snapshot', async () => {
    const id = await create();
    await prisma.task.update({ where: { id }, data: { createdById: null } });
    await expect(binding.bind(id, { type: 'agent', id: agentId, name: 'fixture agent' },
      true, agentId, workspaceId, { contractDigest: DIGEST_A, expectedContractDigest: null }))
      .rejects.toMatchObject({ status: 403 });
    expect((await prisma.task.findUniqueOrThrow({ where: { id } })).contractDigest).toBeNull();
  });

  it('rolls the pointer back when the audit write fails', async () => {
    const id = await create();
    jest.spyOn(activity, 'log').mockRejectedValueOnce(new Error('fixture audit failure'));
    await patch(id, { contractDigest: DIGEST_A, expectedContractDigest: null }).expect(500);
    expect((await prisma.task.findUniqueOrThrow({ where: { id } })).contractDigest).toBeNull();
    expect(await prisma.activityLog.count({ where: { taskId: id, action: CONTRACT_BINDING_ACTION } })).toBe(0);
  });

  it('refuses JWT and absent authentication on this agent-only mutation', async () => {
    const id = await create();
    await patch(id, { contractDigest: DIGEST_A, expectedContractDigest: null }, authSvc.signAccess(userId)).expect(403);
    await http().patch(`/tasks/${id}/contract`).send({ contractDigest: DIGEST_A, expectedContractDigest: null }).expect(401);
  });

  it.each([
    { contractDigest: DIGEST_A },
    { expectedContractDigest: null },
    { contractDigest: `${DIGEST_A}\n`, expectedContractDigest: null },
    { contractDigest: DIGEST_A, expectedContractDigest: 'sha256:bad' },
    { contractDigest: DIGEST_A, expectedContractDigest: null, actorId: 'forged' },
  ])('refuses malformed/missing/extra input with no write: %j', async body => {
    const id = await create();
    await patch(id, body).expect(400);
    expect((await prisma.task.findUniqueOrThrow({ where: { id } })).contractDigest).toBeNull();
  });
});
