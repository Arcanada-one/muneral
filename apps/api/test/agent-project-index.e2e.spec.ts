/**
 * MUN-0052 (e2e) — the project task index for agent keys holding a read grant
 * (DEC-AUP-0029), over real HTTP against the DATABASE_URL database.
 *
 * `GET /tasks/project/:projectId/index` answers every task of the project as
 * ids, status and title hashes to a key named for that project in the grant
 * list, and a 404 — the answer an unknown project gets — to every other key.
 * The grant opens that one route and nothing else: every write route, and every
 * read route that keeps the own slice, answers a granted key exactly as before
 * on a task it neither created nor is assigned to. Each read writes one
 * activity row whose id is in the answer.
 */
import supertest from 'supertest';
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
import { PROJECT_READ_GRANTS, GRANT_RENEWAL_LEAD_DAYS } from '../src/auth/project-read-grants.js';
import type { ProjectReadGrantEntry } from '../src/auth/project-read-grants.js';
import { PROJECT_INDEX_COUNTED, PROJECT_INDEX_READ_ACTION } from '../src/tasks/tasks.service.js';

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

/** The exact keys of one index row (DEC-AUP-0029 R3). */
const ROW_KEYS = ['actorType', 'createdAt', 'id', 'parentId', 'priority', 'status', 'titleSha256', 'updatedAt'];
const ENVELOPE_KEYS = ['auditEventId', 'auditReadCount', 'counted', 'generatedAt', 'grant', 'projectId', 'tasks', 'total'];
const FUTURE = '2999-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';

describe('MUN-0052 — project task index for granted agent keys (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;
  // The guard reads this very array through DI; each test fills it.
  const grants: ProjectReadGrantEntry[] = [];

  let userId: string;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;
  let siblingProjectId: string;
  let foreignProjectId: string;
  const ids: Record<string, string> = {};
  const keys: Record<string, string> = {};

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [TestAppModule] })
      .overrideProvider(KanbanService)
      .useValue({ notify: () => void 0 })
      .overrideProvider(PROJECT_READ_GRANTS)
      .useValue(grants)
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
    grants.length = 0;
    const id = uuidv4().slice(0, 8);
    const user = await prisma.user.create({ data: { name: `mun0052-${id}` } });
    userId = user.id;
    workspaceId = (
      await prisma.workspace.create({ data: { slug: `ws-${id}`, name: `WS ${id}`, ownerId: user.id } })
    ).id;
    otherWorkspaceId = (
      await prisma.workspace.create({ data: { slug: `ws-o-${id}`, name: `Other ${id}`, ownerId: user.id } })
    ).id;
    projectId = (await prisma.project.create({ data: { workspaceId, slug: `p-${id}`, name: `P ${id}` } })).id;
    siblingProjectId = (
      await prisma.project.create({ data: { workspaceId, slug: `s-${id}`, name: `S ${id}` } })
    ).id;
    foreignProjectId = (
      await prisma.project.create({ data: { workspaceId: otherWorkspaceId, slug: `f-${id}`, name: `F ${id}` } })
    ).id;
    for (const [name, ws] of [
      ['reader', workspaceId],
      ['creator', workspaceId],
      ['stranger', workspaceId],
      ['foreign', otherWorkspaceId],
    ] as const) {
      ids[name] = (await prisma.agent.create({ data: { workspaceId: ws, name: `${name}-${id}` } })).id;
      keys[name] = (await authSvc.createApiKey(ids[name], name)).key;
    }
  });

  afterEach(async () => {
    grants.length = 0;
    const projectIds = [projectId, siblingProjectId, foreignProjectId];
    const taskIds = await prisma.task
      .findMany({ where: { projectId: { in: projectIds } }, select: { id: true } })
      .then((rows) => rows.map((r) => r.id));
    if (taskIds.length > 0) {
      await prisma.taskChecklist.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.taskAgent.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.taskFieldState.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.activityLog.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    }
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    for (const wid of [workspaceId, otherWorkspaceId]) {
      await prisma.activityLog.deleteMany({ where: { workspaceId: wid } });
      // explicit, not by cascade: leaked keys slow every later test's legacy scan
      await prisma.apiKey.deleteMany({ where: { agent: { workspaceId: wid } } });
      await prisma.agent.deleteMany({ where: { workspaceId: wid } });
      await prisma.workspace.delete({ where: { id: wid } }).catch(() => void 0);
    }
    await prisma.user.delete({ where: { id: userId } }).catch(() => void 0);
  });

  const grant = (agent: string, project: string, until = FUTURE) =>
    grants.push({
      agentId: ids[agent],
      agentName: agent,
      projectId: project,
      until,
      decision: 'DEC-TEST',
      evidence: 'e2e',
    });

  /** A task the reader neither created nor is assigned to: another agent's. */
  async function othersTask(project = projectId, status = 'todo') {
    return prisma.task.create({
      data: {
        projectId: project,
        title: `secret-bearing title ${uuidv4()}`,
        description: 'must never reach the index',
        status,
        priority: 'high',
        createdById: ids.creator,
        actorType: 'agent',
        bootstrapStamp: { receipt: 'must never reach the index' },
      },
    });
  }

  const http = () => supertest(app.getHttpServer());
  const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });
  const index = (project: string, k: string) => http().get(`/tasks/project/${project}/index`).set(bearer(k));

  // -------------------------------------------------------------------------
  // the read the grant opens
  // -------------------------------------------------------------------------

  it('a granted key lists every task of the project — none of them its own — as ids, status and title hashes', async () => {
    grant('reader', projectId);
    const a = await othersTask(projectId, 'todo');
    const b = await othersTask(projectId, 'cancelled');
    await othersTask(siblingProjectId); // another project: never in this index

    const res = await index(projectId, keys.reader).expect(200);

    expect(Object.keys(res.body).sort()).toEqual(ENVELOPE_KEYS);
    expect(res.body.projectId).toBe(projectId);
    expect(res.body.total).toBe(2);
    expect(res.body.tasks).toHaveLength(res.body.total);
    expect(res.body.counted).toBe(PROJECT_INDEX_COUNTED);
    expect(PROJECT_INDEX_COUNTED).toBe('every task of the project, all statuses including cancelled and archived');
    // MUN-0055: `renewalDueAt` rides the read so a lapse is visible before it
    // happens — GRANT_RENEWAL_LEAD_DAYS before `until`.
    expect(res.body.grant).toEqual({
      decision: 'DEC-TEST',
      until: FUTURE,
      renewalDueAt: new Date(Date.parse(FUTURE) - GRANT_RENEWAL_LEAD_DAYS * 86_400_000).toISOString(),
    });
    expect(res.body.tasks.map((t: { id: string }) => t.id).sort()).toEqual([a.id, b.id].sort());
    for (const row of res.body.tasks) {
      expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
    }
    const rowA = res.body.tasks.find((t: { id: string }) => t.id === a.id);
    expect(rowA.titleSha256).toBe(createHash('sha256').update(a.title, 'utf8').digest('hex'));
    expect(rowA.status).toBe('todo');
    // no free text and no provenance anywhere in the answer
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('secret-bearing title');
    expect(raw).not.toContain('must never reach the index');
    expect(raw).not.toContain(ids.creator);
  });

  it('the index is exactly the project: all seven statuses, nothing from a sibling project or another workspace', async () => {
    grant('reader', projectId);
    const statuses = ['todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled', 'archived'];
    const mine = [];
    for (const status of statuses) mine.push(await othersTask(projectId, status));
    // the reader's own task is in the index too, in the same shape
    const own = await prisma.task.create({
      data: { projectId, title: 'own', status: 'todo', priority: 'low', createdById: ids.reader, actorType: 'agent' },
    });
    await othersTask(siblingProjectId, 'todo');
    await othersTask(foreignProjectId, 'todo');

    const res = await index(projectId, keys.reader).expect(200);

    expect(res.body.tasks.map((t: { id: string }) => t.id).sort()).toEqual([...mine.map((t) => t.id), own.id].sort());
    expect(res.body.tasks.map((t: { status: string }) => t.status).sort()).toEqual([...statuses, 'todo'].sort());
    expect(res.body.total).toBe(8);
  });

  it('every read writes one activity row, and the answer carries its id', async () => {
    grant('reader', projectId);
    await othersTask();

    const first = await index(projectId, keys.reader).expect(200);
    const second = await index(projectId, keys.reader).expect(200);

    expect(first.body.auditEventId).not.toBe(second.body.auditEventId);
    expect([first.body.auditReadCount, second.body.auditReadCount]).toEqual([1, 2]);
    const rows = await prisma.activityLog.findMany({
      where: { workspaceId, action: PROJECT_INDEX_READ_ACTION },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.id)).toEqual([first.body.auditEventId, second.body.auditEventId]);
    for (const row of rows) {
      expect(row.taskId).toBeNull();
      expect(row.actorType).toBe('agent');
      expect(row.actorId).toBe(ids.reader);
      expect(row.payload).toEqual({ projectId, decision: 'DEC-TEST', rowCount: 1 });
    }
  });

  // -------------------------------------------------------------------------
  // who the index refuses — all with the same 404
  // -------------------------------------------------------------------------

  it('without a live grant for THIS project the answer is the unknown-project 404', async () => {
    await othersTask();
    const shapeOf = (res: supertest.Response, project: string) => ({
      status: res.status,
      body: JSON.stringify(res.body).split(project).join('<id>'),
    });
    const unknown = uuidv4();
    const reference = shapeOf(await index(unknown, keys.reader), unknown);
    expect(reference.status).toBe(404);

    // no grant at all
    expect(shapeOf(await index(projectId, keys.stranger), projectId)).toEqual(reference);
    // an expired grant for ANOTHER project tells this one nothing
    grant('stranger', siblingProjectId, PAST);
    expect(shapeOf(await index(projectId, keys.stranger), projectId)).toEqual(reference);
    grants.length = 0;
    // a grant for a sibling project of the same workspace
    grant('reader', siblingProjectId);
    expect(shapeOf(await index(projectId, keys.reader), projectId)).toEqual(reference);
    // another workspace's key, even when the list names it for this project
    grant('foreign', projectId);
    expect(shapeOf(await index(projectId, keys.foreign), projectId)).toEqual(reference);
    // a grant that names another workspace's project admits nothing there
    grant('reader', foreignProjectId);
    expect(shapeOf(await index(foreignProjectId, keys.reader), foreignProjectId)).toEqual(reference);
    // a malformed id
    const malformed = await index('not-a-uuid', keys.reader);
    expect(shapeOf(malformed, 'not-a-uuid')).toEqual(reference);

    expect(
      await prisma.activityLog.count({ where: { action: PROJECT_INDEX_READ_ACTION, workspaceId: { in: [workspaceId, otherWorkspaceId] } } }),
    ).toBe(0);
  });

  // MUN-0055 (DEC-AUP-0033 R1) — the one refusal that is NOT the blanket 404.
  it('an expired grant for THIS project answers 403 GRANT_EXPIRED, never 404, and logs no read', async () => {
    await othersTask();
    grant('reader', projectId, PAST);

    const res = await index(projectId, keys.reader).expect(403);

    expect(res.body.code).toBe('GRANT_EXPIRED');
    expect(res.body.until).toBe(PAST);
    expect(res.body.decision).toBe('DEC-TEST');
    expect(res.body.projectId).toBe(projectId);
    // the refusal names no task and no free text
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('secret-bearing title');
    expect(raw).not.toContain('must never reach the index');
    // a refused read is not an index read
    expect(
      await prisma.activityLog.count({ where: { action: PROJECT_INDEX_READ_ACTION, workspaceId } }),
    ).toBe(0);
  });

  it('a foreign-workspace key whose grant on this project expired still gets the blanket 404', async () => {
    grant('foreign', projectId, PAST);
    const res = await index(projectId, keys.foreign).expect(404);
    expect(res.body.code).toBeUndefined();
  });

  // The third leg of the card's acceptance: the grant opens the INDEX, and
  // nothing else. `GET /tasks` carries no @AgentScope at all, so it stays the
  // MUN-0043 default refusal — for the granted key exactly as for any other.
  it('GET /tasks stays 403 MUN-0043 for an agent key, granted or not', async () => {
    for (const setup of [() => void 0, () => grant('reader', projectId)]) {
      grants.length = 0;
      setup();
      const res = await http().get('/tasks').set(bearer(keys.reader)).expect(403);
      expect(JSON.stringify(res.body)).toContain('MUN-0043');
      expect(res.body.code).toBeUndefined();
    }
  });

  it('a JWT is refused on the index (users have the full list on the project route)', async () => {
    await index(projectId, authSvc.signAccess(userId)).expect(403);
  });

  // -------------------------------------------------------------------------
  // what the grant does NOT open — one test per route, granted key, other's task
  // -------------------------------------------------------------------------

  describe('the grant changes nothing else — each route answers the same with the grant present and removed', () => {
    let taskId: string;
    beforeEach(async () => {
      taskId = (await othersTask()).id;
    });
    const k = () => bearer(keys.reader);

    /** Run `call` with the reader granted on this project, then with no grant
     *  at all; both answers must carry `status`, and `check` holds after each. */
    async function differential(
      call: () => supertest.Test,
      status: number,
      check: () => Promise<void> = async () => void 0,
    ) {
      grants.length = 0;
      grant('reader', projectId);
      grant('reader', foreignProjectId);
      const withGrant = await call();
      await check();
      grants.length = 0;
      const withoutGrant = await call();
      await check();
      expect([withGrant.status, withoutGrant.status]).toEqual([status, status]);
      return [withGrant, withoutGrant];
    }

    it('GET /tasks/:taskId → 403', async () => {
      await differential(() => http().get(`/tasks/${taskId}`).set(k()), 403);
    });

    it('GET /tasks/project/:projectId stays the own slice (empty)', async () => {
      const answers = await differential(() => http().get(`/tasks/project/${projectId}`).set(k()), 200);
      for (const res of answers) expect(res.body).toEqual([]);
    });

    it('GET /tasks/project/:projectId/staleness stays the own slice', async () => {
      await prisma.task.update({ where: { id: taskId }, data: { status: 'in_progress' } });
      const answers = await differential(() => http().get(`/tasks/project/${projectId}/staleness`).set(k()), 200);
      for (const res of answers) expect(JSON.stringify(res.body)).not.toContain(taskId);
    });

    it('GET /tasks/:taskId/activity → 403', async () => {
      await differential(() => http().get(`/tasks/${taskId}/activity`).set(k()), 403);
    });

    it('POST /tasks/:taskId/comments → 403, nothing written', async () => {
      await differential(
        () => http().post(`/tasks/${taskId}/comments`).set(k()).send({ body: 'x' }),
        403,
        async () => expect(await prisma.activityLog.count({ where: { taskId } })).toBe(0),
      );
    });

    it('PATCH /tasks/:taskId/status → 403, status unchanged', async () => {
      await differential(
        () => http().patch(`/tasks/${taskId}/status`).set(k()).send({ status: 'in_progress' }),
        403,
        async () => expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).status).toBe('todo'),
      );
    });

    it('POST /tasks/:taskId/redactions → 403', async () => {
      await differential(
        () =>
          http()
            .post(`/tasks/${taskId}/redactions`)
            .set(k())
            .send({ field: 'title', span_sha256: '0'.repeat(64), rule: 'x', replacement: 'x' }),
        403,
      );
    });

    it('POST /agents/tasks/:taskId/assign (self, executor) → 403, no row', async () => {
      await differential(
        () => http().post(`/agents/tasks/${taskId}/assign`).set(k()).send({ agentId: ids.reader, role: 'executor' }),
        403,
        async () => expect(await prisma.taskAgent.count({ where: { taskId } })).toBe(0),
      );
    });

    it('POST /tasks/:taskId/checklist → 403 (unmarked route)', async () => {
      await differential(
        () => http().post(`/tasks/${taskId}/checklist`).set(k()).send({ title: 'x' }),
        403,
        async () => expect(await prisma.taskChecklist.count({ where: { taskId } })).toBe(0),
      );
    });

    it('POST /tasks/:taskId/dependencies → 403 (unmarked route)', async () => {
      const other = await othersTask();
      await differential(() => http().post(`/tasks/${taskId}/dependencies`).set(k()).send({ dependsOnId: other.id }), 403);
    });

    it('DELETE /tasks/:taskId → 403 (unmarked route), task still there', async () => {
      await differential(
        () => http().delete(`/tasks/${taskId}`).set(k()),
        403,
        async () => expect(await prisma.task.findUnique({ where: { id: taskId } })).not.toBeNull(),
      );
    });

    it("POST /tasks into another workspace's project → 404, nothing created", async () => {
      await differential(
        () => http().post('/tasks').set(k()).send({ projectId: foreignProjectId, title: 'x' }),
        404,
        async () => expect(await prisma.task.count({ where: { projectId: foreignProjectId } })).toBe(0),
      );
    });

    // MUN-0055 (DEC-AUP-0033 R4). This is the ONE route the grant now changes,
    // and it changes it by taking something away. DEC-AUP-0029 R7 accepted, for
    // one week, that a granted key could pair the index (which ids) with this
    // read (which values) and rebuild every title and description of the
    // project. The renewal removes that pairing instead of extending the
    // residual: with the grant present the free-text VALUES are withheld from a
    // task the key does not own; the change signal — version, hash, changed —
    // and every other field are byte-for-byte what they were.
    it('GET /tasks/:taskId/field-changes: the grant now WITHHOLDS title/description values (the R7 residual, closed)', async () => {
      const answers = await differential(() => http().get(`/tasks/${taskId}/field-changes`).set(k()), 200);
      const [granted, ungranted] = answers.map((a) => a.body.fields as Array<Record<string, unknown>>);

      const freeText = (fields: Array<Record<string, unknown>>) =>
        fields.filter((f) => f.field === 'title' || f.field === 'description');
      const rest = (fields: Array<Record<string, unknown>>) =>
        fields.filter((f) => f.field !== 'title' && f.field !== 'description');

      // ungranted: exactly the old answer, values present
      expect(freeText(ungranted).map((f) => f.value)).toEqual([
        expect.stringContaining('secret-bearing title'),
        'must never reach the index',
      ]);
      expect(freeText(ungranted).every((f) => f.valueWithheld === undefined)).toBe(true);

      // granted: the same fields, the same change signal, no plaintext
      expect(freeText(granted).map((f) => f.value)).toEqual([null, null]);
      expect(freeText(granted).every((f) => f.valueWithheld === true)).toBe(true);
      expect(freeText(granted).map((f) => [f.field, f.version, f.hash, f.changed])).toEqual(
        freeText(ungranted).map((f) => [f.field, f.version, f.hash, f.changed]),
      );
      expect(JSON.stringify(granted)).not.toContain('secret-bearing title');
      expect(JSON.stringify(granted)).not.toContain('must never reach the index');

      // every other tracked field is untouched by the grant
      expect(rest(granted)).toEqual(rest(ungranted));
    });

    it('GET /tasks/:taskId/field-changes: a granted key still reads the values of a task it OWNS', async () => {
      const own = await prisma.task.create({
        data: {
          projectId,
          title: 'the reader\'s own task',
          description: 'its own description',
          status: 'todo',
          priority: 'low',
          createdById: ids.reader,
          actorType: 'agent',
        },
      });
      grants.length = 0;
      grant('reader', projectId);

      const res = await http().get(`/tasks/${own.id}/field-changes`).set(k()).expect(200);
      const title = res.body.fields.find((f: { field: string }) => f.field === 'title');
      expect(title.value).toBe("the reader's own task");
      expect(title.valueWithheld).toBeUndefined();
    });

    it("GET /tasks/:taskId/field-changes on another workspace's task → 404", async () => {
      const foreignTask = await othersTask(foreignProjectId);
      await differential(() => http().get(`/tasks/${foreignTask.id}/field-changes`).set(k()), 404);
    });

    it("POST /tasks/:taskId/field-ack: own workspace answers as before (a key's own watermark), another workspace's task 404", async () => {
      const foreignTask = await othersTask(foreignProjectId);
      await differential(
        () => http().post(`/tasks/${foreignTask.id}/field-ack`).set(k()).send({ agentId: ids.reader, fields: [] }),
        404,
      );
      const own = await differential(
        () => http().post(`/tasks/${taskId}/field-ack`).set(k()).send({ agentId: ids.reader, fields: [] }),
        (await http().post(`/tasks/${taskId}/field-ack`).set(k()).send({ agentId: ids.reader, fields: [] })).status,
      );
      expect(own[0].status).toBe(own[1].status);
    });
  });
});
