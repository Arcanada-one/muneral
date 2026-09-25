/**
 * A2-379 (e2e) — `POST /sync/datarim/:projectId/import` under the `'project'`
 * scope plus SyncService's per-task check, over real HTTP against the
 * DATABASE_URL database.
 *
 * The hole this closes, found by A2-378 and measured on the pre-fix bytes: the
 * route ran behind `ApiKeyGuard` alone, and `SyncService.importDatarim` matched
 * tasks by title and wrote with raw Prisma. Any valid key of any workspace
 * could name another workspace's project and set the status of any task in it
 * to any value — `todo → done` in one line, no TASK_TRANSITIONS, no activity
 * row — and every task it created was recorded as a HUMAN with no creator.
 *
 * Both halves are proved here. Refused, with the task and the log untouched:
 * another workspace's key (404), an in-workspace key with no relation to the
 * task, a reviewer and a lead (403, also on the read route), a move the state
 * machine forbids (400), a title that matches two tasks (409), and a mixed
 * import in which one line is allowed and one is not (403, NOTHING written —
 * the allowed line is not applied either). Admitted: the creator and the
 * executor move their own task along TASK_TRANSITIONS, and a new title is
 * created with the key's agent as its author; each write leaves its activity
 * row under `actor_type = 'agent'`.
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
import { SyncModule } from '../src/sync/sync.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KanbanService } from '../src/ws/kanban.service.js';

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule, SyncModule],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

describe('POST /sync/datarim/:projectId/import is scoped to the key (e2e, A2-379)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;

  let run: string;
  let userId: string;
  let workspaceId: string;
  let foreignWorkspaceId: string;
  let projectId: string;
  let foreignProjectId: string;
  let creatorAgentId: string;
  let executorAgentId: string;
  let reviewerAgentId: string;
  let leadAgentId: string;
  let creatorKey: string;
  let executorKey: string;
  let reviewerKey: string;
  let leadKey: string;
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
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    run = uuidv4().slice(0, 8);
    userId = (await prisma.user.create({ data: { name: `a2379-${run}` } })).id;
    workspaceId = (
      await prisma.workspace.create({ data: { slug: `a2379-${run}`, name: `Home ${run}`, ownerId: userId } })
    ).id;
    foreignWorkspaceId = (
      await prisma.workspace.create({
        data: { slug: `a2379-f-${run}`, name: `Foreign ${run}`, ownerId: userId },
      })
    ).id;
    projectId = (
      await prisma.project.create({ data: { workspaceId, slug: `p-${run}`, name: `P ${run}` } })
    ).id;
    foreignProjectId = (
      await prisma.project.create({
        data: { workspaceId: foreignWorkspaceId, slug: `fp-${run}`, name: `FP ${run}` },
      })
    ).id;

    const mk = async (name: string, ws = workspaceId) =>
      (await prisma.agent.create({ data: { workspaceId: ws, name: `${name}-${run}` } })).id;
    creatorAgentId = await mk('creator');
    executorAgentId = await mk('executor');
    reviewerAgentId = await mk('reviewer');
    leadAgentId = await mk('lead');
    const strangerAgentId = await mk('stranger');
    const foreignAgentId = await mk('foreign', foreignWorkspaceId);

    const key = async (agentId: string, label: string) =>
      (await authSvc.createApiKey(agentId, label)).key;
    creatorKey = await key(creatorAgentId, 'creator');
    executorKey = await key(executorAgentId, 'executor');
    reviewerKey = await key(reviewerAgentId, 'reviewer');
    leadKey = await key(leadAgentId, 'lead');
    strangerKey = await key(strangerAgentId, 'stranger');
    foreignKey = await key(foreignAgentId, 'foreign');
  });

  afterEach(async () => {
    for (const pid of [projectId, foreignProjectId]) {
      const taskIds = await prisma.task
        .findMany({ where: { projectId: pid }, select: { id: true } })
        .then((rows) => rows.map((r) => r.id));
      if (taskIds.length > 0) {
        await prisma.taskAgent.deleteMany({ where: { taskId: { in: taskIds } } });
        await prisma.agentFieldRead.deleteMany({ where: { taskId: { in: taskIds } } });
        await prisma.taskFieldState.deleteMany({ where: { taskId: { in: taskIds } } });
        await prisma.activityLog.deleteMany({ where: { taskId: { in: taskIds } } });
        // A task that recorded an execution transition cannot be deleted (append-only,
        // Restrict) — see tasks-agent-status.e2e.spec.ts. Leave those; delete the rest.
        const protectedIds = await prisma.taskExecutionTransition
          .findMany({ where: { taskId: { in: taskIds } }, select: { taskId: true }, distinct: ['taskId'] })
          .then((rows) => new Set(rows.map((r) => r.taskId)));
        const deletable = taskIds.filter((t) => !protectedIds.has(t));
        if (deletable.length > 0) await prisma.task.deleteMany({ where: { id: { in: deletable } } });
      }
      await prisma.project.delete({ where: { id: pid } }).catch(() => void 0);
    }
    for (const wid of [workspaceId, foreignWorkspaceId]) {
      await prisma.activityLog.deleteMany({ where: { workspaceId: wid } });
      await prisma.apiKey.deleteMany({ where: { agent: { workspaceId: wid } } });
      await prisma.agent.deleteMany({ where: { workspaceId: wid } });
      await prisma.workspace.delete({ where: { id: wid } }).catch(() => void 0);
    }
  });

  /** A task as the dashboard or `POST /tasks` records it. */
  const createTask = async (
    title: string,
    opts: { status?: string; createdById?: string | null; actorType?: string; project?: string } = {},
  ) =>
    prisma.task.create({
      data: {
        projectId: opts.project ?? projectId,
        title,
        status: opts.status ?? 'todo',
        priority: 'medium',
        createdById: opts.createdById === undefined ? userId : opts.createdById,
        actorType: opts.actorType ?? 'human',
      },
    });

  const agentTask = (title: string, status = 'todo') =>
    createTask(title, { status, createdById: creatorAgentId, actorType: 'agent' });

  const assign = (taskId: string, agentId: string, role: 'lead' | 'reviewer' | 'executor') =>
    prisma.taskAgent.create({ data: { taskId, agentId, role } });

  const md = (...blocks: Array<{ title: string; status?: string; priority?: string }>) =>
    blocks
      .map(
        (b) =>
          `### ${b.title}\n` +
          (b.status ? `- **Status:** ${b.status}\n` : '') +
          (b.priority ? `- **Priority:** ${b.priority}\n` : ''),
      )
      .join('\n');

  const importAs = (key: string, project: string, markdown: string) =>
    supertest(app.getHttpServer())
      .post(`/sync/datarim/${project}/import`)
      .set('Authorization', `Bearer ${key}`)
      .send({ markdown });

  const snapshot = async (taskId: string) => {
    const t = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    return { status: t.status, priority: t.priority, updatedAt: t.updatedAt.toISOString() };
  };
  const logRows = (taskId: string) => prisma.activityLog.count({ where: { taskId } });
  const taskCount = (pid: string) => prisma.task.count({ where: { projectId: pid } });

  // -------------------------------------------------------------------------
  // Refused — the task, the project and the log are untouched
  // -------------------------------------------------------------------------

  it("a key of another workspace cannot write into this workspace's project: 404, nothing written", async () => {
    const victim = await createTask(`victim-${run}`);
    const before = await snapshot(victim.id);

    const res = await importAs(
      foreignKey,
      projectId,
      md({ title: victim.title, status: 'done', priority: 'critical' }, { title: `planted-${run}` }),
    );

    expect(res.status).toBe(404);
    expect(await snapshot(victim.id)).toEqual(before);
    expect(await logRows(victim.id)).toBe(0);
    expect(await taskCount(projectId)).toBe(1);
  });

  it('an in-workspace key with no relation to the task: 403 on the import AND on the read', async () => {
    const victim = await createTask(`victim-${run}`);
    const before = await snapshot(victim.id);

    const res = await importAs(strangerKey, projectId, md({ title: victim.title, status: 'in_progress' }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('IMPORT_NOT_AUTHORISED');
    expect(JSON.stringify(res.body)).not.toContain(victim.id);

    const read = await supertest(app.getHttpServer())
      .get(`/tasks/${victim.id}`)
      .set('Authorization', `Bearer ${strangerKey}`);
    expect(read.status).toBe(403);

    expect(await snapshot(victim.id)).toEqual(before);
    expect(await logRows(victim.id)).toBe(0);
  });

  it('a match needs authority even when nothing would change', async () => {
    const victim = await createTask(`victim-${run}`);
    const res = await importAs(strangerKey, projectId, md({ title: victim.title }));
    expect(res.status).toBe(403);
    expect(await logRows(victim.id)).toBe(0);
  });

  it.each([
    ['reviewer', () => reviewerKey, () => reviewerAgentId],
    ['lead', () => leadKey, () => leadAgentId],
  ] as const)('a %s assignment does not move the card through the import: 403', async (role, keyOf, agentOf) => {
    const task = await agentTask(`t-${role}-${run}`);
    await assign(task.id, agentOf(), role);
    const before = await snapshot(task.id);

    const res = await importAs(keyOf(), projectId, md({ title: task.title, status: 'in_progress' }));

    expect(res.status).toBe(403);
    expect(await snapshot(task.id)).toEqual(before);
  });

  it('the creator is held to TASK_TRANSITIONS: todo → done is 400, the task stays todo', async () => {
    const task = await agentTask(`t-skip-${run}`);
    const res = await importAs(creatorKey, projectId, md({ title: task.title, status: 'done' }));

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('invalid status transition');
    expect((await snapshot(task.id)).status).toBe('todo');
    expect(await logRows(task.id)).toBe(0);
  });

  it('a title that matches two tasks is refused with 409 and neither is written', async () => {
    const a = await agentTask(`dup-${run}`);
    const b = await agentTask(`dup-${run}`);

    const res = await importAs(creatorKey, projectId, md({ title: `dup-${run}`, status: 'in_progress' }));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AMBIGUOUS_TITLE');
    expect((await snapshot(a.id)).status).toBe('todo');
    expect((await snapshot(b.id)).status).toBe('todo');
  });

  it('one refused line refuses the whole import: the allowed line and the new title are not applied', async () => {
    const own = await agentTask(`own-${run}`);
    const victim = await createTask(`victim-${run}`);

    const res = await importAs(
      creatorKey,
      projectId,
      md(
        { title: own.title, status: 'in_progress' },
        { title: `fresh-${run}` },
        { title: victim.title, status: 'cancelled' },
      ),
    );

    expect(res.status).toBe(403);
    expect((await snapshot(own.id)).status).toBe('todo');
    expect((await snapshot(victim.id)).status).toBe('todo');
    expect(await taskCount(projectId)).toBe(2);
    expect(await logRows(own.id)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Admitted — and attributed to the key's agent
  // -------------------------------------------------------------------------

  it.each([
    ['creator', () => creatorKey, () => creatorAgentId, false],
    ['executor', () => executorKey, () => executorAgentId, true],
  ] as const)('the %s moves its task along the map, logged as the agent', async (_who, keyOf, agentOf, needsRow) => {
    const task = await agentTask(`t-move-${run}`);
    if (needsRow) await assign(task.id, agentOf(), 'executor');

    const res = await importAs(keyOf(), projectId, md({ title: task.title, status: 'in_progress', priority: 'high' }));

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ created: 0, updated: 1, unchanged: 0 });
    const after = await snapshot(task.id);
    expect(after.status).toBe('in_progress');
    expect(after.priority).toBe('high');

    const moved = await prisma.activityLog.findMany({
      where: { taskId: task.id, action: 'task:status_changed' },
    });
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ actorType: 'agent', actorId: agentOf() });
    expect(moved[0].payload).toEqual({ from: 'todo', to: 'in_progress' });
  });

  it('a new title is created with the key agent as its author, not as a human with no creator', async () => {
    const res = await importAs(creatorKey, projectId, md({ title: `new-${run}`, status: 'todo' }));

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ created: 1, updated: 0, unchanged: 0 });
    const task = await prisma.task.findFirstOrThrow({ where: { projectId, title: `new-${run}` } });
    expect(task).toMatchObject({ actorType: 'agent', createdById: creatorAgentId });
    const createdRows = await prisma.activityLog.findMany({ where: { taskId: task.id, action: 'task:created' } });
    expect(createdRows).toHaveLength(1);
    expect(createdRows[0]).toMatchObject({ actorType: 'agent', actorId: creatorAgentId });
  });

  it('a re-import of the same state writes nothing and says so', async () => {
    const task = await agentTask(`t-same-${run}`);
    const before = await snapshot(task.id);

    const res = await importAs(creatorKey, projectId, md({ title: task.title, status: 'todo', priority: 'medium' }));

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ created: 0, updated: 0, unchanged: 1 });
    expect(await snapshot(task.id)).toEqual(before);
    expect(await logRows(task.id)).toBe(0);
  });
  // -------------------------------------------------------------------------
  // A2-383 — the import itself is on the record, not just its per-task rows
  // -------------------------------------------------------------------------

  const importRows = () =>
    prisma.activityLog.findMany({ where: { workspaceId, action: 'sync:datarim_imported' } });

  it('an import leaves one route-level row: who, which project, what changed (old -> new)', async () => {
    const task = await agentTask(`t-audit-${run}`);
    const kept = await agentTask(`t-kept-${run}`);

    const res = await importAs(
      creatorKey,
      projectId,
      md(
        { title: `born-${run}`, status: 'todo' },
        { title: task.title, status: 'in_progress', priority: 'high' },
        { title: kept.title, status: 'todo', priority: 'medium' },
      ),
    );
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ created: 1, updated: 1, unchanged: 1 });

    const born = await prisma.task.findFirstOrThrow({ where: { projectId, title: `born-${run}` } });
    const rows = await importRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: 'agent', actorId: creatorAgentId, taskId: null });
    expect(rows[0].payload).toEqual({
      projectId,
      outcome: 'completed',
      created: [{ taskId: born.id, title: `born-${run}`, status: 'todo' }],
      updated: [
        {
          taskId: task.id,
          status: { from: 'todo', to: 'in_progress' },
          priority: { from: 'medium', to: 'high' },
        },
      ],
      unchanged: 1,
    });
  });

  it('a refused import writes no route-level row', async () => {
    const victim = await createTask(`victim-audit-${run}`);

    const refused = await importAs(strangerKey, projectId, md({ title: victim.title, status: 'in_progress' }));
    expect(refused.status).toBe(403);
    const foreign = await importAs(foreignKey, projectId, md({ title: `x-${run}` }));
    expect(foreign.status).toBe(404);

    expect(await importRows()).toHaveLength(0);
    expect(
      await prisma.activityLog.count({ where: { workspaceId: foreignWorkspaceId, action: 'sync:datarim_imported' } }),
    ).toBe(0);
  });
});
