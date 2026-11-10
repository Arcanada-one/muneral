/**
 * MUN-0078 (e2e) — GET /tasks/:taskId/comments bodyless agent projection.
 *
 * Measured gap: GET .../comments → 404 while POST .../comments → 201 and
 * comments only appeared inside GET .../activity (action=comment).
 *
 * Proves:
 *   1. Assigned agent lists comments as { id, createdAt, actorType, actorId, body }.
 *   2. Non-comment activity never appears; raw payload / workspaceId stay out.
 *   3. Unassigned same-workspace and foreign-workspace keys get 403
 *      (same refusal shape as GET /tasks/:id under 'task' scope).
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

describe('MUN-0078 GET /tasks/:taskId/comments (e2e)', () => {
  const pg = createDisposablePostgres('mun-0078-comments');
  let app: INestApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;
  let fsSvc: TaskFieldStateService;
  const savedUrl = process.env.DATABASE_URL;

  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;
  let assignedAgentId: string;
  let assignedKey: string;
  let strangerKey: string;
  let foreignKey: string;

  beforeAll(async () => {
    await pg.start();
    process.env.DATABASE_URL = pg.url();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [TestAppModule],
    })
      .overrideProvider(KanbanService)
      .useValue({ notify: () => void 0 })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
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
    const user = await prisma.user.create({ data: { name: `mun0078-${id}` } });
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

    const assigned = await prisma.agent.create({
      data: { workspaceId, name: `assigned-${id}` },
    });
    assignedAgentId = assigned.id;
    const stranger = await prisma.agent.create({
      data: { workspaceId, name: `stranger-${id}` },
    });
    const foreign = await prisma.agent.create({
      data: { workspaceId: otherWorkspaceId, name: `foreign-${id}` },
    });
    assignedKey = (await authSvc.createApiKey(assigned.id, 'assigned')).key;
    strangerKey = (await authSvc.createApiKey(stranger.id, 'stranger')).key;
    foreignKey = (await authSvc.createApiKey(foreign.id, 'foreign')).key;
  });

  const http = () => supertest(app.getHttpServer());

  async function createTask() {
    const task = await prisma.task.create({
      data: {
        projectId,
        title: 'MUN-0078 task',
        status: 'todo',
        priority: 'medium',
        actorType: 'human',
      },
    });
    await prisma.$transaction(async (tx) => {
      await fsSvc.recompute(tx, task);
    });
    return task;
  }

  async function assign(taskId: string) {
    await prisma.taskAgent.create({
      data: { taskId, agentId: assignedAgentId, role: 'executor' },
    });
  }

  it('happy path: assigned agent lists comments as a bodyless projection', async () => {
    const task = await createTask();
    await assign(task.id);
    const posted = 'MUN-0078 comment body for the collection';

    await http()
      .post(`/tasks/${task.id}/comments`)
      .set('Authorization', `Bearer ${assignedKey}`)
      .send({ body: posted })
      .expect(201);

    // Non-comment activity must not appear in the comments collection.
    await prisma.activityLog.create({
      data: {
        workspaceId,
        taskId: task.id,
        actorType: 'agent',
        actorId: assignedAgentId,
        action: 'task:status_changed',
        payload: { from: 'todo', to: 'in_progress', secret: 'must-not-leak' },
      },
    });

    const res = await http()
      .get(`/tasks/${task.id}/comments`)
      .set('Authorization', `Bearer ${assignedKey}`)
      .expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(20);
    expect(res.body.data).toHaveLength(1);

    const row = res.body.data[0] as Record<string, unknown>;
    expect(row.body).toBe(posted);
    expect(row.actorType).toBe('agent');
    expect(row.actorId).toBe(assignedAgentId);
    expect(typeof row.id).toBe('string');
    expect(typeof row.createdAt).toBe('string');
    expect(row).not.toHaveProperty('workspaceId');
    expect(row).not.toHaveProperty('payload');
    expect(row).not.toHaveProperty('action');
    expect(row).not.toHaveProperty('secret');
  });

  it('out-of-scope: unassigned and foreign keys are refused with 403', async () => {
    const task = await createTask();
    await assign(task.id);
    await http()
      .post(`/tasks/${task.id}/comments`)
      .set('Authorization', `Bearer ${assignedKey}`)
      .send({ body: 'not for strangers' })
      .expect(201);

    await http()
      .get(`/tasks/${task.id}/comments`)
      .set('Authorization', `Bearer ${strangerKey}`)
      .expect(403);

    await http()
      .get(`/tasks/${task.id}/comments`)
      .set('Authorization', `Bearer ${foreignKey}`)
      .expect(403);

    // Same refusal shape as GET /tasks/:id for those keys.
    await http()
      .get(`/tasks/${task.id}`)
      .set('Authorization', `Bearer ${strangerKey}`)
      .expect(403);
    await http()
      .get(`/tasks/${task.id}`)
      .set('Authorization', `Bearer ${foreignKey}`)
      .expect(403);
  });
});
