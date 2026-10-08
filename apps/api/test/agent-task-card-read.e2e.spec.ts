/**
 * DEC-AUP-0134 (e2e) — the opt-in `card` capability on a project-read grant:
 * `GET /tasks/:taskId` answers a REDACTED card to an agent key that does not
 * own the task, when the task's CURRENT project, inside the key's own
 * workspace, has a live grant entry for that key carrying `card`.
 *
 * Real HTTP, real PostgreSQL (an owned disposable database), the grant list
 * injected through the same PROJECT_READ_GRANTS token the index suite uses, so
 * nothing here depends on a live entry. Every refusal on the card route is ONE
 * 403 body; the matrix compares bodies, not only statuses.
 */
import { jest } from '@jest/globals';
import supertest from 'supertest';
import { createHash } from 'node:crypto';
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
import { TaskFieldStateService } from '../src/tasks/field-state/task-field-state.service.js';
import { TasksService } from '../src/tasks/tasks.service.js';
import { TasksController } from '../src/tasks/tasks.controller.js';
import { AgentTaskScopeGuard } from '../src/auth/guards/agent-task-scope.guard.js';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { createDisposablePostgres } from './support/disposable-postgres.js';

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

/** The exact keys of a redacted card — a field added later fails here. */
const CARD_KEYS = [
  'actorType', 'createdAt', 'descriptionWithheld', 'estimateHours', 'grant', 'id', 'parentId',
  'priority', 'projectId', 'status', 'titleWithheld', 'updatedAt', 'view',
];
const GRANT_KEYS = ['decision', 'renewalDueAt', 'until'];
const CARD_ACTION = 'task:card_read';
const FUTURE = '2999-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';
const CANARY = 'SECRET-CANARY-0134';
const CANARY_SHA = createHash('sha256').update(CANARY, 'utf8').digest('hex');

describe('DEC-AUP-0134 — redacted task card for granted agent keys (e2e)', () => {
  const pg = createDisposablePostgres('card-read');
  let app: INestApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;
  let fsSvc: TaskFieldStateService;
  const grants: ProjectReadGrantEntry[] = [];

  let userId: string;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string; // the granted project
  let siblingProjectId: string; // same workspace, never granted
  let foreignProjectId: string; // another workspace
  const ids: Record<string, string> = {};
  const keys: Record<string, string> = {};

  beforeAll(async () => {
    await pg.start();
    process.env.DATABASE_URL = pg.url();
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [TestAppModule] })
      .overrideProvider(KanbanService)
      .useValue({ notify: () => void 0 })
      .overrideProvider(PROJECT_READ_GRANTS)
      .useValue(grants)
      .compile();
    app = moduleRef.createNestApplication();
    app.useLogger(false);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
    authSvc = moduleRef.get(AuthService);
    fsSvc = moduleRef.get(TaskFieldStateService);
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await pg.stop();
  }, 180_000);

  beforeEach(async () => {
    grants.length = 0;
    const id = uuidv4().slice(0, 8);
    const user = await prisma.user.create({ data: { name: `card-${id}` } });
    userId = user.id;
    workspaceId = (await prisma.workspace.create({ data: { slug: `ws-${id}`, name: `WS ${id}`, ownerId: user.id } })).id;
    await prisma.workspaceMember.create({ data: { workspaceId, userId, role: 'owner' } });
    otherWorkspaceId = (await prisma.workspace.create({ data: { slug: `wo-${id}`, name: `O ${id}`, ownerId: user.id } })).id;
    projectId = (await prisma.project.create({ data: { workspaceId, slug: `p-${id}`, name: `P ${id}` } })).id;
    siblingProjectId = (await prisma.project.create({ data: { workspaceId, slug: `s-${id}`, name: `S ${id}` } })).id;
    foreignProjectId = (await prisma.project.create({ data: { workspaceId: otherWorkspaceId, slug: `f-${id}`, name: `F ${id}` } })).id;
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
    jest.useRealTimers();
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS card_audit_fail ON activity_log');
  });

  /** `reads` is spelled through a loose object so this file compiles (and fails
   *  for the right reason) on a tree that does not know the field yet. */
  const grant = (
    agent: string,
    project: string,
    opts: { until?: string; reads?: string[] | null } = {},
  ) => {
    const entry: Record<string, unknown> = {
      agentId: ids[agent],
      agentName: agent,
      projectId: project,
      until: opts.until ?? FUTURE,
      decision: 'DEC-TEST',
      evidence: 'e2e',
    };
    if (opts.reads !== null) entry.reads = opts.reads ?? ['index', 'card'];
    grants.push(entry as unknown as ProjectReadGrantEntry);
  };

  /** A task the reader neither created nor is assigned to: another agent's. */
  async function othersTask(project = projectId, extra: Record<string, unknown> = {}) {
    return prisma.task.create({
      data: {
        projectId: project,
        title: `${CANARY} title ${uuidv4()}`,
        description: `${CANARY} description`,
        status: 'in_progress',
        priority: 'high',
        estimateHours: 3.5,
        createdById: ids.creator,
        actorType: 'agent',
        bootstrapStamp: { receipt: CANARY },
        dueDate: "2031-02-03",
        contractDigest: `sha256:${'a'.repeat(64)}`,
        ...extra,
      },
    });
  }

  const http = () => supertest(app.getHttpServer());
  const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });
  const card = (taskId: string, k: string) => http().get(`/tasks/${taskId}`).set(bearer(k));
  const cardAuditRows = (ws = workspaceId) =>
    prisma.activityLog.findMany({ where: { workspaceId: ws, action: CARD_ACTION }, orderBy: { createdAt: 'asc' } });

  /** Everything a refusal exposes: status and body with the caller's own id masked. */
  const shapeOf = (res: supertest.Response, taskId: string) => ({
    status: res.status,
    body: JSON.stringify(res.body).split(taskId).join('<id>'),
  });

  // -------------------------------------------------------------------------
  // the positive row: GREEN only with the capability
  // -------------------------------------------------------------------------

  it('R01 granted non-owner reads a REDACTED card: exact keys, no free text, no hash, no creator', async () => {
    grant('reader', projectId);
    const parent = await othersTask();
    const t = await othersTask(projectId, { parentId: parent.id });

    const res = await card(t.id, keys.reader).expect(200);

    expect(Object.keys(res.body).sort()).toEqual(CARD_KEYS);
    expect(Object.keys(res.body.grant).sort()).toEqual(GRANT_KEYS);
    expect(res.body).toMatchObject({
      id: t.id,
      projectId,
      parentId: parent.id,
      status: 'in_progress',
      priority: 'high',
      actorType: 'agent',
      titleWithheld: true,
      descriptionWithheld: true,
      view: 'redacted',
    });
    expect(Number(res.body.estimateHours)).toBe(3.5);
    expect(res.body.grant).toEqual({
      decision: 'DEC-TEST',
      until: FUTURE,
      renewalDueAt: new Date(Date.parse(FUTURE) - GRANT_RENEWAL_LEAD_DAYS * 86_400_000).toISOString(),
    });
    for (const absent of ['title', 'description', 'bootstrapStamp', 'createdById', 'dueDate', 'sprintId', 'contractDigest', 'revision', 'importedAt', 'titleSha256']) {
      expect(res.body).not.toHaveProperty(absent);
    }
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(CANARY);
    expect(raw).not.toContain(CANARY_SHA);
    expect(raw).not.toContain(createHash('sha256').update(t.title, 'utf8').digest('hex'));
    expect(raw).not.toContain(ids.creator);
  });

  it('R02 parentId in ANOTHER project is returned as null; an unparented task has null', async () => {
    grant('reader', projectId);
    const foreignParent = await othersTask(siblingProjectId);
    const child = await othersTask(projectId, { parentId: foreignParent.id });
    const root = await othersTask(projectId);

    const a = await card(child.id, keys.reader).expect(200);
    expect(a.body.parentId).toBeNull();
    expect(JSON.stringify(a.body)).not.toContain(foreignParent.id);
    expect((await card(root.id, keys.reader).expect(200)).body.parentId).toBeNull();
  });

  it('R03 the capability is case-insensitive in the id and works with upper-case uuids', async () => {
    grant('reader', projectId);
    const t = await othersTask();
    const res = await card(t.id.toUpperCase(), keys.reader).expect(200);
    expect(res.body.id).toBe(t.id);
    expect(res.body.view).toBe('redacted');
  });

  // -------------------------------------------------------------------------
  // owners keep the full card
  // -------------------------------------------------------------------------

  it('R04 the creator keeps the FULL card — with and without a grant, no redaction markers', async () => {
    const t = await othersTask();
    for (const withGrant of [false, true]) {
      grants.length = 0;
      if (withGrant) grant('creator', projectId);
      const res = await card(t.id, keys.creator).expect(200);
      expect(res.body.title).toBe(t.title);
      expect(res.body.description).toBe(t.description);
      expect(res.body.createdById).toBe(ids.creator);
      expect(res.body.bootstrapStamp).toEqual({ receipt: CANARY });
      expect(res.body.view).toBeUndefined();
      expect(res.body.titleWithheld).toBeUndefined();
    }
    expect(await cardAuditRows()).toHaveLength(0);
  });

  it('R05 an assignee keeps the FULL card', async () => {
    const t = await othersTask();
    await prisma.taskAgent.create({ data: { taskId: t.id, agentId: ids.stranger, role: 'reviewer' } });
    const res = await card(t.id, keys.stranger).expect(200);
    expect(res.body.title).toBe(t.title);
    expect(res.body.description).toBe(t.description);
  });

  // -------------------------------------------------------------------------
  // refusals — one body
  // -------------------------------------------------------------------------

  it('R06 every refusal on the card route is ONE 403 body (no GRANT_EXPIRED, no existence leak)', async () => {
    const t = await othersTask();
    const sibling = await othersTask(siblingProjectId);
    const foreignTask = await othersTask(foreignProjectId, { createdById: ids.foreign });
    const unknown = uuidv4();

    // reference: a nonexistent id
    const ref = shapeOf(await card(unknown, keys.reader), unknown);
    expect(ref.status).toBe(403);
    expect(ref.body).not.toContain('GRANT_EXPIRED');

    const cases: Array<[string, () => Promise<supertest.Response>, string]> = [];
    // no grant at all
    cases.push(['no grant', () => card(t.id, keys.reader), t.id]);
    // grant without the capability: absent `reads`, and an explicit index-only list
    cases.push(['index-only (absent reads)', async () => { grants.length = 0; grant('reader', projectId, { reads: null }); return card(t.id, keys.reader); }, t.id]);
    cases.push(['index-only (explicit)', async () => { grants.length = 0; grant('reader', projectId, { reads: ['index'] }); return card(t.id, keys.reader); }, t.id]);
    // expired grant for THIS project
    cases.push(['expired', async () => { grants.length = 0; grant('reader', projectId, { until: PAST }); return card(t.id, keys.reader); }, t.id]);
    // grant for a different project of the same workspace
    cases.push(['grant for sibling project', async () => { grants.length = 0; grant('reader', siblingProjectId); return card(t.id, keys.reader); }, t.id]);
    // task in a sibling project, reader granted only for the first
    cases.push(['foreign project, same workspace', async () => { grants.length = 0; grant('reader', projectId); return card(sibling.id, keys.reader); }, sibling.id]);
    // grant held by ANOTHER agent
    cases.push(['grant of another agent', async () => { grants.length = 0; grant('stranger', projectId); return card(t.id, keys.reader); }, t.id]);
    // FOREIGN WORKSPACE task id, even when the list names the reader for that project
    cases.push(['foreign workspace task', async () => { grants.length = 0; grant('reader', projectId); grant('reader', foreignProjectId); return card(foreignTask.id, keys.reader); }, foreignTask.id]);
    // a foreign-workspace key, even when the list names it for the project
    cases.push(['foreign-workspace key', async () => { grants.length = 0; grant('foreign', projectId); return card(t.id, keys.foreign); }, t.id]);
    // malformed id
    cases.push(['malformed id', () => card('not-a-uuid', keys.reader), 'not-a-uuid']);
    for (const [label, run, masked] of cases) {
      const res = await run();
      const got = shapeOf(res, masked);
      expect({ label, ...got }).toEqual({ label, status: 403, body: ref.body });
    }
    expect(await cardAuditRows()).toHaveLength(0);
  });

  it('R07 expiry boundary: until-1ms reads, until exactly refuses with the no-grant body', async () => {
    const t = await othersTask();
    const until = '2030-01-01T00:00:00.000Z';
    grant('reader', projectId, { until });
    const noGrantRef = shapeOf(await card(uuidv4(), keys.reader), 'x');
    // Fake ONLY Date: sockets, timers and the event loop keep running.
    const onlyDate = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] as const;
    jest.useFakeTimers({ now: Date.parse(until) - 1, doNotFake: [...onlyDate] });
    const inside = await card(t.id, keys.reader);
    jest.setSystemTime(Date.parse(until));
    const at = await card(t.id, keys.reader);
    jest.useRealTimers();
    expect(inside.status).toBe(200);
    expect(at.status).toBe(403);
    expect(JSON.stringify(at.body)).toBe(noGrantRef.body);
  });

  it('R08 a task moved between projects is decided by its CURRENT project', async () => {
    grant('reader', projectId);
    const t = await othersTask(siblingProjectId); // starts outside the grant
    await card(t.id, keys.reader).expect(403);
    await prisma.task.update({ where: { id: t.id }, data: { projectId } });
    await card(t.id, keys.reader).expect(200);
    await prisma.task.update({ where: { id: t.id }, data: { projectId: siblingProjectId } });
    await card(t.id, keys.reader).expect(403);
    // moved into another WORKSPACE: refused too
    await prisma.task.update({ where: { id: t.id }, data: { projectId: foreignProjectId } });
    await card(t.id, keys.reader).expect(403);
  });

  it('R17 the SERVICE re-reads under the authorised project AND workspace: a task moved after the guard is refused, not answered', async () => {
    const svc = app.get(TasksService);
    const grantEntry = { agentId: ids.reader, agentName: 'reader', projectId, until: FUTURE, decision: 'DEC-TEST', evidence: 'e2e' } as ProjectReadGrantEntry;
    const t = await othersTask();
    // positive control: the guard's project and workspace give the card
    await expect(svc.redactedCardForAgent(t.id, workspaceId, projectId, grantEntry)).resolves.toMatchObject({ id: t.id, view: 'redacted' });
    // the project the guard authorised is no longer the task's project
    await expect(svc.redactedCardForAgent(t.id, workspaceId, siblingProjectId, grantEntry)).rejects.toMatchObject({ status: 403 });
    // the workspace is not the task's workspace
    await expect(svc.redactedCardForAgent(t.id, otherWorkspaceId, projectId, grantEntry)).rejects.toMatchObject({ status: 403 });
    // and the owner's full read is workspace-bound the same way
    await expect(svc.findOneOwnedByAgent(t.id, workspaceId)).resolves.toMatchObject({ id: t.id });
    await expect(svc.findOneOwnedByAgent(t.id, otherWorkspaceId)).rejects.toMatchObject({ status: 403 });
  });

  it('R18 the project is decided by the task row alone: a client-supplied project (query, header, body) changes nothing', async () => {
    grant('reader', projectId);
    const inSibling = await othersTask(siblingProjectId);
    for (const send of [
      (r: supertest.Test) => r.query({ projectId }),
      (r: supertest.Test) => r.set('X-Project-Id', projectId),
      (r: supertest.Test) => r.send({ projectId }),
    ]) {
      await send(card(inSibling.id, keys.reader)).expect(403);
    }
    // and a client-supplied SIBLING project does not take away a granted card
    const inGranted = await othersTask(projectId);
    await card(inGranted.id, keys.reader).query({ projectId: siblingProjectId }).expect(200);
  });

  it('R19 the GUARD itself is workspace-bound: a foreign-workspace task is refused there even when the list names the key for that project', async () => {
    // Called directly: over HTTP the service re-read would answer 403 on its own
    // and hide a guard that had lost its workspace clause.
    const guard = new AgentTaskScopeGuard({ getAllAndOverride: () => 'task-granted-read' } as unknown as Reflector, prisma, grants);
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: ids.reader } });
    const ctx = (taskId: string) => {
      const req: Record<string, unknown> = { apiKeyAgent: agent, params: { taskId }, query: {} };
      return { ctx: { switchToHttp: () => ({ getRequest: () => req }), getHandler: () => null, getClass: () => null } as unknown as ExecutionContext, req };
    };
    grant('reader', projectId);
    grant('reader', foreignProjectId);
    const foreignTask = await othersTask(foreignProjectId, { createdById: ids.foreign });
    await expect(guard.canActivate(ctx(foreignTask.id).ctx)).rejects.toMatchObject({ status: 403 });
    // positive control through the same harness
    const mine = await othersTask(projectId);
    const { ctx: okCtx, req } = ctx(mine.id);
    await expect(guard.canActivate(okCtx)).resolves.toBe(true);
    expect(req['agentScope']).toMatchObject({ kind: 'task-granted-read', cardView: 'redacted', cardProjectId: projectId, workspaceId });
  });

  it('R20 authorship needs the AGENT actor type: an agent id on a human-typed row is not ownership', async () => {
    const forged = await othersTask(projectId, { createdById: ids.reader, actorType: 'human' });
    await card(forged.id, keys.reader).expect(403); // no grant, not the owner
    grant('reader', projectId);
    const res = await card(forged.id, keys.reader).expect(200);
    expect(res.body.view).toBe('redacted');
    expect(res.body).not.toHaveProperty('title');
  });

  it('R21 the controller never serves an agent key without the card scope the guard sets', async () => {
    const controller = app.get(TasksController);
    const t = await othersTask(projectId, { createdById: ids.reader });
    const res = { setHeader: () => void 0, status: () => void 0 } as never;
    const agentActor = { type: 'agent', id: ids.reader } as never;
    for (const agentScope of [undefined, { agentId: ids.reader, kind: 'task' }, { agentId: ids.reader, kind: 'task-granted-read' }]) {
      await expect(
        controller.findOne(t.id, { actor: agentActor, agentScope } as never, undefined, res),
      ).rejects.toMatchObject({ status: 403 });
    }
  });

  it('R09 a re-created agent (new id) holds no grant', async () => {
    grant('reader', projectId);
    const t = await othersTask();
    const fresh = await prisma.agent.create({ data: { workspaceId, name: `reader-again-${uuidv4().slice(0, 6)}` } });
    const freshKey = (await authSvc.createApiKey(fresh.id, 'again')).key;
    await card(t.id, freshKey).expect(403);
    await card(t.id, keys.reader).expect(200);
  });

  it('R10 no key is 401, and the X-API-Key header form is 401 as before', async () => {
    grant('reader', projectId);
    const t = await othersTask();
    await http().get(`/tasks/${t.id}`).expect(401);
    await http().get(`/tasks/${t.id}`).set('X-API-Key', keys.reader).expect(401);
  });

  // -------------------------------------------------------------------------
  // audit
  // -------------------------------------------------------------------------

  it('R11 each redacted read writes exactly one audit row first; the row carries no free text', async () => {
    grant('reader', projectId);
    const t = await othersTask();
    await card(t.id, keys.reader).expect(200);
    await card(t.id, keys.reader).expect(200);
    const rows = await cardAuditRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.taskId).toBeNull();
      expect(row.actorType).toBe('agent');
      expect(row.actorId).toBe(ids.reader);
      expect(row.payload).toEqual({ taskId: t.id, projectId, decision: 'DEC-TEST', view: 'redacted' });
      expect(JSON.stringify(row)).not.toContain(CANARY);
      expect(JSON.stringify(row)).not.toContain(CANARY_SHA);
    }
  });

  it('R12 audit failure: the read returns NO card (fails closed)', async () => {
    grant('reader', projectId);
    const t = await othersTask();
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION card_audit_fail_fn() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'card audit forced failure'; END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER card_audit_fail BEFORE INSERT ON activity_log
      FOR EACH ROW WHEN (NEW.action = '${CARD_ACTION}') EXECUTE FUNCTION card_audit_fail_fn()`);
    const res = await card(t.id, keys.reader);
    expect(res.status).toBeGreaterThanOrEqual(500);
    const raw = JSON.stringify(res.body) + JSON.stringify(res.headers);
    expect(raw).not.toContain(t.id);
    expect(raw).not.toContain('in_progress');
    // Express may stamp a WEAK validator on any body (the generic error JSON); the
    // card's own strong tag must not have been set.
    expect(res.headers.etag ?? 'W/').toMatch(/^W\//);
    expect(await cardAuditRows()).toHaveLength(0);
  });

  it('R13 ETag is view-tagged: a 304 returns no card and no audit row; the owner ETag never matches the redacted view', async () => {
    grant('reader', projectId);
    grant('creator', projectId);
    // No contract digest: the full view's tag then ends `contractDigest:null`, so a
    // redacted tag that fell back to the same inputs would COLLIDE with it.
    const t = await othersTask(projectId, { contractDigest: null });
    await prisma.$transaction((tx) => fsSvc.recompute(tx, t));

    const red = await card(t.id, keys.reader).expect(200);
    const full = await card(t.id, keys.creator).expect(200);
    expect(red.headers.etag).toBeTruthy();
    expect(full.headers.etag).toBeTruthy();
    expect(red.headers.etag).not.toBe(full.headers.etag);
    const rowsBefore = (await cardAuditRows()).length;

    const again = await card(t.id, keys.reader).set('If-None-Match', red.headers.etag).expect(304);
    expect(again.text ?? '').toBe('');
    expect((await cardAuditRows()).length).toBe(rowsBefore);

    // the OWNER'S tag does not confirm anything to the redacted reader
    const cross = await card(t.id, keys.reader).set('If-None-Match', full.headers.etag).expect(200);
    expect(cross.body.view).toBe('redacted');
    // and the redacted tag does not make the owner's route answer 304
    const crossOwner = await card(t.id, keys.creator).set('If-None-Match', red.headers.etag).expect(200);
    expect(crossOwner.body.title).toBe(t.title);
  });

  // -------------------------------------------------------------------------
  // the grant opens this and nothing else
  // -------------------------------------------------------------------------

  it('R14 GET /tasks (the list) stays 403 for an agent key — granted with card or not', async () => {
    for (const setup of [() => void 0, () => grant('reader', projectId)]) {
      grants.length = 0;
      setup();
      const res = await http().get('/tasks').set(bearer(keys.reader)).expect(403);
      expect(JSON.stringify(res.body)).toContain('MUN-0043');
    }
  });

  it('R15 sibling reads and every write stay as before for a granted non-owner', async () => {
    grant('reader', projectId);
    const t = await othersTask();
    const dep = await othersTask(foreignProjectId, { createdById: ids.foreign });
    await prisma.taskDependency.create({ data: { fromTaskId: t.id, toTaskId: dep.id, type: 'depends_on' } });
    const R = bearer(keys.reader);

    for (const p of ['activity', 'dependencies', 'dependency-graph', 'readiness', 'evidence', 'checklist']) {
      await http().get(`/tasks/${t.id}/${p}`).set(R).expect(403);
    }
    await http().post(`/tasks/${t.id}/comments`).set(R).send({ body: 'x' }).expect(403);
    await http().patch(`/tasks/${t.id}/status`).set(R).send({ status: 'review' }).expect(403);
    await http().post(`/tasks/${t.id}/redactions`).set(R).send({}).expect(403);
    await http().post(`/tasks/${t.id}/evidence`).set(R).send({}).expect(403);
    await http().post(`/tasks/${t.id}/dependencies`).set(R).send({ toTaskId: dep.id, type: 'depends_on' }).expect(403);
    await http().delete(`/tasks/${t.id}`).set(R).expect(403);
    await http().post(`/agents/tasks/${t.id}/assign`).set(R).send({ agentId: ids.reader, role: 'executor' }).expect(403);

    expect(await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ status: 'in_progress' });
    expect(await prisma.taskAgent.count({ where: { taskId: t.id } })).toBe(0);
    // the redacted card carries no trace of the cross-workspace counterpart
    const res = await card(t.id, keys.reader).expect(200);
    expect(JSON.stringify(res.body)).not.toContain(dep.id);
  });

  // -------------------------------------------------------------------------
  // humans untouched
  // -------------------------------------------------------------------------

  it('R16 a member JWT still reads the full card, a non-member JWT is still refused', async () => {
    const t = await othersTask();
    const member = await card(t.id, authSvc.signAccess(userId)).expect(200);
    expect(member.body.title).toBe(t.title);
    expect(member.body.view).toBeUndefined();
    const outsider = await prisma.user.create({ data: { name: `outsider-${uuidv4().slice(0, 6)}` } });
    await card(t.id, authSvc.signAccess(outsider.id)).expect(403);
  });

  // -------------------------------------------------------------------------
  // the filtered list = the existing index with NARROWING filters
  // -------------------------------------------------------------------------

  describe('index filters narrow, never widen', () => {
    const idx = (qs: string, project = projectId, k = keys.reader) =>
      http().get(`/tasks/project/${project}/index${qs}`).set(bearer(k));
    const idsOf = (res: supertest.Response) => (res.body.tasks as Array<{ id: string }>).map((r) => r.id).sort();

    it('F01 unfiltered answer is unchanged; filtered answers are subsets, total counts the project, matched the filter', async () => {
      grant('reader', projectId);
      const a = await othersTask(projectId, { status: 'todo' });
      const b = await othersTask(projectId, { status: 'done' });
      const c = await othersTask(projectId, { status: 'done', contractDigest: `sha256:${'b'.repeat(64)}` });
      await othersTask(siblingProjectId, { status: 'done' });

      const all = await idx('').expect(200);
      expect(all.body.matched).toBeUndefined();
      expect(idsOf(all)).toEqual([a.id, b.id, c.id].sort());

      const done = await idx('?status=done').expect(200);
      expect(idsOf(done)).toEqual([b.id, c.id].sort());
      expect(done.body.total).toBe(3);
      expect(done.body.matched).toBe(2);
      expect(idsOf(done).every((x) => idsOf(all).includes(x))).toBe(true);

      const digest = await idx(`?contractDigest=sha256:${'b'.repeat(64)}`).expect(200);
      expect(idsOf(digest)).toEqual([c.id]);
      expect(digest.body.matched).toBe(1);

      const paged = await idx('?limit=1&offset=1').expect(200);
      expect(paged.body.tasks).toHaveLength(1);
      expect(paged.body.total).toBe(3);
      expect(paged.body.matched).toBe(3);

      const since = await idx(`?updatedSince=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}`).expect(200);
      expect(since.body.tasks).toHaveLength(0);
      expect(since.body.matched).toBe(0);
      const before = await idx(`?updatedBefore=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}`).expect(200);
      expect(before.body.tasks).toHaveLength(3);
    });

    it('F02 the project comes from the path only: a query projectId, arrays and bad values never widen', async () => {
      grant('reader', projectId);
      const mine = await othersTask(projectId);
      const sib = await othersTask(siblingProjectId);
      // 500 is the ceiling, 501 is refused
      await idx('?limit=500').expect(200);
      // the limit cap is a hard 400, not a silent clamp
      for (const qs of ['?limit=501', '?limit=100000', '?limit=-1', '?limit=0']) await idx(qs).expect(400);
      for (const qs of [`?projectId=${siblingProjectId}`, `?status=todo&status=done`, `?status=nonsense`]) {
        const res = await idx(qs);
        const leaked = JSON.stringify(res.body).includes(sib.id);
        expect({ qs, leaked }).toEqual({ qs, leaked: false });
        if (res.status === 200) expect(idsOf(res)).toEqual([mine.id]);
        else expect(res.status).toBe(400);
      }
      // the foreign project in the PATH is 404 as today, filters or not
      await idx('?status=done', foreignProjectId).expect(404);
    });

    it('F03 filters change no authorisation: no grant stays 404, expired stays GRANT_EXPIRED', async () => {
      await othersTask(projectId);
      await idx('?status=todo', projectId, keys.stranger).expect(404);
      grant('reader', projectId, { until: PAST });
      const res = await idx('?status=todo').expect(403);
      expect(res.body.code).toBe('GRANT_EXPIRED');
    });

    it('F05 an entry that names `reads` without `index` does not open the index', async () => {
      grant('reader', projectId, { reads: ['card'] });
      await othersTask(projectId);
      await idx('').expect(404);
    });

    it('F04 a holder of an index-only entry gets the filters too (and no card)', async () => {
      grant('reader', projectId, { reads: ['index'] });
      const t = await othersTask(projectId, { status: 'done' });
      const res = await idx('?status=done').expect(200);
      expect(idsOf(res)).toEqual([t.id]);
      await card(t.id, keys.reader).expect(403);
    });
  });
});
