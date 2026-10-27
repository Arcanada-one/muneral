import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { ActivityModule } from '../src/activity/activity.module.js';
import { AgentsModule } from '../src/agents/agents.module.js';
import { TasksModule } from '../src/tasks/tasks.module.js';
import { WorkspacesModule } from '../src/workspaces/workspaces.module.js';
import { WorkspacesService } from '../src/workspaces/workspaces.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KanbanService } from '../src/ws/kanban.service.js';
import { createDisposablePostgres } from './support/disposable-postgres.js';

@Module({ imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule, WorkspacesModule] })
class FixtureModule {}

// Regressions for two defects found by a candidate-local route canary:
//  - e4d18373: WorkspaceMemberGuard read `req.actor`, which ActorInterceptor
//    sets only after guards run, so every caller (the owner included) got
//    403 "Human authentication required" on the five member routes.
//  - c23de150: DELETE /tasks/:taskId deleted the task and then wrote a
//    `task:deleted` activity row referencing it -> P2003
//    activity_log_task_id_fkey -> 500.
describe('Workspace member routes and task delete (real HTTP/PostgreSQL)', () => {
  const pg = createDisposablePostgres('workspace-members-task-delete');
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let ownerId: string;
  let ownerToken: string;
  let outsiderToken: string;
  let agentKey: string;
  let workspaceId: string;
  let projectId: string;
  let otherUserId: string;
  const http = () => supertest(app.getHttpServer());

  beforeAll(async () => {
    await pg.start();
    process.env.DATABASE_URL = pg.url();
    const mod = await Test.createTestingModule({ imports: [FixtureModule] })
      .overrideProvider(KanbanService).useValue({ notify() {} }).compile();
    app = mod.createNestApplication();
    app.useLogger(false);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = mod.get(PrismaService);
    auth = mod.get(AuthService);

    const owner = await prisma.user.create({ data: { name: 'Synthetic owner' } });
    const outsider = await prisma.user.create({ data: { name: 'Synthetic outsider' } });
    const other = await prisma.user.create({ data: { name: 'Synthetic invitee' } });
    ownerId = owner.id;
    otherUserId = other.id;
    ownerToken = auth.signAccess(owner.id);
    outsiderToken = auth.signAccess(outsider.id);
    const ws = await mod.get(WorkspacesService).create(owner.id, { slug: randomUUID(), name: 'Synthetic workspace' });
    workspaceId = ws.id;
    // The outsider owns a different workspace, so they are a real, authenticated
    // human who is simply not a member of `workspaceId`.
    await mod.get(WorkspacesService).create(outsider.id, { slug: randomUUID(), name: 'Synthetic other workspace' });
    projectId = (await prisma.project.create({ data: { workspaceId, slug: randomUUID(), name: 'Synthetic project' } })).id;
    const agent = await prisma.agent.create({ data: { workspaceId, name: 'Synthetic member agent' } });
    agentKey = (await auth.createApiKey(agent.id, 'Synthetic member-route refusal')).key;
  }, 120_000);

  afterAll(async () => { if (app) await app.close(); await pg.stop(); }, 120_000);

  describe('e4d18373: workspace member routes', () => {
    it('lets the owner read the workspace and its members', async () => {
      const one = await http().get(`/workspaces/${workspaceId}`).auth(ownerToken, { type: 'bearer' }).expect(200);
      expect(one.body.id).toBe(workspaceId);
      const members = await http().get(`/workspaces/${workspaceId}/members`).auth(ownerToken, { type: 'bearer' }).expect(200);
      expect(members.body.map((m: { userId: string }) => m.userId)).toEqual([ownerId]);
    });

    it('lets the owner add, re-role and remove a member', async () => {
      await http().post(`/workspaces/${workspaceId}/members/${otherUserId}`).auth(ownerToken, { type: 'bearer' }).expect(201);
      const patched = await http().patch(`/workspaces/${workspaceId}/members/${otherUserId}/role`)
        .auth(ownerToken, { type: 'bearer' }).send({ role: 'manager' }).expect(200);
      expect(patched.body.role).toBe('manager');
      await http().delete(`/workspaces/${workspaceId}/members/${otherUserId}`).auth(ownerToken, { type: 'bearer' }).expect(204);
      expect(await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: otherUserId } },
      })).toBeNull();
    });

    const routes: Array<[string, (t: supertest.Agent) => supertest.Test]> = [
      ['GET /workspaces/:id', (t) => t.get(`/workspaces/${workspaceId}`)],
      ['GET /workspaces/:id/members', (t) => t.get(`/workspaces/${workspaceId}/members`)],
      ['POST /workspaces/:id/members/:userId', (t) => t.post(`/workspaces/${workspaceId}/members/${otherUserId}`)],
      ['PATCH /workspaces/:id/members/:userId/role', (t) => t.patch(`/workspaces/${workspaceId}/members/${otherUserId}/role`).send({ role: 'viewer' })],
      ['DELETE /workspaces/:id/members/:userId', (t) => t.delete(`/workspaces/${workspaceId}/members/${ownerId}`)],
    ];

    it.each(routes)('%s still refuses an authenticated non-member (403)', async (_name, call) => {
      const r = await call(http()).auth(outsiderToken, { type: 'bearer' });
      expect(r.status).toBe(403);
      expect(r.body.message).toBe('Not a member of this workspace');
    });

    it.each(routes)('%s still refuses an agent API key of this workspace (403)', async (_name, call) => {
      const r = await call(http()).auth(agentKey, { type: 'bearer' });
      expect(r.status).toBe(403);
    });

    it.each(routes)('%s still refuses an anonymous caller (401)', async (_name, call) => {
      await call(http()).expect(401);
    });

    it('left membership unchanged after every refused call', async () => {
      const rows = await prisma.workspaceMember.findMany({ where: { workspaceId } });
      expect(rows.map((m) => [m.userId, m.role])).toEqual([[ownerId, 'owner']]);
    });
  });

  describe('c23de150: DELETE /tasks/:taskId', () => {
    const makeTask = (title: string) => prisma.task.create({
      data: { projectId, title, status: 'todo', actorType: 'human', createdById: ownerId },
    });

    it('deletes the task and keeps a detached task:deleted audit row', async () => {
      const title = `Synthetic delete ${randomUUID()}`;
      const task = await makeTask(title);
      await http().delete(`/tasks/${task.id}`).auth(ownerToken, { type: 'bearer' }).expect(204);

      expect(await prisma.task.findUnique({ where: { id: task.id } })).toBeNull();
      const audits = await prisma.activityLog.findMany({ where: { workspaceId, action: 'task:deleted', actorId: ownerId } });
      const mine = audits.filter((a) => (a.payload as { title?: string } | null)?.title === title);
      expect(mine).toHaveLength(1);
      expect(mine[0].taskId).toBeNull();
      expect(mine[0].actorType).toBe('human');
    });

    it('refuses a task with execution history with 409 and leaves no orphan audit row', async () => {
      const title = `Synthetic restricted ${randomUUID()}`;
      const task = await makeTask(title);
      await prisma.taskExecutionState.create({
        data: { taskId: task.id, aggregateVersion: 1n, retryBudget: 0, retryCount: 0, retryBackoffMs: 0n },
      });
      await http().delete(`/tasks/${task.id}`).auth(ownerToken, { type: 'bearer' }).expect(409);

      expect(await prisma.task.findUnique({ where: { id: task.id } })).not.toBeNull();
      const audits = await prisma.activityLog.findMany({ where: { workspaceId, action: 'task:deleted' } });
      expect(audits.filter((a) => (a.payload as { title?: string } | null)?.title === title)).toHaveLength(0);
    });
  });
});
