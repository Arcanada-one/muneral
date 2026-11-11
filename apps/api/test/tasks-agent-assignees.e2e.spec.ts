/**
 * MUN-0081 (e2e) — GET /tasks/:taskId/assignees bodyless agent projection.
 *
 * Measured gap: POST /agents/tasks/:taskId/assign writes task_agents and
 * GET /agents/tasks lists only the caller's own rows, but GET /tasks/:id
 * exposes no assignees and GET .../assignees → 404.
 *
 * Proves:
 *   1. Assigned agent lists assignees as [{ agentId, role, assignedAt }].
 *   2. No API-key / agent-profile fields leak on the row.
 *   3. Unassigned same-workspace and foreign-workspace keys get 403
 *      (same refusal shape as GET /tasks/:id under 'task' scope).
 *   4. Missing Authorization → 401.
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
import { Reflector } from '@nestjs/core';
import { TasksController } from '../src/tasks/tasks.controller.js';

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

describe('MUN-0081 GET /tasks/:taskId/assignees (e2e)', () => {
  const pg = createDisposablePostgres('mun-0081-assignees');
  let app: INestApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;
  let fsSvc: TaskFieldStateService;
  const savedUrl = process.env.DATABASE_URL;

  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;
  let assignedAgentId: string;
  let reviewerAgentId: string;
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
    const user = await prisma.user.create({ data: { name: `mun0081-${id}` } });
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
      data: { workspaceId, name: `assigned-${id}`, model: 'secret-model', provider: 'secret-provider' },
    });
    assignedAgentId = assigned.id;
    const reviewer = await prisma.agent.create({
      data: { workspaceId, name: `reviewer-${id}` },
    });
    reviewerAgentId = reviewer.id;
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
        title: 'MUN-0081 task',
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

  it('marks the route with AgentScope(task)', () => {
    const reflector = new Reflector();
    expect(reflector.get('mun0043:agentScope', TasksController.prototype.getAssignees)).toBe('task');
  });

  it('happy path: assigned agent lists bodyless assignee rows only', async () => {
    const task = await createTask();
    await prisma.taskAgent.create({
      data: { taskId: task.id, agentId: assignedAgentId, role: 'executor' },
    });
    await prisma.taskAgent.create({
      data: { taskId: task.id, agentId: reviewerAgentId, role: 'reviewer' },
    });

    const res = await http()
      .get(`/tasks/${task.id}/assignees`)
      .set('Authorization', `Bearer ${assignedKey}`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    for (const row of res.body as Record<string, unknown>[]) {
      expect(Object.keys(row).sort()).toEqual(['agentId', 'assignedAt', 'role']);
      expect(typeof row.agentId).toBe('string');
      expect(typeof row.role).toBe('string');
      expect(typeof row.assignedAt).toBe('string');
      expect(row).not.toHaveProperty('key');
      expect(row).not.toHaveProperty('token');
      expect(row).not.toHaveProperty('name');
      expect(row).not.toHaveProperty('model');
      expect(row).not.toHaveProperty('provider');
      expect(row).not.toHaveProperty('capabilities');
    }
    const ids = (res.body as Array<{ agentId: string }>).map((r) => r.agentId).sort();
    expect(ids).toEqual([assignedAgentId, reviewerAgentId].sort());
  });

  it('out-of-scope: unassigned and foreign keys are refused with 403', async () => {
    const task = await createTask();
    await prisma.taskAgent.create({
      data: { taskId: task.id, agentId: assignedAgentId, role: 'executor' },
    });

    await http()
      .get(`/tasks/${task.id}/assignees`)
      .set('Authorization', `Bearer ${strangerKey}`)
      .expect(403);

    await http()
      .get(`/tasks/${task.id}/assignees`)
      .set('Authorization', `Bearer ${foreignKey}`)
      .expect(403);

    await http()
      .get(`/tasks/${task.id}`)
      .set('Authorization', `Bearer ${strangerKey}`)
      .expect(403);
    await http()
      .get(`/tasks/${task.id}`)
      .set('Authorization', `Bearer ${foreignKey}`)
      .expect(403);
  });

  it('missing Authorization returns 401', async () => {
    const task = await createTask();
    await prisma.taskAgent.create({
      data: { taskId: task.id, agentId: assignedAgentId, role: 'executor' },
    });
    await http().get(`/tasks/${task.id}/assignees`).expect(401);
  });
});
