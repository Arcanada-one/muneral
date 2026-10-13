import type { NestExpressApplication } from '@nestjs/platform-express';
import supertest from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { ValidationPipe, Module } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { TasksModule } from '../src/tasks/tasks.module.js';
import { AgentsModule } from '../src/agents/agents.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { ActivityModule } from '../src/activity/activity.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KanbanService } from '../src/ws/kanban.service.js';
import { ActivityService } from '../src/activity/activity.service.js';
import { TasksService } from '../src/tasks/tasks.service.js';
import { jest as runtime } from '@jest/globals';
const jest = runtime as unknown as typeof globalThis.jest;

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

describe('Assigned-agent checklist (MUN-ARTIFACTS, e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;

  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;
  let executorAgentId: string;
  let executorKey: string;
  let strangerKey: string;
  let foreignKey: string;
  let foreignAgentId: string;
  let creatorAgentId: string;
  let creatorKey: string;

  const http = () => supertest(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [TestAppModule] })
      .overrideProvider(KanbanService)
      .useValue({ notify: () => void 0 })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = moduleRef.get(PrismaService);
    authSvc = moduleRef.get(AuthService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const id = uuidv4().slice(0, 8);
    const user = await prisma.user.create({ data: { name: `a2274-${id}` } });
    workspaceId = (
      await prisma.workspace.create({ data: { slug: `ws-a2274-${id}`, name: `WS ${id}`, ownerId: user.id } })
    ).id;
    otherWorkspaceId = (
      await prisma.workspace.create({ data: { slug: `ws-a2274-o-${id}`, name: `O ${id}`, ownerId: user.id } })
    ).id;
    projectId = (
      await prisma.project.create({ data: { workspaceId, slug: `proj-a2274-${id}`, name: `Proj ${id}` } })
    ).id;

    const executor = await prisma.agent.create({ data: { workspaceId, name: `executor-${id}` } });
    executorAgentId = executor.id;
    executorKey = (await authSvc.createApiKey(executor.id, 'executor')).key;

    const creator = await prisma.agent.create({ data: { workspaceId, name: `creator-${id}` } });
    creatorAgentId = creator.id;
    creatorKey = (await authSvc.createApiKey(creator.id, 'creator')).key;

    const stranger = await prisma.agent.create({ data: { workspaceId, name: `stranger-${id}` } });
    strangerKey = (await authSvc.createApiKey(stranger.id, 'stranger')).key;

    const foreign = await prisma.agent.create({ data: { workspaceId: otherWorkspaceId, name: `foreign-${id}` } });
    foreignAgentId = foreign.id;
    foreignKey = (await authSvc.createApiKey(foreign.id, 'foreign')).key;
  });

  afterEach(async () => {
    const taskIds = (await prisma.task.findMany({ where: { projectId }, select: { id: true } })).map((r) => r.id);
    if (taskIds.length > 0) {
      // Evidence rows cascade with the task; the agent FK is RESTRICT, so they
      // must go before the agents do — which the cascade takes care of here.
      await prisma.taskAgent.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.taskFieldState.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.activityLog.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    }
    await prisma.project.delete({ where: { id: projectId } }).catch(() => void 0);
    for (const wid of [workspaceId, otherWorkspaceId]) {
      await prisma.activityLog.deleteMany({ where: { workspaceId: wid } });
      await prisma.workspace.delete({ where: { id: wid } }).catch(() => void 0);
    }
  });

  /** A work item the executor agent is assigned to, created by another agent. */
  async function assignedTask() {
    const task = await prisma.task.create({
      data: {
        projectId,
        title: 'A2-274 fixture',
        status: 'in_progress',
        priority: 'medium',
        createdById: creatorAgentId,
        actorType: 'agent',
      },
    });
    await prisma.taskAgent.create({
      data: { taskId: task.id, agentId: executorAgentId, role: 'executor' },
    });
    return task;
  }

  const create = (taskId: string, key = executorKey, body: object = { text: 'Verify the stored content' }) =>
    http().post(`/tasks/${taskId}/checklist`).set('Authorization', `Bearer ${key}`).send(body);
  const list = (taskId: string, key = executorKey) =>
    http().get(`/tasks/${taskId}/checklist`).set('Authorization', `Bearer ${key}`);
  const update = (taskId: string, itemId: string, key = executorKey, body: object = { checked: true }) =>
    http().patch(`/tasks/${taskId}/checklist/${itemId}`).set('Authorization', `Bearer ${key}`).send(body);
  const remove = (taskId: string, itemId: string, key = executorKey) =>
    http().delete(`/tasks/${taskId}/checklist/${itemId}`).set('Authorization', `Bearer ${key}`);

  it('performs the complete agent read/write loop with credential-attributed atomic audit', async () => {
    const task = await assignedTask();
    const item = (await create(task.id).expect(201)).body;
    expect((await list(task.id).expect(200)).body).toEqual([expect.objectContaining({ id: item.id, checked: false })]);
    expect((await update(task.id, item.id).expect(200)).body.checked).toBe(true);
    await remove(task.id, item.id).expect(204);
    expect((await list(task.id).expect(200)).body).toEqual([]);
    const rows = await prisma.activityLog.findMany({ where: { taskId: task.id, action: { startsWith: 'task:checklist_' } } });
    expect(rows).toHaveLength(3);
    expect(rows.map(row => row.action).sort()).toEqual(['task:checklist_added', 'task:checklist_removed', 'task:checklist_updated']);
    for (const row of rows) {
      expect(row).toMatchObject({ actorType: 'agent', actorId: executorAgentId, workspaceId });
      expect(row.payload).toMatchObject({ itemId: item.id });
    }
    expect(rows.find(row => row.action === 'task:checklist_removed')?.payload).toMatchObject({ checked: true });
  });

  it.each(['lead', 'reviewer', 'executor'])('admits an assigned %s without granting task-status authority', async role => {
    const task = await assignedTask();
    await prisma.taskAgent.update({ where: { taskId_agentId: { taskId: task.id, agentId: executorAgentId } }, data: { role } });
    await create(task.id).expect(201);
    await list(task.id).expect(200);
    if (role !== 'executor') {
      const status = await http().patch(`/tasks/${task.id}/status`).set('Authorization', `Bearer ${executorKey}`).send({ status: 'done' });
      expect([403, 404]).toContain(status.status);
    }
  });

  it('refuses an unassigned creator, stranger and foreign-workspace assignment on all checklist routes', async () => {
    const task = await assignedTask();
    const item = await prisma.taskChecklist.create({ data: { taskId: task.id, text: 'Existing item' } });
    await prisma.taskAgent.create({ data: { taskId: task.id, agentId: foreignAgentId, role: 'executor' } });
    for (const key of [creatorKey, strangerKey, foreignKey]) {
      for (const call of [() => create(task.id, key), () => list(task.id, key), () => update(task.id, item.id, key), () => remove(task.id, item.id, key)]) {
        expect([403, 404]).toContain((await call()).status);
      }
    }
    expect(await prisma.taskChecklist.count({ where: { taskId: task.id } })).toBe(1);
    expect(await prisma.activityLog.count({ where: { taskId: task.id } })).toBe(0);
  });

  it('never changes a checklist item belonging to another task', async () => {
    const task = await assignedTask();
    const other = await assignedTask();
    const item = await prisma.taskChecklist.create({ data: { taskId: other.id, text: 'Other task' } });
    await update(task.id, item.id).expect(404);
    await remove(task.id, item.id).expect(404);
    expect(await prisma.taskChecklist.findUnique({ where: { id: item.id } })).toMatchObject({ checked: false, taskId: other.id });
    expect(await prisma.activityLog.count({ where: { taskId: task.id } })).toBe(0);
  });

  it('rechecks assignment after route admission and before the database write', async () => {
    const task = await assignedTask();
    const service = app.get(TasksService);
    const original = service.addChecklistItem.bind(service);
    const spy = jest.spyOn(service, 'addChecklistItem').mockImplementationOnce(async (...args) => {
      await prisma.taskAgent.delete({ where: { taskId_agentId: { taskId: task.id, agentId: executorAgentId } } });
      return original(...args);
    });
    try {
      await create(task.id).expect(403);
      expect(await prisma.taskChecklist.count({ where: { taskId: task.id } })).toBe(0);
      expect(await prisma.activityLog.count({ where: { taskId: task.id } })).toBe(0);
    } finally { spy.mockRestore(); }
  });

  it('validates boolean updates and refuses body-supplied actor attribution', async () => {
    const task = await assignedTask();
    const item = (await create(task.id).expect(201)).body;
    await update(task.id, item.id, executorKey, { checked: 'false' }).expect(400);
    await update(task.id, item.id, executorKey, {}).expect(400);
    await update(task.id, item.id, executorKey, { checked: true, actorId: creatorAgentId }).expect(400);
    await create(task.id, executorKey, { text: 'Forged attribution', actorType: 'human' }).expect(400);
    expect(await prisma.taskChecklist.findUnique({ where: { id: item.id } })).toMatchObject({ checked: false });
  });

  it.each(['add', 'update', 'delete'] as const)('rolls back agent checklist %s if actor audit fails', async operation => {
    const task = await assignedTask();
    const item = operation === 'add' ? null : await prisma.taskChecklist.create({ data: { taskId: task.id, text: 'Rollback', checked: false } });
    const spy = jest.spyOn(app.get(ActivityService), 'log').mockRejectedValueOnce(new Error('Synthetic audit refusal'));
    try {
      if (operation === 'add') await create(task.id).expect(500);
      else if (operation === 'update') await update(task.id, item!.id).expect(500);
      else await remove(task.id, item!.id).expect(500);
      const rows = await prisma.taskChecklist.findMany({ where: { taskId: task.id } });
      if (operation === 'add') expect(rows).toHaveLength(0);
      else { expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ id: item!.id, checked: false }); }
      expect(await prisma.activityLog.count({ where: { taskId: task.id } })).toBe(0);
    } finally { spy.mockRestore(); }
  });

  it('preserves the human member loop and refuses a JWT from outside the workspace', async () => {
    const task = await assignedTask();
    const owner = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    await prisma.workspaceMember.create({ data: { workspaceId, userId: owner.ownerId, role: 'owner' } });
    const jwt = authSvc.signAccess(owner.ownerId);
    const item = (await create(task.id, jwt).expect(201)).body;
    await list(task.id, jwt).expect(200);
    await update(task.id, item.id, jwt).expect(200);
    await remove(task.id, item.id, jwt).expect(204);
    const rows = await prisma.activityLog.findMany({ where: { taskId: task.id } });
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toMatchObject({ actorType: 'human', actorId: owner.ownerId });
    const stranger = await prisma.user.create({ data: { name: 'Outside checklist JWT' } });
    const foreignJwt = authSvc.signAccess(stranger.id);
    await create(task.id, foreignJwt).expect(403);
    expect([403, 404]).toContain((await list(task.id, foreignJwt)).status);
    await prisma.user.delete({ where: { id: stranger.id } });
  });
});
