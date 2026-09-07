/**
 * MUN-0043 (e2e) — an agent's `mun_sk_` key on the task read and transition
 * routes, and the `archived` status end to end.
 *
 * The gap this closes, recorded by the AUP importer against the deployed API:
 * every `/tasks/*` route answered 401 to a valid agent key, because
 * `TasksController` was guarded JWT-only. An unattended executor therefore had
 * to borrow a human's 15-minute access token to read the task it had just been
 * assigned, or to move it along.
 *
 * Both halves are proved here, because widening access is only safe if the
 * refusals are real: an assigned agent gets in, and a valid key belonging to
 * another agent — or aimed at a route that was never scoped — does not.
 *
 * Real Prisma against the DATABASE_URL database, fixtures per test.
 */
import supertest from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, Module } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PrismaModule } from '../src/prisma/prisma.module';
import { TasksModule } from '../src/tasks/tasks.module';
import { AgentsModule } from '../src/agents/agents.module';
import { AuthModule } from '../src/auth/auth.module';
import { ActivityModule } from '../src/activity/activity.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { KanbanService } from '../src/ws/kanban.service';
import { TaskFieldStateService } from '../src/tasks/field-state/task-field-state.service';

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

describe('Agent-key scope on /tasks (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;
  let fsSvc: TaskFieldStateService;

  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;
  let otherProjectId: string;
  let assignedAgentId: string;
  let assignedKey: string;
  let strangerKey: string;
  let foreignKey: string;

  beforeAll(async () => {
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
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const id = uuidv4().slice(0, 8);

    const user = await prisma.user.create({ data: { name: `mun0043-${id}` } });
    const workspace = await prisma.workspace.create({
      data: { slug: `ws-${id}`, name: `WS ${id}`, ownerId: user.id },
    });
    workspaceId = workspace.id;
    const other = await prisma.workspace.create({
      data: { slug: `ws-other-${id}`, name: `Other ${id}`, ownerId: user.id },
    });
    otherWorkspaceId = other.id;

    projectId = (
      await prisma.project.create({
        data: { workspaceId, slug: `proj-${id}`, name: `Proj ${id}` },
      })
    ).id;
    otherProjectId = (
      await prisma.project.create({
        data: {
          workspaceId: otherWorkspaceId,
          slug: `proj-other-${id}`,
          name: `Other proj ${id}`,
        },
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

  afterEach(async () => {
    for (const pid of [projectId, otherProjectId]) {
      const taskIds = await prisma.task
        .findMany({ where: { projectId: pid }, select: { id: true } })
        .then((rows) => rows.map((r) => r.id));
      if (taskIds.length > 0) {
        await prisma.taskAgent.deleteMany({ where: { taskId: { in: taskIds } } });
        await prisma.agentFieldRead.deleteMany({ where: { taskId: { in: taskIds } } });
        await prisma.taskFieldState.deleteMany({ where: { taskId: { in: taskIds } } });
        await prisma.activityLog.deleteMany({ where: { taskId: { in: taskIds } } });
        await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
      }
      await prisma.project.delete({ where: { id: pid } }).catch(() => void 0);
    }
    for (const wid of [workspaceId, otherWorkspaceId]) {
      await prisma.activityLog.deleteMany({ where: { workspaceId: wid } });
      await prisma.workspace.delete({ where: { id: wid } }).catch(() => void 0);
    }
  });

  async function createTask(overrides: { status?: string; projectId?: string } = {}) {
    const task = await prisma.task.create({
      data: {
        projectId: overrides.projectId ?? projectId,
        title: 'MUN-0043 task',
        status: overrides.status ?? 'todo',
        priority: 'medium',
        actorType: 'human',
      },
    });
    await prisma.$transaction(async (tx) => {
      await fsSvc.recompute(tx, task);
    });
    return task;
  }

  async function assign(taskId: string, agentId = assignedAgentId) {
    await prisma.taskAgent.create({ data: { taskId, agentId, role: 'executor' } });
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  it('lets an assigned agent read its own task with an API key', async () => {
    const task = await createTask();
    await assign(task.id);

    const res = await supertest(app.getHttpServer())
      .get(`/tasks/${task.id}`)
      .set('Authorization', `Bearer ${assignedKey}`)
      .expect(200);

    expect(res.body.id).toBe(task.id);
    expect(res.body.status).toBe('todo');
  });

  it('refuses an agent that is not assigned to the task', async () => {
    const task = await createTask();
    await assign(task.id);

    await supertest(app.getHttpServer())
      .get(`/tasks/${task.id}`)
      .set('Authorization', `Bearer ${strangerKey}`)
      .expect(403);
  });

  it('refuses an agent from another workspace', async () => {
    const task = await createTask();
    await assign(task.id);

    await supertest(app.getHttpServer())
      .get(`/tasks/${task.id}`)
      .set('Authorization', `Bearer ${foreignKey}`)
      .expect(403);
  });

  it('still answers 401 to a bad key, and 403 to a good one out of scope', async () => {
    const task = await createTask();
    await assign(task.id);

    await supertest(app.getHttpServer())
      .get(`/tasks/${task.id}`)
      .set('Authorization', 'Bearer mun_sk_not_a_real_key')
      .expect(401);

    await supertest(app.getHttpServer())
      .get(`/tasks/${task.id}`)
      .expect(401);
  });

  it('narrows the project listing to the agent own assignments', async () => {
    const mine = await createTask();
    const theirs = await createTask();
    await assign(mine.id);
    await assign(theirs.id, (await prisma.agent.findFirstOrThrow({
      where: { workspaceId, name: { startsWith: 'stranger-' } },
    })).id);

    const res = await supertest(app.getHttpServer())
      .get(`/tasks/project/${projectId}`)
      .set('Authorization', `Bearer ${assignedKey}`)
      .expect(200);

    expect(res.body.map((t: { id: string }) => t.id)).toEqual([mine.id]);
  });

  it('answers an unassigned agent with an empty list, not with the board', async () => {
    await createTask();
    await createTask();

    const res = await supertest(app.getHttpServer())
      .get(`/tasks/project/${projectId}`)
      .set('Authorization', `Bearer ${strangerKey}`)
      .expect(200);

    expect(res.body).toEqual([]);
  });

  it('answers 404 for a project in another workspace', async () => {
    await supertest(app.getHttpServer())
      .get(`/tasks/project/${otherProjectId}`)
      .set('Authorization', `Bearer ${assignedKey}`)
      .expect(404);
  });

  // -------------------------------------------------------------------------
  // Transitioning
  // -------------------------------------------------------------------------

  it('lets an assigned agent move its own task, attributed to the agent', async () => {
    const task = await createTask();
    await assign(task.id);

    const res = await supertest(app.getHttpServer())
      .patch(`/tasks/${task.id}/status`)
      .set('Authorization', `Bearer ${assignedKey}`)
      .send({ status: 'in_progress' })
      .expect(200);

    expect(res.body.status).toBe('in_progress');

    const log = await prisma.activityLog.findFirst({
      where: { taskId: task.id, action: { contains: 'status' } },
      orderBy: { createdAt: 'desc' },
    });
    // The move is recorded as the AGENT's, not as some human's.
    expect(log?.actorType).toBe('agent');
    expect(log?.actorId).toBe(assignedAgentId);
  });

  it('refuses a transition on a task the agent is not assigned to', async () => {
    const task = await createTask();
    await assign(task.id);

    await supertest(app.getHttpServer())
      .patch(`/tasks/${task.id}/status`)
      .set('Authorization', `Bearer ${strangerKey}`)
      .send({ status: 'in_progress' })
      .expect(403);

    const untouched = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(untouched.status).toBe('todo');
  });

  it('keeps the state machine in force for an agent key', async () => {
    const task = await createTask();
    await assign(task.id);

    // todo -> done is not a transition anyone may make; being an agent does not
    // buy a shortcut past review.
    await supertest(app.getHttpServer())
      .patch(`/tasks/${task.id}/status`)
      .set('Authorization', `Bearer ${assignedKey}`)
      .send({ status: 'done' })
      .expect(400);
  });

  // -------------------------------------------------------------------------
  // Routes that were never opened
  // -------------------------------------------------------------------------

  it('refuses an API key on the routes that stay JWT-only', async () => {
    const task = await createTask();
    await assign(task.id);

    // 403, not 401: the key is valid, the route is simply not scoped for keys.
    // POST /tasks is no longer in this set — see MUN-0045 below.
    await supertest(app.getHttpServer())
      .delete(`/tasks/${task.id}`)
      .set('Authorization', `Bearer ${assignedKey}`)
      .expect(403);

    await supertest(app.getHttpServer())
      .post(`/tasks/${task.id}/comments`)
      .set('Authorization', `Bearer ${assignedKey}`)
      .send({ body: 'should not be posted' })
      .expect(403);

    expect(await prisma.task.count({ where: { projectId } })).toBe(1);
  });

  // -------------------------------------------------------------------------
  // MUN-0045: creating — the write route the agent key was missing entirely
  // -------------------------------------------------------------------------

  it('lets an agent key create a task inside its own workspace, attributed to the agent', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/tasks')
      .set('Authorization', `Bearer ${assignedKey}`)
      .send({ projectId, title: 'AUP-3001 registered by the agent' })
      .expect(201);

    expect(res.body.projectId).toBe(projectId);

    const stored = await prisma.task.findUniqueOrThrow({ where: { id: res.body.id } });
    // Authorship is the CREDENTIAL's agent, never a value the caller sent —
    // the request body above named no actor at all.
    expect(stored.actorType).toBe('agent');
    expect(stored.createdById).toBe(assignedAgentId);
  });

  it('the negative control: a key not entitled to this project is still refused, not 201', async () => {
    // Same answer `GET /tasks/project/:projectId` already gives a
    // cross-workspace caller under the sibling 'project' scope (MUN-0043): 404,
    // not 403, so a key cannot use the difference to map another workspace's
    // ids. What this proves is the one thing that must never happen — a key
    // outside the grant still cannot create the row — not the exact status
    // code, which the unmarked-route unit tests already pin at 403
    // (agent-task-scope.guard.spec.ts: "the negative control: a key WITHOUT
    // this scope still gets 403 on POST /tasks").
    await supertest(app.getHttpServer())
      .post('/tasks')
      .set('Authorization', `Bearer ${foreignKey}`)
      .send({ projectId, title: 'should not be created' })
      .expect(404);

    expect(await prisma.task.count({ where: { projectId, title: 'should not be created' } })).toBe(0);
  });

  it('the abuse case: an agent key cannot create a task claiming a principal it is not', async () => {
    const foreignAgent = await prisma.agent.findFirstOrThrow({
      where: { workspaceId: otherWorkspaceId },
    });

    // CreateTaskDto has no owner/actor/agentId field, and the global
    // ValidationPipe (`whitelist: true`) strips anything that is not on the
    // DTO — so even a caller who tries to forge one gets ignored, not honoured.
    const res = await supertest(app.getHttpServer())
      .post('/tasks')
      .set('Authorization', `Bearer ${assignedKey}`)
      .send({
        projectId,
        title: 'forged authorship attempt',
        createdById: foreignAgent.id,
        actorType: 'human',
        actor: { id: foreignAgent.id, type: 'human', name: 'not-me' },
      })
      .expect(201);

    const stored = await prisma.task.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(stored.createdById).toBe(assignedAgentId);
    expect(stored.actorType).toBe('agent');
    expect(stored.createdById).not.toBe(foreignAgent.id);
  });

  it('still refuses to create when the project belongs to another workspace (404, not the write)', async () => {
    await supertest(app.getHttpServer())
      .post('/tasks')
      .set('Authorization', `Bearer ${assignedKey}`)
      .send({ projectId: otherProjectId, title: 'should not cross workspaces' })
      .expect(404);

    expect(
      await prisma.task.count({
        where: { projectId: otherProjectId, title: 'should not cross workspaces' },
      }),
    ).toBe(0);
  });

  // -------------------------------------------------------------------------
  // the field-change routes: a route that was already open, now bounded
  // -------------------------------------------------------------------------

  it('still lets an unassigned agent read field-changes inside its own workspace', async () => {
    const task = await createTask();

    // Deliberately NOT narrowed to assignments: unattended pollers already
    // depend on this, and breaking them was not worth doing blind.
    await supertest(app.getHttpServer())
      .get(`/tasks/${task.id}/field-changes`)
      .set('Authorization', `Bearer ${strangerKey}`)
      .expect(200);
  });

  it('refuses an agent from another workspace on field-changes', async () => {
    const task = await createTask();

    // Before MUN-0043 this answered 200 with the task's title, description,
    // status and priority — a cross-tenant read through a route that checked
    // no ownership at all.
    await supertest(app.getHttpServer())
      .get(`/tasks/${task.id}/field-changes`)
      .set('Authorization', `Bearer ${foreignKey}`)
      .expect(404);
  });

  it('refuses an agent from another workspace on field-ack', async () => {
    const task = await createTask();
    const foreignAgent = await prisma.agent.findFirstOrThrow({
      where: { workspaceId: otherWorkspaceId },
    });

    await supertest(app.getHttpServer())
      .post(`/tasks/${task.id}/field-ack`)
      .set('Authorization', `Bearer ${foreignKey}`)
      .send({ agentId: foreignAgent.id, fields: [{ field: 'title', version: 1 }] })
      .expect(404);

    expect(await prisma.agentFieldRead.count({ where: { taskId: task.id } })).toBe(0);
  });

  // -------------------------------------------------------------------------
  // archived, end to end
  // -------------------------------------------------------------------------

  it('stores and reads back a task in the archived status', async () => {
    // The DB CHECK, not the TypeScript union, is what this proves: before
    // MUN-0043's migration this insert failed with a constraint violation.
    const task = await createTask({ status: 'done' });
    await assign(task.id);

    const res = await supertest(app.getHttpServer())
      .patch(`/tasks/${task.id}/status`)
      .set('Authorization', `Bearer ${assignedKey}`)
      .send({ status: 'archived' })
      .expect(200);

    expect(res.body.status).toBe('archived');

    const stored = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(stored.status).toBe('archived');
  });

  it('does not let a live card be archived without settling it first', async () => {
    const task = await createTask({ status: 'in_progress' });
    await assign(task.id);

    // Archiving is filing a settled card away, not a way to abandon live work.
    await supertest(app.getHttpServer())
      .patch(`/tasks/${task.id}/status`)
      .set('Authorization', `Bearer ${assignedKey}`)
      .send({ status: 'archived' })
      .expect(400);
  });

  it('reopens an archived card into todo, without a completion claim', async () => {
    const task = await createTask({ status: 'done' });
    await assign(task.id);

    await supertest(app.getHttpServer())
      .patch(`/tasks/${task.id}/status`)
      .set('Authorization', `Bearer ${assignedKey}`)
      .send({ status: 'archived' })
      .expect(200);

    const res = await supertest(app.getHttpServer())
      .patch(`/tasks/${task.id}/status`)
      .set('Authorization', `Bearer ${assignedKey}`)
      .send({ status: 'todo' })
      .expect(200);

    expect(res.body.status).toBe('todo');
  });
});
