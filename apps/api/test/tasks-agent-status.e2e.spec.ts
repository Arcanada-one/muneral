/**
 * MUN-0050 (e2e) — `PATCH /tasks/:taskId/status` under the `'task-status'`
 * scope, over real HTTP against the DATABASE_URL database.
 *
 * The gap this closes, measured live on 2026-09-13: every work item the fleet
 * registered through `POST /tasks` with its own key (MUN-0045) answered 403
 * "not assigned" to that same key on the status route, because `'task'`
 * (MUN-0043) demands a `task_agents` row and creation writes none. The cards
 * stayed `todo` after their work was merged and deployed, and the board said
 * nothing had been done.
 *
 * Both halves are proved: the creator and the executor get in and the move is
 * attributed to the agent; a lead, a reviewer, a stranger, another workspace's
 * agent and a forged creator row do not, and the row is untouched. The state
 * machine binds the key as it binds a JWT (no `done` without `review`), and a
 * repeat of a move already made answers 200 `idempotent: true` and writes
 * nothing at all — no activity row, no field-state move, no execution
 * transition.
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
import { ActivityService } from '../src/activity/activity.service.js';
import { jest } from '@jest/globals';
import { TaskFieldStateService } from '../src/tasks/field-state/task-field-state.service.js';

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

const STATUS_ACTION = 'task:status_changed';

describe('PATCH /tasks/:taskId/status with an agent key — creator or executor (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;
  let fsSvc: TaskFieldStateService;

  let userId: string;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;
  let creatorAgentId: string;
  let executorAgentId: string;
  let leadAgentId: string;
  let reviewerAgentId: string;
  let foreignAgentId: string;
  let creatorKey: string;
  let executorKey: string;
  let leadKey: string;
  let reviewerKey: string;
  let strangerKey: string;
  let foreignKey: string;

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
    fsSvc = moduleRef.get(TaskFieldStateService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const id = uuidv4().slice(0, 8);
    const user = await prisma.user.create({ data: { name: `mun0050-${id}` } });
    userId = user.id;
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
    executorAgentId = await mk('executor');
    leadAgentId = await mk('lead');
    reviewerAgentId = await mk('reviewer');
    const strangerAgentId = await mk('stranger');
    foreignAgentId = await mk('foreign', otherWorkspaceId);

    const key = async (agentId: string, label: string) =>
      (await authSvc.createApiKey(agentId, label)).key;
    creatorKey = await key(creatorAgentId, 'creator');
    executorKey = await key(executorAgentId, 'executor');
    leadKey = await key(leadAgentId, 'lead');
    reviewerKey = await key(reviewerAgentId, 'reviewer');
    strangerKey = await key(strangerAgentId, 'stranger');
    foreignKey = await key(foreignAgentId, 'foreign');
  });

  afterEach(async () => {
    const taskIds = await prisma.task
      .findMany({ where: { projectId }, select: { id: true } })
      .then((rows) => rows.map((r) => r.id));
    if (taskIds.length > 0) {
      await prisma.taskAgent.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.agentFieldRead.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.taskFieldState.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.activityLog.deleteMany({ where: { taskId: { in: taskIds } } });
      // MUN-0040: a task that ever recorded an execution transition can never
      // be deleted (append-only trigger, transitive Restrict) — by design, see
      // tasks-agent-scope.e2e.spec.ts. Leave those; delete the rest.
      const protectedTaskIds = await prisma.taskExecutionTransition
        .findMany({ where: { taskId: { in: taskIds } }, select: { taskId: true }, distinct: ['taskId'] })
        .then((rows) => new Set(rows.map((r) => r.taskId)));
      const deletable = taskIds.filter((t) => !protectedTaskIds.has(t));
      if (deletable.length > 0) await prisma.task.deleteMany({ where: { id: { in: deletable } } });
    }
    await prisma.project.delete({ where: { id: projectId } }).catch(() => void 0);
    for (const wid of [workspaceId, otherWorkspaceId]) {
      await prisma.activityLog.deleteMany({ where: { workspaceId: wid } });
      // The keys and agents go EXPLICITLY, not by cascade: when a protected
      // task keeps the project (and so the workspace) alive, the cascade never
      // runs, and every key left behind is one more bcrypt comparison on every
      // later request — `AuthService.validateApiKey` compares the presented
      // key against every non-revoked key in the table (measured: a reused
      // database grew from 2 s to 30 s per test across mutant runs).
      await prisma.apiKey.deleteMany({ where: { agent: { workspaceId: wid } } });
      await prisma.agent.deleteMany({ where: { workspaceId: wid } });
      await prisma.workspace.delete({ where: { id: wid } }).catch(() => void 0);
    }
  });

  /** A task as `POST /tasks` records it: authorship from the credential. */
  async function createTask(
    overrides: { createdById?: string | null; actorType?: string; status?: string } = {},
  ) {
    const task = await prisma.task.create({
      data: {
        projectId,
        title: 'MUN-0050 task',
        status: overrides.status ?? 'todo',
        priority: 'medium',
        createdById: overrides.createdById === undefined ? creatorAgentId : overrides.createdById,
        actorType: overrides.actorType ?? 'agent',
      },
    });
    await prisma.$transaction(async (tx) => {
      await fsSvc.recompute(tx, task);
    });
    return task;
  }

  /** A task a HUMAN created (the shape every imported / dashboard card has). */
  const humanTask = (status = 'todo') => createTask({ createdById: userId, actorType: 'human', status });

  async function assign(taskId: string, agentId: string, role: 'lead' | 'reviewer' | 'executor') {
    await prisma.taskAgent.create({ data: { taskId, agentId, role } });
  }

  const patch = (taskId: string, key: string, status: string) =>
    supertest(app.getHttpServer())
      .patch(`/tasks/${taskId}/status`)
      .set('Authorization', `Bearer ${key}`)
      .send({ status });

  const statusRows = (taskId: string) =>
    prisma.activityLog.findMany({
      where: { taskId, action: STATUS_ACTION },
      orderBy: { createdAt: 'asc' },
    });

  const fieldState = (taskId: string) =>
    prisma.taskFieldState
      .findMany({ where: { taskId }, orderBy: { fieldName: 'asc' } })
      .then((rows) => rows.map((r) => ({ f: r.fieldName, h: r.hash, v: r.version.toString() })));

  // -------------------------------------------------------------------------
  // Who gets in
  // -------------------------------------------------------------------------

  it('lets the agent that CREATED the task move it, attributed to that agent, with no assignment row', async () => {
    const task = await createTask();
    expect(await prisma.taskAgent.count({ where: { taskId: task.id } })).toBe(0);

    const res = await patch(task.id, creatorKey, 'in_progress').expect(200);
    expect(res.body.status).toBe('in_progress');
    expect(res.body.idempotent).toBeUndefined();

    const rows = await statusRows(task.id);
    expect(rows).toHaveLength(1);
    // Recorded as the AGENT's move — the id from the credential, never the body.
    expect(rows[0].actorType).toBe('agent');
    expect(rows[0].actorId).toBe(creatorAgentId);
    expect(rows[0].payload).toEqual({ from: 'todo', to: 'in_progress' });
  });

  it('lets an agent assigned as EXECUTOR move a task it did not create, attributed to that agent', async () => {
    const task = await humanTask();
    await assign(task.id, executorAgentId, 'executor');

    const res = await patch(task.id, executorKey, 'in_progress').expect(200);
    expect(res.body.status).toBe('in_progress');

    const rows = await statusRows(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].actorType).toBe('agent');
    expect(rows[0].actorId).toBe(executorAgentId);
  });

  // -------------------------------------------------------------------------
  // Who does not
  // -------------------------------------------------------------------------

  it('refuses a LEAD and a REVIEWER assignment: those roles do not move the card', async () => {
    const task = await humanTask();
    await assign(task.id, leadAgentId, 'lead');
    await assign(task.id, reviewerAgentId, 'reviewer');

    await patch(task.id, leadKey, 'in_progress').expect(403);
    await patch(task.id, reviewerKey, 'in_progress').expect(403);

    const untouched = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(untouched.status).toBe('todo');
    expect(await statusRows(task.id)).toHaveLength(0);
  });

  it('refuses a stranger in the same workspace and an agent of another workspace', async () => {
    const task = await createTask();

    await patch(task.id, strangerKey, 'in_progress').expect(403);
    await patch(task.id, foreignKey, 'in_progress').expect(403);

    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('todo');
    expect(await statusRows(task.id)).toHaveLength(0);
  });

  it('the abuse cases: a creator row across the workspace boundary, or under a human actor type, is not a grant', async () => {
    // A row that names the foreign agent as creator of a task in OUR
    // workspace (however it got there): the workspace boundary still holds.
    const crossed = await createTask({ createdById: foreignAgentId, actorType: 'agent' });
    await patch(crossed.id, foreignKey, 'in_progress').expect(403);

    // A row that names the creator agent's id under actor_type 'human': the
    // pair is what POST /tasks writes for a key, and only the pair counts.
    const forged = await createTask({ createdById: creatorAgentId, actorType: 'human' });
    await patch(forged.id, creatorKey, 'in_progress').expect(403);

    for (const t of [crossed, forged]) {
      expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('todo');
    }
  });

  it('still answers 401 to no credential and to a bad key', async () => {
    const task = await createTask();
    await supertest(app.getHttpServer())
      .patch(`/tasks/${task.id}/status`)
      .send({ status: 'in_progress' })
      .expect(401);
    await patch(task.id, 'mun_sk_not_a_real_key', 'in_progress').expect(401);
  });

  // -------------------------------------------------------------------------
  // The map binds the key
  // -------------------------------------------------------------------------

  it('holds the creator to the status map: no done without review, and the three-step path is the only way', async () => {
    const task = await createTask();

    // todo -> done is not a transition anyone may make; being the creator does
    // not buy a shortcut past review.
    const refused = await patch(task.id, creatorKey, 'done').expect(400);
    expect(refused.body.message).toContain('Invalid status transition');
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('todo');
    expect(await statusRows(task.id)).toHaveLength(0);

    // review -> done is not reachable from todo either.
    await patch(task.id, creatorKey, 'review').expect(400);

    // The path the map requires, one call per transition.
    expect((await patch(task.id, creatorKey, 'in_progress').expect(200)).body.status).toBe('in_progress');
    expect((await patch(task.id, creatorKey, 'review').expect(200)).body.status).toBe('review');
    expect((await patch(task.id, creatorKey, 'done').expect(200)).body.status).toBe('done');

    const rows = await statusRows(task.id);
    expect(rows.map((r) => r.payload)).toEqual([
      { from: 'todo', to: 'in_progress' },
      { from: 'in_progress', to: 'review' },
      { from: 'review', to: 'done' },
    ]);
    expect(new Set(rows.map((r) => `${r.actorType}:${r.actorId}`))).toEqual(
      new Set([`agent:${creatorAgentId}`]),
    );
  });

  it('lets the creator park a card as blocked (the PAUSED_SAFE shape) and never as done from there', async () => {
    const task = await createTask({ status: 'in_progress' });

    expect((await patch(task.id, creatorKey, 'blocked').expect(200)).body.status).toBe('blocked');
    await patch(task.id, creatorKey, 'done').expect(400);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('blocked');
  });

  // -------------------------------------------------------------------------
  // Idempotent repeat
  // -------------------------------------------------------------------------

  it('answers a repeat of a move already made with 200 idempotent:true and writes nothing', async () => {
    const task = await createTask();

    const first = await patch(task.id, creatorKey, 'in_progress').expect(200);
    expect(first.body.idempotent).toBeUndefined();

    const stateBefore = await fieldState(task.id);
    const transitionsBefore = await prisma.taskExecutionTransition.count({ where: { taskId: task.id } });
    const updatedAtBefore = (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).updatedAt;

    const again = await patch(task.id, creatorKey, 'in_progress').expect(200);
    expect(again.body.idempotent).toBe(true);
    expect(again.body.status).toBe('in_progress');
    expect(again.body.id).toBe(task.id);

    // Nothing moved: one activity row (the real move), the field-state hashes
    // and versions (the ETag) unchanged, no second execution transition, and
    // the row itself not rewritten.
    expect(await statusRows(task.id)).toHaveLength(1);
    expect(await fieldState(task.id)).toEqual(stateBefore);
    expect(await prisma.taskExecutionTransition.count({ where: { taskId: task.id } })).toBe(transitionsBefore);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).updatedAt).toEqual(updatedAtBefore);
  });

  it('a repeat is still refused to a key the scope does not admit — idempotency is not a bypass', async () => {
    const task = await createTask({ status: 'in_progress' });
    await patch(task.id, strangerKey, 'in_progress').expect(403);
  });

  // -------------------------------------------------------------------------
  // A JWT is unchanged
  // -------------------------------------------------------------------------

  it('a JWT moves any task as before, attributed to the human, and gets the same idempotent answer', async () => {
    const task = await humanTask();
    const jwt = authSvc.signAccess(userId);

    const res = await supertest(app.getHttpServer())
      .patch(`/tasks/${task.id}/status`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ status: 'in_progress' })
      .expect(200);
    expect(res.body.status).toBe('in_progress');

    const rows = await statusRows(task.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].actorType).toBe('human');
    expect(rows[0].actorId).toBe(userId);

    const again = await supertest(app.getHttpServer())
      .patch(`/tasks/${task.id}/status`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ status: 'in_progress' })
      .expect(200);
    expect(again.body.idempotent).toBe(true);
    expect(await statusRows(task.id)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // MUN-0051: the read/comment routes ('task') now admit the creator too
  // -------------------------------------------------------------------------

  it('MUN-0051: the creator reads and comments on its task without an assignment (was 403 under MUN-0050)', async () => {
    const task = await createTask();
    await supertest(app.getHttpServer())
      .get(`/tasks/${task.id}`)
      .set('Authorization', `Bearer ${creatorKey}`)
      .expect(200);
    await supertest(app.getHttpServer())
      .post(`/tasks/${task.id}/comments`)
      .set('Authorization', `Bearer ${creatorKey}`)
      .send({ body: 'reachable by the creator since MUN-0051' })
      .expect(201);
    // and the widening is the creator's, not everyone's
    await supertest(app.getHttpServer())
      .get(`/tasks/${task.id}`)
      .set('Authorization', `Bearer ${strangerKey}`)
      .expect(403);
  });

  it('MUN-0005: checklist mutations record authenticated actor and affected item', async () => {
    await prisma.workspaceMember.create({ data: { workspaceId, userId, role: 'owner' } });
    const task = await humanTask();
    const bearer = authSvc.signAccess(userId);
    const http = () => supertest(app.getHttpServer());
    const created = await http().post(`/tasks/${task.id}/checklist`)
      .set('Authorization', `Bearer ${bearer}`).send({ text: 'Synthetic checklist item' }).expect(201);
    const itemId = created.body.id as string;
    await http().patch(`/tasks/${task.id}/checklist/${itemId}`)
      .set('Authorization', `Bearer ${bearer}`).send({ checked: true }).expect(200);
    await http().delete(`/tasks/${task.id}/checklist/${itemId}`)
      .set('Authorization', `Bearer ${bearer}`).expect(204);
    const response = await http().get(`/tasks/${task.id}/activity`)
      .set('Authorization', `Bearer ${bearer}`).expect(200);
    const rows = response.body.data.filter((row: { action: string }) => row.action.startsWith('task:checklist_'));
    expect(rows).toHaveLength(3);
    expect(rows.map((row: { action: string }) => row.action).sort()).toEqual([
      'task:checklist_added', 'task:checklist_removed', 'task:checklist_updated',
    ]);
    for (const row of rows) {
      expect(row.actorType).toBe('human');
      expect(row.actorId).toBe(userId);
      expect(row.workspaceId).toBe(workspaceId);
      expect(row.payload.itemId).toBe(itemId);
    }
    expect(rows.find((row: { action: string }) => row.action === 'task:checklist_updated').payload.checked).toBe(true);
  });

  it.each(['add', 'update', 'delete'] as const)('MUN-0005: checklist %s rolls back when audit fails', async (operation) => {
    const task = await humanTask();
    const bearer = authSvc.signAccess(userId);
    const item = operation === 'add' ? null : await prisma.taskChecklist.create({
      data: { taskId: task.id, text: 'Synthetic rollback item', checked: false },
    });
    const writer = app.get(ActivityService);
    const spy = jest.spyOn(writer, 'log').mockRejectedValueOnce(new Error('Synthetic audit failure'));
    try {
      const http = supertest(app.getHttpServer());
      if (operation === 'add') {
        await http.post(`/tasks/${task.id}/checklist`).set('Authorization', `Bearer ${bearer}`)
          .send({ text: 'Synthetic rollback item' }).expect(500);
      } else if (operation === 'update') {
        await http.patch(`/tasks/${task.id}/checklist/${item!.id}`).set('Authorization', `Bearer ${bearer}`)
          .send({ checked: true }).expect(500);
      } else {
        await http.delete(`/tasks/${task.id}/checklist/${item!.id}`).set('Authorization', `Bearer ${bearer}`).expect(500);
      }
      const rows = await prisma.taskChecklist.findMany({ where: { taskId: task.id } });
      if (operation === 'add') expect(rows).toHaveLength(0);
      else { expect(rows).toHaveLength(1); expect(rows[0].checked).toBe(false); expect(rows[0].id).toBe(item!.id); }
      expect(await prisma.activityLog.count({ where: { taskId: task.id, action: { startsWith: 'task:checklist_' } } })).toBe(0);
    } finally { spy.mockRestore(); }
  });
  it('checklist removal audit describes the checked row actually deleted', async () => {
    const task = await humanTask();
    const bearer = authSvc.signAccess(userId);
    const item = await prisma.taskChecklist.create({data:{taskId:task.id,text:'Synthetic race',checked:false}});
    const { createRequire } = await import('node:module');
    const requireHere = createRequire(import.meta.url);
    const pgPath = createRequire(requireHere.resolve('@prisma/adapter-pg')).resolve('pg');
    const pg = (await import(pgPath)).default;
    const proto = pg.Client.prototype;
    const realQuery = proto.query;
    let armed = true;
    let reached!: () => void;
    let release!: () => void;
    const readDone = new Promise<void>(r => { reached = r; });
    const resume = new Promise<void>(r => { release = r; });
    const querySpy = jest.spyOn(proto, 'query').mockImplementation(function(this: any, ...args: any[]) {
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      if (armed && sql && /^DELETE FROM (?:"public"\.)?"task_checklists"/.test(sql)) {
        armed = false;
        reached();
        return resume.then(() => realQuery.apply(this, args));
      }
      return realQuery.apply(this, args);
    });
    const pending = supertest(app.getHttpServer()).delete(`/tasks/${task.id}/checklist/${item.id}`)
      .set('Authorization', `Bearer ${bearer}`).then(res => res);
    try {
      await Promise.race([readDone, new Promise((_, reject) => setTimeout(() => reject(new Error('delete SQL barrier timeout')), 3000))]);
      await supertest(app.getHttpServer()).patch(`/tasks/${task.id}/checklist/${item.id}`)
        .set('Authorization', `Bearer ${bearer}`).send({checked:true}).expect(200);
      expect((await prisma.taskChecklist.findUnique({where:{id:item.id}}))?.checked).toBe(true);
      release();
      expect((await pending).status).toBe(204);
      expect(await prisma.taskChecklist.findUnique({where:{id:item.id}})).toBeNull();
      const rows = await prisma.activityLog.findMany({where:{taskId:task.id,action:'task:checklist_removed'}});
      expect(rows).toHaveLength(1);
      expect((rows[0].payload as {checked:boolean}).checked).toBe(true);
    } finally { release(); await pending; querySpy.mockRestore(); }
  });

  it('MUN-0005: DELETE /tasks/:id removes the task and records who deleted it', async () => {
    await prisma.workspaceMember.create({ data: { workspaceId, userId, role: 'owner' } });
    const task = await humanTask();
    const bearer = authSvc.signAccess(userId);
    await supertest(app.getHttpServer()).delete(`/tasks/${task.id}`)
      .set('Authorization', `Bearer ${bearer}`).expect(204);
    expect(await prisma.task.findUnique({ where: { id: task.id } })).toBeNull();
    // The task row is gone, so the audit row cannot reference it: it is workspace-scoped and
    // names the deleted task in its payload.
    const rows = await prisma.activityLog.findMany({
      where: { workspaceId, action: 'task:deleted', payload: { path: ['taskId'], equals: task.id } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].taskId).toBeNull();
    expect(rows[0].actorType).toBe('human');
    expect(rows[0].actorId).toBe(userId);
    expect((rows[0].payload as { title: string }).title).toBe(task.title);
  });

  it('MUN-0005: DELETE /tasks/:id keeps the task when its audit row cannot be written', async () => {
    const task = await humanTask();
    const bearer = authSvc.signAccess(userId);
    const writer = app.get(ActivityService);
    const spy = jest.spyOn(writer, 'log').mockRejectedValueOnce(new Error('Synthetic audit failure'));
    try {
      await supertest(app.getHttpServer()).delete(`/tasks/${task.id}`)
        .set('Authorization', `Bearer ${bearer}`).expect(500);
      expect(await prisma.task.findUnique({ where: { id: task.id } })).not.toBeNull();
      expect(await prisma.activityLog.count({
        where: { workspaceId, action: 'task:deleted', payload: { path: ['taskId'], equals: task.id } },
      })).toBe(0);
    } finally { spy.mockRestore(); }
  });

});
