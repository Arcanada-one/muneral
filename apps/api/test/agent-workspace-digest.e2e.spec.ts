/**
 * A2-284 (e2e) — the workspace task digest for an agent key holding a grant,
 * over real HTTP against the DATABASE_URL database.
 *
 * What the card measured before this route existed (A2-281, live against
 * api.muneral.com on 2026-09-24): `GET /api/v1/tasks` answers a valid `mun_sk_`
 * key 403 MUN-0043, and `GET /tasks/project/:id` answers it `[]` on a board of
 * 880+ rows. So the assistant's daily digest could print either «HTTP 403» or a
 * clean, authorised, entirely false "nothing happened today".
 *
 * `GET /tasks/digest` answers the key's OWN workspace, filtered, in seven
 * columns — and only to a key named in `workspace-digest-grants.ts`. The tests
 * below pin, in order: the refusals (no grant, expired grant), the workspace
 * boundary, the column allowlist, each filter, the paging envelope, and that
 * the grant opens nothing else — no write, and not `GET /tasks` itself.
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
import { WORKSPACE_DIGEST_GRANTS } from '../src/auth/workspace-digest-grants.js';
import type { WorkspaceDigestGrantEntry } from '../src/auth/workspace-digest-grants.js';
import { GRANT_RENEWAL_LEAD_DAYS } from '../src/auth/project-read-grants.js';
import { WORKSPACE_DIGEST_COUNTED, WORKSPACE_DIGEST_READ_ACTION } from '../src/tasks/tasks.service.js';

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

/** The exact keys of one digest row. Equality, not a subset: a column added to
 *  `tasks` later must not reach an agent key by merging. */
const ROW_KEYS = ['createdAt', 'id', 'priority', 'projectId', 'status', 'title', 'updatedAt'];
const ENVELOPE_KEYS = [
  'auditEventId',
  'counted',
  'generatedAt',
  'grant',
  'items',
  'limit',
  'offset',
  'total',
];
const FUTURE = '2999-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';

describe('A2-284 — workspace task digest for granted agent keys (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;
  // The guard reads this very array through DI; each test fills it.
  const grants: WorkspaceDigestGrantEntry[] = [];

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
      .overrideProvider(WORKSPACE_DIGEST_GRANTS)
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
    const user = await prisma.user.create({ data: { name: `a2284-${id}` } });
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
      await prisma.taskAgent.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.taskFieldState.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.activityLog.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    }
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    for (const wid of [workspaceId, otherWorkspaceId]) {
      await prisma.activityLog.deleteMany({ where: { workspaceId: wid } });
      // explicit, not by cascade: leaked keys slow every later test's key scan
      await prisma.apiKey.deleteMany({ where: { agent: { workspaceId: wid } } });
      await prisma.agent.deleteMany({ where: { workspaceId: wid } });
      await prisma.workspace.delete({ where: { id: wid } }).catch(() => void 0);
    }
    await prisma.user.delete({ where: { id: userId } }).catch(() => void 0);
  });

  const grant = (agent: string, ws = workspaceId, until = FUTURE) =>
    grants.push({
      agentId: ids[agent],
      agentName: agent,
      workspaceId: ws,
      until,
      decision: 'DEC-TEST',
      evidence: 'e2e',
    });

  /** A task the reader neither created nor is assigned to: another agent's. */
  async function othersTask(
    over: { project?: string; status?: string; title?: string; updatedAt?: Date; priority?: string } = {},
  ) {
    const task = await prisma.task.create({
      data: {
        projectId: over.project ?? projectId,
        title: over.title ?? `title ${uuidv4()}`,
        description: 'must never reach the digest',
        status: over.status ?? 'todo',
        priority: over.priority ?? 'high',
        createdById: ids.creator,
        actorType: 'agent',
        bootstrapStamp: { receipt: 'must never reach the digest' },
      },
    });
    if (over.updatedAt) {
      // `updatedAt` is @updatedAt, so it cannot be set on create; the digest's
      // whole window filter is about this column, so the tests move it by hand.
      await prisma.$executeRaw`UPDATE tasks SET updated_at = ${over.updatedAt} WHERE id = ${task.id}::uuid`;
    }
    return task;
  }

  const http = () => supertest(app.getHttpServer());
  const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });
  const digest = (k: string, query: Record<string, string | number> = {}) =>
    http().get('/tasks/digest').query(query).set(bearer(k));

  // -------------------------------------------------------------------------
  // the refusals — what merging the route grants by itself (nothing)
  // -------------------------------------------------------------------------

  it('a valid key with NO grant is refused 403 DIGEST_GRANT_REQUIRED', async () => {
    await othersTask();
    const res = await digest(keys.reader).expect(403);
    expect(res.body.code).toBe('DIGEST_GRANT_REQUIRED');
    expect(res.body.scope).toBe('workspace-digest');
    expect(res.body.workspaceId).toBe(workspaceId);
    expect(JSON.stringify(res.body)).not.toContain('title');
  });

  it("another agent's grant does not answer for this key, and neither does another workspace's", async () => {
    grant('stranger');
    await digest(keys.reader).expect(403);
    grants.length = 0;
    grant('reader', otherWorkspaceId);
    await digest(keys.reader).expect(403);
  });

  it('an expired grant is told apart from no grant: 403 GRANT_EXPIRED naming the date and decision', async () => {
    grant('reader', workspaceId, PAST);
    const res = await digest(keys.reader).expect(403);
    expect(res.body.code).toBe('GRANT_EXPIRED');
    expect(res.body.until).toBe(PAST);
    expect(res.body.decision).toBe('DEC-TEST');
    // The lapse that cost two days of silence (MUN-0055) is now a message a
    // consumer can render verbatim.
    expect(res.body.message).toContain('expired at');
  });

  it('no credential at all is 401, not 403 — the route does not exist to unauthenticated callers', async () => {
    await http().get('/tasks/digest').expect(401);
  });

  // -------------------------------------------------------------------------
  // the read the grant opens
  // -------------------------------------------------------------------------

  it("answers the whole workspace — tasks the key neither created nor is assigned to — and nothing outside it", async () => {
    grant('reader');
    const mine = await othersTask();
    const sibling = await othersTask({ project: siblingProjectId });
    const foreign = await othersTask({ project: foreignProjectId, title: 'OTHER WORKSPACE' });

    const res = await digest(keys.reader).expect(200);

    expect(Object.keys(res.body).sort()).toEqual(ENVELOPE_KEYS);
    expect(res.body.items.map((t: { id: string }) => t.id).sort()).toEqual([mine.id, sibling.id].sort());
    expect(res.body.total).toBe(2);
    expect(res.body.counted).toBe(WORKSPACE_DIGEST_COUNTED);
    expect(JSON.stringify(res.body)).not.toContain(foreign.id);
    expect(JSON.stringify(res.body)).not.toContain('OTHER WORKSPACE');
  });

  it('returns exactly seven columns: titles yes, descriptions and provenance never', async () => {
    grant('reader');
    const task = await othersTask({ title: 'Ship the digest' });

    const res = await digest(keys.reader).expect(200);

    for (const row of res.body.items) expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
    const row = res.body.items[0];
    expect(row.id).toBe(task.id);
    expect(row.title).toBe('Ship the digest');
    expect(row.projectId).toBe(projectId);
    expect(row.status).toBe('todo');
    expect(row.priority).toBe('high');
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('must never reach the digest');
    expect(raw).not.toContain(ids.creator);
  });

  it('carries the grant and its renewal warning on every read (a lapse is visible before it happens)', async () => {
    grant('reader');
    await othersTask();
    const res = await digest(keys.reader).expect(200);
    expect(res.body.grant).toEqual({
      decision: 'DEC-TEST',
      until: FUTURE,
      renewalDueAt: new Date(Date.parse(FUTURE) - GRANT_RENEWAL_LEAD_DAYS * 86_400_000).toISOString(),
    });
  });

  it('writes one activity row per read, and the answer carries its id', async () => {
    grant('reader');
    await othersTask();

    const first = await digest(keys.reader, { status: 'todo' }).expect(200);
    const second = await digest(keys.reader).expect(200);

    expect(first.body.auditEventId).not.toBe(second.body.auditEventId);
    const rows = await prisma.activityLog.findMany({
      where: { workspaceId, action: WORKSPACE_DIGEST_READ_ACTION },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.id)).toEqual([first.body.auditEventId, second.body.auditEventId]);
    expect(rows[0].actorId).toBe(ids.reader);
    expect(rows[0].actorType).toBe('agent');
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.decision).toBe('DEC-TEST');
    expect((payload.filters as Record<string, unknown>).status).toBe('todo');
    // What was asked, never what came back: no title can enter the log.
    expect(JSON.stringify(payload)).not.toContain('title');
  });

  // -------------------------------------------------------------------------
  // the filters — each one measured against a row it must exclude
  // -------------------------------------------------------------------------

  it('honours `status`', async () => {
    grant('reader');
    const done = await othersTask({ status: 'done' });
    await othersTask({ status: 'todo' });
    const res = await digest(keys.reader, { status: 'done' }).expect(200);
    expect(res.body.items.map((t: { id: string }) => t.id)).toEqual([done.id]);
    expect(res.body.total).toBe(1);
  });

  it('honours `updatedSince` — yesterday’s row is not today’s digest', async () => {
    grant('reader');
    const today = await othersTask({ status: 'done', updatedAt: new Date('2026-09-24T09:00:00Z') });
    const yesterday = await othersTask({ status: 'done', updatedAt: new Date('2026-09-23T09:00:00Z') });

    const res = await digest(keys.reader, {
      status: 'done',
      updatedSince: '2026-09-24T00:00:00.000Z',
    }).expect(200);

    expect(res.body.items.map((t: { id: string }) => t.id)).toEqual([today.id]);
    expect(JSON.stringify(res.body)).not.toContain(yesterday.id);
  });

  it('honours `updatedBefore`, exclusive at the instant', async () => {
    grant('reader');
    const before = await othersTask({ updatedAt: new Date('2026-09-24T09:00:00Z') });
    const atBound = await othersTask({ updatedAt: new Date('2026-09-25T00:00:00Z') });

    const res = await digest(keys.reader, { updatedBefore: '2026-09-25T00:00:00.000Z' }).expect(200);

    expect(res.body.items.map((t: { id: string }) => t.id)).toEqual([before.id]);
    expect(JSON.stringify(res.body)).not.toContain(atBound.id);
  });

  it('honours `limit` and `offset`, and `total` counts before paging', async () => {
    grant('reader');
    await othersTask({ updatedAt: new Date('2026-09-24T03:00:00Z') });
    await othersTask({ updatedAt: new Date('2026-09-24T02:00:00Z') });
    await othersTask({ updatedAt: new Date('2026-09-24T01:00:00Z') });

    const page = await digest(keys.reader, { limit: 2 }).expect(200);
    expect(page.body.items).toHaveLength(2);
    expect(page.body.total).toBe(3);
    expect(page.body.limit).toBe(2);
    expect(page.body.offset).toBe(0);
    // newest first, so paging is stable for a digest that reads one window
    const next = await digest(keys.reader, { limit: 2, offset: 2 }).expect(200);
    expect(next.body.items).toHaveLength(1);
    expect(next.body.offset).toBe(2);
    expect(next.body.items[0].id).not.toBe(page.body.items[0].id);
  });

  it('rejects a limit above the ceiling and a malformed instant with 400, not an empty page', async () => {
    grant('reader');
    await digest(keys.reader, { limit: 201 }).expect(400);
    await digest(keys.reader, { updatedSince: 'yesterday' }).expect(400);
    await digest(keys.reader, { status: 'finished' }).expect(400);
  });

  it('narrows to one project, and a project of another workspace is an empty page — not a refusal', async () => {
    grant('reader');
    const mine = await othersTask();
    await othersTask({ project: siblingProjectId });
    await othersTask({ project: foreignProjectId });

    const own = await digest(keys.reader, { projectId }).expect(200);
    expect(own.body.items.map((t: { id: string }) => t.id)).toEqual([mine.id]);

    const foreign = await digest(keys.reader, { projectId: foreignProjectId }).expect(200);
    expect(foreign.body.items).toEqual([]);
    expect(foreign.body.total).toBe(0);
  });

  // -------------------------------------------------------------------------
  // what the grant does NOT open
  // -------------------------------------------------------------------------

  // `POST /tasks` is NOT in this list, and the omission is deliberate rather
  // than an oversight: MUN-0045 opened task creation to every key inside its
  // own workspace long before this card, so a test asserting 403 there would
  // fail, and one asserting 201 would read as if the digest grant had bought
  // it. What is measured here is the set of writes a granted key still cannot
  // do — the ones the grant would have to open to matter.
  it('opens no write: status, comment, assign and delete answer a granted key exactly as before', async () => {
    grant('reader');
    const task = await othersTask();

    await http()
      .patch(`/tasks/${task.id}/status`)
      .set(bearer(keys.reader))
      .send({ status: 'in_progress' })
      .expect(403);
    await http()
      .post(`/tasks/${task.id}/comments`)
      .set(bearer(keys.reader))
      .send({ body: 'no' })
      .expect(403);
    await http()
      .post(`/agents/tasks/${task.id}/assign`)
      .set(bearer(keys.reader))
      .send({ agentId: ids.reader, role: 'executor' })
      .expect(403);
    await http().delete(`/tasks/${task.id}`).set(bearer(keys.reader)).expect(403);
    await http()
      .post(`/tasks/${task.id}/redactions`)
      .set(bearer(keys.reader))
      .send({ field: 'title', start: 0, end: 1, reason: 'no' })
      .expect(403);

    const after = await prisma.task.findUnique({ where: { id: task.id } });
    expect(after?.status).toBe('todo');
  });

  it('does not open `GET /tasks` itself, nor the own-slice reads it does not cover', async () => {
    grant('reader');
    const task = await othersTask();
    // The cross-workspace JWT route stays unmarked: still 403 MUN-0043.
    const res = await http().get('/tasks').set(bearer(keys.reader)).expect(403);
    expect(res.body.message).toContain('not available to an agent API key');
    // A task the key does not own is still not readable one row at a time.
    await http().get(`/tasks/${task.id}`).set(bearer(keys.reader)).expect(403);
    // And the project index still needs its own grant (MUN-0052).
    await http().get(`/tasks/project/${projectId}/index`).set(bearer(keys.reader)).expect(404);
  });

  it('answers a granted key of ANOTHER workspace only that workspace, never this one', async () => {
    grant('foreign', otherWorkspaceId);
    const here = await othersTask({ title: 'HOME WORKSPACE' });
    const there = await othersTask({ project: foreignProjectId, title: 'their own' });

    const res = await digest(keys.foreign).expect(200);

    expect(res.body.items.map((t: { id: string }) => t.id)).toEqual([there.id]);
    expect(JSON.stringify(res.body)).not.toContain(here.id);
    expect(JSON.stringify(res.body)).not.toContain('HOME WORKSPACE');
  });
});
