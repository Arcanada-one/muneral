/**
 * Workspace membership on every route a human can call (real HTTP/PostgreSQL).
 *
 * For each route: a user who belongs only to another workspace is refused and no
 * row in the database changes; a member holding the lowest role the route allows
 * gets the route's normal answer.
 */
import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { jest } from '@jest/globals';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { ActivityModule } from '../src/activity/activity.module.js';
import { AgentsModule } from '../src/agents/agents.module.js';
import { MigrationModule } from '../src/migration/migration.module.js';
import { MilestonesModule } from '../src/milestones/milestones.module.js';
import { SolutionLogHeadModule } from '../src/solution-log-head/solution-log-head.module.js';
import { PlanGraphModule } from '../src/plan-graph/plan-graph.module.js';
import { ProjectsModule } from '../src/projects/projects.module.js';
import { SyncModule } from '../src/sync/sync.module.js';
import { TasksModule } from '../src/tasks/tasks.module.js';
import { WorkspacesModule } from '../src/workspaces/workspaces.module.js';
import { WebhooksController } from '../src/webhooks/webhooks.controller.js';
import { WebhooksService, WEBHOOK_QUEUE } from '../src/webhooks/webhooks.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KanbanService } from '../src/ws/kanban.service.js';
import { createDisposablePostgres } from './support/disposable-postgres.js';

@Module({
  imports: [AuthModule],
  controllers: [WebhooksController],
  providers: [WebhooksService, { provide: getQueueToken(WEBHOOK_QUEUE), useValue: { addBulk: async () => [] } }],
})
class WebhooksWithoutRedisModule {}

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, WorkspacesModule, ProjectsModule, MilestonesModule,
    TasksModule, AgentsModule, SyncModule, PlanGraphModule, MigrationModule, SolutionLogHeadModule,
    WebhooksWithoutRedisModule],
})
class FixtureModule {}

const HOOK_SECRET = 'synthetic-webhook-secret-value';
type Role = 'viewer' | 'manager' | 'owner';
type World = Awaited<ReturnType<typeof seedWorld>>;
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

let app: INestApplication;
let prisma: PrismaService;
let auth: AuthService;

async function seedWorld() {
  const tag = randomUUID().slice(0, 8);
  const user = (name: string) => prisma.user.create({ data: { name: `${name}-${tag}` } });
  const [owner, manager, viewer, invitee] = [await user('owner'), await user('manager'), await user('viewer'), await user('invitee')];
  const ws = await prisma.workspace.create({ data: { slug: `ws-${tag}`, name: `Workspace ${tag}`, ownerId: owner.id } });
  for (const [u, role] of [[owner, 'owner'], [manager, 'manager'], [viewer, 'viewer']] as const) {
    await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: u.id, role } });
  }
  const project = await prisma.project.create({ data: { workspaceId: ws.id, slug: `p-${tag}`, name: `Project ${tag}` } });
  const empty = await prisma.project.create({ data: { workspaceId: ws.id, slug: `e-${tag}`, name: 'Empty' } });
  const mk = (title: string) => prisma.task.create({
    data: { projectId: project.id, title: `${title} ${tag}`, status: 'todo', actorType: 'human', createdById: owner.id },
  });
  const task = await mk('Task');
  const counterpart = await mk('Counterpart');
  const spare = await mk('Spare');
  const dependency = await prisma.taskDependency.create({ data: { fromTaskId: task.id, toTaskId: counterpart.id, type: 'related_to' } });
  const item = await prisma.taskChecklist.create({ data: { taskId: task.id, text: 'step' } });
  const gitRef = await prisma.taskGitRef.create({ data: { taskId: task.id, type: 'branch', url: 'https://example.test/r', ref: 'main' } });
  const milestone = await prisma.milestone.create({ data: { projectId: project.id, title: 'Milestone' } });
  const sprint = await prisma.sprint.create({ data: { projectId: project.id, name: 'Sprint', startDate: '2026-01-01', endDate: '2026-01-31' } });
  const agent = await prisma.agent.create({ data: { workspaceId: ws.id, name: `agent-${tag}` } });
  const assigned = await prisma.agent.create({ data: { workspaceId: ws.id, name: `assigned-${tag}` } });
  await prisma.taskAgent.create({ data: { taskId: task.id, agentId: assigned.id, role: 'executor' } });
  const keyId = (await auth.createApiKey(agent.id, 'fixture')).keyId;
  const webhook = await prisma.webhookConfig.create({
    data: { workspaceId: ws.id, url: 'https://example.test/hook', events: ['task:moved'], secret: HOOK_SECRET },
  });
  const batch = await prisma.migrationBatch.create({
    data: { batchKey: `b-${tag}`, sourceSetEpoch: 'e', producer: 'fixture', projectId: project.id, requestDigest: 'a'.repeat(64) },
  });
  const identity = await prisma.legacyIdentity.create({ data: { sourceNamespace: `ns-${tag}`, legacyId: `L-${tag}`, taskId: task.id } });
  const token = (id: string) => auth.signAccess(id);
  return {
    tag, ws, project, empty, task, counterpart, spare, dependency, item, gitRef, milestone, sprint, agent, assigned, keyId,
    webhook, batch, identity, invitee, viewerId: viewer.id, managerId: manager.id, ownerId: owner.id,
    tokens: { owner: token(owner.id), manager: token(manager.id), viewer: token(viewer.id) } as Record<Role, string>,
  };
}

/** A signed-in user who owns a different workspace and belongs to nothing else. */
async function seedOutsider() {
  const other = await seedWorld();
  return { world: other, token: other.tokens.owner };
}

async function snapshot(): Promise<Record<string, string>> {
  const tables = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1");
  const state: Record<string, string> = {};
  for (const { name } of tables) {
    const [row] = await prisma.$queryRawUnsafe<Array<{ digest: string }>>(
      `SELECT md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text), '')) AS digest FROM public."${name}" t`);
    state[name] = row.digest;
  }
  return state;
}

interface Case {
  route: string;
  method: Method;
  path: (w: World) => string;
  body?: (w: World) => object;
  /** Lowest role the route allows. */
  role?: Role;
  /** The member's normal answer. */
  member: number;
}

const c = (route: string, method: Method, path: Case['path'], member: number, extra: Partial<Case> = {}): Case =>
  ({ route, method, path, member, ...extra });

const digest = `sha256:${'b'.repeat(64)}`;

const CASES: Case[] = [
  c('GET /workspaces/:workspaceId', 'get', (w) => `/workspaces/${w.ws.id}`, 200),
  c('GET /workspaces/:workspaceId/members', 'get', (w) => `/workspaces/${w.ws.id}/members`, 200),
  c('POST /workspaces/:workspaceId/members/:userId', 'post', (w) => `/workspaces/${w.ws.id}/members/${w.invitee.id}`, 201, { role: 'manager' }),
  c('PATCH /workspaces/:workspaceId/members/:userId/role', 'patch', (w) => `/workspaces/${w.ws.id}/members/${w.viewerId}/role`, 200, { role: 'owner', body: () => ({ role: 'developer' }) }),
  c('DELETE /workspaces/:workspaceId/members/:userId', 'delete', (w) => `/workspaces/${w.ws.id}/members/${w.viewerId}`, 204, { role: 'manager' }),

  c('POST /projects', 'post', () => '/projects', 201, { body: (w) => ({ workspaceId: w.ws.id, slug: `n-${w.tag}`, name: 'New' }) }),
  c('GET /projects/workspace/:workspaceId', 'get', (w) => `/projects/workspace/${w.ws.id}`, 200),
  c('GET /projects/:projectId', 'get', (w) => `/projects/${w.project.id}`, 200),
  c('DELETE /projects/:projectId', 'delete', (w) => `/projects/${w.empty.id}`, 204),
  c('POST /projects/git-refs', 'post', () => '/projects/git-refs', 201, { body: (w) => ({ taskId: w.task.id, type: 'branch', url: 'https://example.test/n', ref: 'n' }) }),
  c('GET /projects/tasks/:taskId/git-refs', 'get', (w) => `/projects/tasks/${w.task.id}/git-refs`, 200),
  c('DELETE /projects/git-refs/:refId', 'delete', (w) => `/projects/git-refs/${w.gitRef.id}`, 204),

  c('POST /milestones', 'post', () => '/milestones', 201, { body: (w) => ({ projectId: w.project.id, title: 'n' }) }),
  c('GET /projects/:projectId/milestones', 'get', (w) => `/projects/${w.project.id}/milestones`, 200),
  c('DELETE /milestones/:milestoneId', 'delete', (w) => `/milestones/${w.milestone.id}`, 204),
  c('POST /sprints', 'post', () => '/sprints', 201, { body: (w) => ({ projectId: w.project.id, milestoneId: w.milestone.id, name: 'n', startDate: '2026-02-01', endDate: '2026-02-28' }) }),
  c('GET /projects/:projectId/sprints', 'get', (w) => `/projects/${w.project.id}/sprints`, 200),
  c('DELETE /sprints/:sprintId', 'delete', (w) => `/sprints/${w.sprint.id}`, 204),

  c('POST /webhooks', 'post', () => '/webhooks', 201, { body: (w) => ({ workspaceId: w.ws.id, url: 'https://example.com/n', events: ['task:moved'], secret: HOOK_SECRET }) }),
  c('GET /webhooks/workspace/:workspaceId', 'get', (w) => `/webhooks/workspace/${w.ws.id}`, 200),
  c('DELETE /webhooks/:webhookId', 'delete', (w) => `/webhooks/${w.webhook.id}`, 204),
  c('PATCH /webhooks/:webhookId/activate', 'patch', (w) => `/webhooks/${w.webhook.id}/activate`, 200),
  c('PATCH /webhooks/:webhookId/deactivate', 'patch', (w) => `/webhooks/${w.webhook.id}/deactivate`, 200),

  c('POST /agents', 'post', () => '/agents', 201, { body: (w) => ({ workspaceId: w.ws.id, name: 'n' }) }),
  c('GET /agents/workspace/:workspaceId', 'get', (w) => `/agents/workspace/${w.ws.id}`, 200),
  c('POST /agents/tasks/:taskId/assign', 'post', (w) => `/agents/tasks/${w.task.id}/assign`, 201, { body: (w) => ({ agentId: w.agent.id, role: 'reviewer' }) }),
  c('DELETE /agents/tasks/:taskId/assign/:agentId', 'delete', (w) => `/agents/tasks/${w.task.id}/assign/${w.assigned.id}`, 204),
  c('POST /agents/:agentId/keys', 'post', (w) => `/agents/${w.agent.id}/keys`, 201, { body: () => ({ label: 'n' }) }),
  c('POST /agents/keys/:keyId/rotate', 'post', (w) => `/agents/keys/${w.keyId}/rotate`, 201),
  c('DELETE /agents/keys/:keyId', 'delete', (w) => `/agents/keys/${w.keyId}`, 204),

  c('POST /tasks', 'post', () => '/tasks', 201, { body: (w) => ({ projectId: w.project.id, title: 'n', sprintId: w.sprint.id, parentId: w.task.id }) }),
  c('GET /tasks?projectId', 'get', (w) => `/tasks?projectId=${w.project.id}`, 200),
  c('GET /tasks/:taskId/identity', 'get', (w) => `/tasks/${w.task.id}/identity`, 200),
  c('GET /tasks/:taskId', 'get', (w) => `/tasks/${w.task.id}`, 200),
  c('GET /tasks/project/:projectId', 'get', (w) => `/tasks/project/${w.project.id}`, 200),
  c('GET /tasks/project/:projectId/index', 'get', (w) => `/tasks/project/${w.project.id}/index`, 403),
  c('GET /tasks/project/:projectId/active-status-staleness', 'get', (w) => `/tasks/project/${w.project.id}/active-status-staleness`, 403),
  c('GET /tasks/project/:projectId/status-transition-counts', 'get', (w) => `/tasks/project/${w.project.id}/status-transition-counts`, 403),
  c('GET /tasks/project/:projectId/transition-report', 'get', (w) => `/tasks/project/${w.project.id}/transition-report`, 403),
  c('GET /tasks/project/:projectId/staleness', 'get', (w) => `/tasks/project/${w.project.id}/staleness`, 200),
  c('PATCH /tasks/:taskId/status', 'patch', (w) => `/tasks/${w.task.id}/status`, 200, { body: () => ({ status: 'in_progress' }) }),
  c('PATCH /tasks/:taskId', 'patch', (w) => `/tasks/${w.task.id}`, 200, { body: (w) => ({ priority: 'high', sprintId: w.sprint.id }) }),
  c('POST /tasks/:taskId/redactions', 'post', (w) => `/tasks/${w.task.id}/redactions`, 400, { body: () => ({ field: 'title', replacement: 'r', reason: 'fixture', expectedRevision: 0 }) }),
  c('POST /tasks/:taskId/evidence', 'post', (w) => `/tasks/${w.task.id}/evidence`, 403, { body: () => ({ uri: 'https://example.test/e.json', sha256: 'c'.repeat(64), contentType: 'application/json' }) }),
  c('GET /tasks/:taskId/evidence', 'get', (w) => `/tasks/${w.task.id}/evidence`, 200),
  c('DELETE /tasks/:taskId', 'delete', (w) => `/tasks/${w.spare.id}`, 204),
  c('GET /tasks/:taskId/checklist', 'get', (w) => `/tasks/${w.task.id}/checklist`, 200),
  c('POST /tasks/:taskId/checklist', 'post', (w) => `/tasks/${w.task.id}/checklist`, 201, { body: () => ({ text: 'n' }) }),
  c('PATCH /tasks/:taskId/checklist/:itemId', 'patch', (w) => `/tasks/${w.task.id}/checklist/${w.item.id}`, 200, { body: () => ({ checked: true }) }),
  c('DELETE /tasks/:taskId/checklist/:itemId', 'delete', (w) => `/tasks/${w.task.id}/checklist/${w.item.id}`, 204),
  c('GET /tasks/:taskId/children', 'get', (w) => `/tasks/${w.task.id}/children`, 200),
  c('GET /tasks/:taskId/assignees', 'get', (w) => `/tasks/${w.task.id}/assignees`, 200),
  c('GET /tasks/:taskId/dependencies', 'get', (w) => `/tasks/${w.task.id}/dependencies`, 200),
  c('GET /tasks/:taskId/dependency-graph', 'get', (w) => `/tasks/${w.task.id}/dependency-graph`, 200),
  c('GET /tasks/:taskId/readiness', 'get', (w) => `/tasks/${w.task.id}/readiness`, 200),
  c('POST /tasks/:taskId/dependencies', 'post', (w) => `/tasks/${w.task.id}/dependencies`, 201, { body: (w) => ({ toTaskId: w.spare.id, type: 'related_to' }) }),
  c('DELETE /tasks/:taskId/dependencies/:depId', 'delete', (w) => `/tasks/${w.task.id}/dependencies/${w.dependency.id}`, 204),
  c('POST /tasks/:taskId/comments', 'post', (w) => `/tasks/${w.task.id}/comments`, 201, { body: () => ({ body: 'n' }) }),
  c('GET /tasks/:taskId/comments', 'get', (w) => `/tasks/${w.task.id}/comments`, 200),
  c('GET /tasks/:taskId/activity', 'get', (w) => `/tasks/${w.task.id}/activity`, 200),
  c('POST /tasks/:taskId/artifacts', 'post', (w) => `/tasks/${w.task.id}/artifacts`, 400, { body: () => ({}) }),
  c('POST /tasks/:taskId/artifacts/bytes', 'post', (w) => `/tasks/${w.task.id}/artifacts/bytes`, 400, { body: () => ({}) }),
  c('GET /tasks/:taskId/artifacts', 'get', (w) => `/tasks/${w.task.id}/artifacts`, 200),
  c('GET /tasks/:taskId/artifacts/by-sha/:sha256', 'get', (w) => `/tasks/${w.task.id}/artifacts/by-sha/${'d'.repeat(64)}`, 404),
  c('GET /tasks/:taskId/artifacts/:artifactId', 'get', (w) => `/tasks/${w.task.id}/artifacts/${randomUUID()}`, 404),
  c('PATCH /tasks/:taskId/contract', 'patch', (w) => `/tasks/${w.task.id}/contract`, 403, { body: () => ({ contractDigest: digest, expectedContractDigest: null }) }),

  c('POST /tasks/commands', 'post', () => '/tasks/commands', 200, { body: (w) => ({ operation: 'task.create', projectId: w.project.id, idempotencyKey: `k-${w.tag}`, command: { title: 'n' } }) }),
  c('GET /tasks/:taskId/plan', 'get', (w) => `/tasks/${w.task.id}/plan`, 404),
  c('PUT /tasks/:taskId/plan', 'put', (w) => `/tasks/${w.task.id}/plan`, 200, { body: () => ({ expectedRevision: 0, nodes: [], edges: [], cursor: null, sourceBindings: {} }) }),
  c('POST /tasks/:taskId/plan/lease', 'post', (w) => `/tasks/${w.task.id}/plan/lease`, 404, { body: () => ({ expectedRevision: 1, expectedPlanDigest: digest, leaseHolder: 'h', leaseExpiresAt: '2030-01-01T00:00:00Z' }) }),
  c('POST /tasks/:taskId/plan/readiness', 'post', (w) => `/tasks/${w.task.id}/plan/readiness`, 404, { body: () => ({ nodeId: 'a', states: [] }) }),

  c('GET /sync/datarim/:projectId', 'get', (w) => `/sync/datarim/${w.project.id}`, 200),
];

const send = (token: string, method: Method, path: string, body?: object) => {
  const request = supertest(app.getHttpServer())[method](path).auth(token, { type: 'bearer' });
  return body ? request.send(body) : request;
};


/** A key of an agent that works in workspace B, as executor of a task there. */
async function seedForeignAgent() {
  const home = await seedWorld();
  const key = (await auth.createApiKey(home.assigned.id, 'foreign')).key;
  return { home, key };
}

/** Everything but the bookkeeping that authenticating a key writes on that key's own row. */
async function stateIgnoringKeyUse(): Promise<Record<string, string>> {
  const state = await snapshot();
  const [row] = await prisma.$queryRawUnsafe<Array<{ digest: string }>>(
    "SELECT md5(coalesce(string_agg((to_jsonb(t) - 'last_used_at')::text, '|' ORDER BY t.id::text), '')) AS digest FROM public.api_keys t");
  return { ...state, api_keys: row.digest };
}

const occurrence = () => ({
  sourceRoot: 'r', sourceLocator: 'l', sourceKey: 'heading-key', contentDigest: 'e'.repeat(64),
  capturedAt: '2026-01-01T00:00:00Z',
});
const workItem = (batchId: string, sourceNamespace: string, legacyId: string) => ({
  batchId, sourceNamespace, legacyId, title: 't', historicalStatus: 'done', occurrence: occurrence(),
  idempotencyKey: randomUUID(),
});

type Probe = [string, Method, (a: World, b: World) => string, ((a: World, b: World) => object) | undefined];

/** Routes only an agent key reaches, aimed at workspace A. */
const KEY_ONLY: Probe[] = [
  ['POST /migration/batches', 'post', () => '/migration/batches', (a) => ({ batchKey: randomUUID(), sourceSetEpoch: 'e', producer: 'p', projectId: a.project.id })],
  ['POST /migration/batches/:batchId/commit', 'post', (a) => `/migration/batches/${a.batch.id}/commit`, undefined],
  ['POST /migration/work-items', 'post', () => '/migration/work-items', (a) => workItem(a.batch.id, 'x', 'y')],
  ['POST /migration/work-items/:taskId/transitions', 'post', (a) => `/migration/work-items/${a.task.id}/transitions`, () => ({ expectedRevision: 0, toStatus: 'in_progress', idempotencyKey: randomUUID(), basis: 'b' })],
  ['POST /migration/identities/:identityId/decisions', 'post', (a) => `/migration/identities/${a.identity.id}/decisions`, (_a, b) => ({ kind: 'same', targets: [b.identity.id], basis: 'b', expectedMappingRevision: 0 })],
  ['GET /tasks/:taskId/attempts/:attemptId/solution-log-head', 'get', (a) => `/tasks/${a.task.id}/attempts/${randomUUID()}/solution-log-head`, undefined],
  ['POST /tasks/:taskId/attempts/:attemptId/solution-log-heads', 'post', (a) => `/tasks/${a.task.id}/attempts/${randomUUID()}/solution-log-heads`, () => ({})],
  ['POST /sync/datarim/:projectId/import', 'post', (a) => `/sync/datarim/${a.project.id}/import`, () => ({ markdown: '## n\n**Status:** todo\n' })],
  ['GET /tasks/:taskId/field-changes', 'get', (a) => `/tasks/${a.task.id}/field-changes`, undefined],
  ['POST /tasks/:taskId/field-ack', 'post', (a) => `/tasks/${a.task.id}/field-ack`, (_a, b) => ({ agentId: b.assigned.id, fields: [] })],
  ['GET /migration/batches/:batchId (key)', 'get', (a) => `/migration/batches/${a.batch.id}`, undefined],
  ['GET /migration/work-items/by-legacy (key)', 'get', (a) => `/migration/work-items/by-legacy/${a.identity.sourceNamespace}/${a.identity.legacyId}`, undefined],
  ['GET /migration/identities/:identityId/mappings (key)', 'get', (a) => `/migration/identities/${a.identity.id}/mappings`, undefined],
];

/** One referenced object per case lies in workspace A. */
const KEY_MIXED: Probe[] = [
  ['create task parentId', 'post', () => '/tasks', (a, b) => ({ projectId: b.project.id, title: 'n', parentId: a.task.id })],
  ['create task sprintId', 'post', () => '/tasks', (a, b) => ({ projectId: b.project.id, title: 'n', sprintId: a.sprint.id })],
  ['task command command.parentId', 'post', () => '/tasks/commands', (a, b) => ({ operation: 'task.create_child', projectId: b.project.id, idempotencyKey: randomUUID(), command: { title: 'n', parentId: a.task.id } })],
  ['task command command.sprintId', 'post', () => '/tasks/commands', (a, b) => ({ operation: 'task.create', projectId: b.project.id, idempotencyKey: randomUUID(), command: { title: 'n', sprintId: a.sprint.id } })],
  ['task command rootTaskId', 'post', () => '/tasks/commands', (a, b) => ({ operation: 'run.associate', projectId: b.project.id, idempotencyKey: randomUUID(), command: { title: 'n' }, rootTaskId: a.task.id })],
  ['put plan nodes[].taskId', 'put', (_a, b) => `/tasks/${b.task.id}/plan`, (a) => ({ expectedRevision: 0, nodes: [{ nodeId: 'a', taskId: a.task.id }], edges: [], cursor: null, sourceBindings: {} })],
  ['update task sprintId', 'patch', (_a, b) => `/tasks/${b.task.id}`, (a) => ({ sprintId: a.sprint.id })],
  ['add dependency toTaskId', 'post', (_a, b) => `/tasks/${b.task.id}/dependencies`, (a) => ({ toTaskId: a.task.id, type: 'related_to' })],
  ['remove dependency depId', 'delete', (a, b) => `/tasks/${b.task.id}/dependencies/${a.dependency.id}`, undefined],
  ['assign agentId', 'post', (_a, b) => `/agents/tasks/${b.task.id}/assign`, (a) => ({ agentId: a.agent.id, role: 'reviewer' })],
  ['toggle checklist itemId', 'patch', (a, b) => `/tasks/${b.task.id}/checklist/${a.item.id}`, () => ({ checked: true })],
  ['identity decision targets', 'post', (_a, b) => `/migration/identities/${b.identity.id}/decisions`, (a) => ({ kind: 'same', targets: [a.identity.id], basis: 'b', expectedMappingRevision: 0 })],
  ['work item batchId', 'post', () => '/migration/work-items', (a, b) => workItem(a.batch.id, b.identity.sourceNamespace, b.identity.legacyId)],
];

describe('workspace membership on workspace-scoped routes', () => {
  jest.setTimeout(60_000);
  const pg = createDisposablePostgres('workspace-access');

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
  }, 120_000);
  afterAll(async () => { if (app) await app.close(); await pg.stop(); }, 120_000);

  describe.each(CASES.map((k) => [k.route, k] as const))('%s', (_route, kase) => {
    it('outsider is refused and nothing changes', async () => {
      const world = await seedWorld();
      const outsider = await seedOutsider();
      const before = await snapshot();
      const r = await send(outsider.token, kase.method, kase.path(world), kase.body?.(world));
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body)).not.toContain(HOOK_SECRET);
      expect(await snapshot()).toEqual(before);
    });

    it('member gets the normal answer', async () => {
      const world = await seedWorld();
      const r = await send(world.tokens[kase.role ?? 'viewer'], kase.method, kase.path(world), kase.body?.(world));
      expect([r.status, r.body?.message === 'Workspace access forbidden']).toEqual([kase.member, false]);
      expect(JSON.stringify(r.body ?? '')).not.toContain(HOOK_SECRET);
    });
  });

  describe('every referenced object must belong to a workspace of the caller', () => {
    const mixed: Array<[string, Method, (own: World, other: World) => string, (own: World, other: World) => object | undefined]> = [
      ['assign agentId', 'post', (o) => `/agents/tasks/${o.task.id}/assign`, (_o, x) => ({ agentId: x.agent.id, role: 'reviewer' })],
      ['unassign agentId', 'delete', (o, x) => `/agents/tasks/${o.task.id}/assign/${x.assigned.id}`, () => undefined],
      ['create sprint milestoneId', 'post', () => '/sprints', (o, x) => ({ projectId: o.project.id, milestoneId: x.milestone.id, name: 'n', startDate: '2026-02-01', endDate: '2026-02-28' })],
      ['create task parentId', 'post', () => '/tasks', (o, x) => ({ projectId: o.project.id, title: 'n', parentId: x.task.id })],
      ['create task sprintId', 'post', () => '/tasks', (o, x) => ({ projectId: o.project.id, title: 'n', sprintId: x.sprint.id })],
      ['update task sprintId', 'patch', (o) => `/tasks/${o.task.id}`, (_o, x) => ({ sprintId: x.sprint.id })],
      ['add dependency toTaskId', 'post', (o) => `/tasks/${o.task.id}/dependencies`, (_o, x) => ({ toTaskId: x.task.id, type: 'related_to' })],
      ['remove dependency depId', 'delete', (o, x) => `/tasks/${o.task.id}/dependencies/${x.dependency.id}`, () => undefined],
      ['task command command.parentId', 'post', () => '/tasks/commands', (o, x) => ({ operation: 'task.create_child', projectId: o.project.id, idempotencyKey: `m-${o.tag}`, command: { title: 'n', parentId: x.task.id } })],
      ['task command rootTaskId', 'post', () => '/tasks/commands', (o, x) => ({ operation: 'run.associate', projectId: o.project.id, idempotencyKey: `r-${o.tag}`, command: { title: 'n' }, rootTaskId: x.task.id })],
      ['put plan nodes[].taskId', 'put', (o) => `/tasks/${o.task.id}/plan`, (_o, x) => ({ expectedRevision: 0, nodes: [{ nodeId: 'a', taskId: x.task.id }], edges: [] })],
      ['create project workspaceId as a list', 'post', () => '/projects', (o, x) => ({ workspaceId: [o.ws.id, x.ws.id], slug: 's', name: 'n' })],
      ['list tasks projectId repeated', 'get', (o, x) => `/tasks?projectId=${o.project.id}&projectId=${x.project.id}`, () => undefined],
      ['create project without workspaceId', 'post', () => '/projects', () => ({ slug: 's', name: 'n' })],
    ];
    it.each(mixed)('reference check: %s', async (_name, method, path, body) => {
      const own = await seedWorld();
      const other = await seedWorld();
      const before = await snapshot();
      const r = await send(own.tokens.owner, method, path(own, other), body(own, other));
      expect(r.status).toBe(403);
      expect(await snapshot()).toEqual(before);
    });

    it.each(['patch', 'delete'] as const)('reference check: %s checklist itemId', async (method) => {
      const own = await seedWorld();
      const other = await seedWorld();
      const before = await snapshot();
      const r = await send(own.tokens.owner, method, `/tasks/${own.task.id}/checklist/${other.item.id}`, { checked: true });
      expect(r.status).toBe(404);
      expect(await snapshot()).toEqual(before);
    });
  });

  describe('agent keys stay within their workspace', () => {
    const refused = async (method: Method, path: string, body: object | undefined, key: string) => {
      const before = await stateIgnoringKeyUse();
      const r = await send(key, method, path, body);
      expect([r.status >= 400 && r.status < 500, r.status]).toEqual([true, expect.any(Number)]);
      expect(await stateIgnoringKeyUse()).toEqual(before);
    };

    it.each(CASES.map((k) => [k.route, k] as const))('workspace scope: %s', async (_route, kase) => {
      const world = await seedWorld();
      const foreign = await seedForeignAgent();
      const before = await stateIgnoringKeyUse();
      const r = await send(foreign.key, kase.method, kase.path(world), kase.body?.(world));
      expect([r.status >= 400 && r.status < 500, r.status]).toEqual([true, expect.any(Number)]);
      expect(r.text).not.toContain(HOOK_SECRET);
      expect(await stateIgnoringKeyUse()).toEqual(before);
    });

    it.each(KEY_ONLY)('key-only route scope: %s', async (_name, method, path, body) => {
      const world = await seedWorld();
      const foreign = await seedForeignAgent();
      await refused(method, path(world, foreign.home), body?.(world, foreign.home), foreign.key);
    });

    it.each(KEY_MIXED)('reference scope: %s', async (_name, method, path, body) => {
      const world = await seedWorld();
      const foreign = await seedForeignAgent();
      await refused(method, path(world, foreign.home), body?.(world, foreign.home), foreign.key);
    });

    it('references inside the key workspace are accepted', async () => {
      const { home, key } = await seedForeignAgent();
      await send(key, 'post', '/tasks', { projectId: home.project.id, title: 'n', parentId: home.task.id, sprintId: home.sprint.id }).expect(201);
      await send(key, 'post', '/tasks/commands', { operation: 'task.create_child', projectId: home.project.id, idempotencyKey: randomUUID(), command: { title: 'n', parentId: home.task.id } }).expect(200);
      await send(key, 'patch', `/tasks/${home.task.id}`, { sprintId: home.sprint.id }).expect(200);
    });

    it.each(['/agents/me', '/agents/tasks', '/agents/keys/self', '/workspaces',
      '/migration/work-items/search?legacyId='])('%s answers within the key workspace', async (path) => {
      const world = await seedWorld();
      const foreign = await seedForeignAgent();
      const r = await send(foreign.key, 'get', path.endsWith('=') ? path + world.identity.legacyId : path);
      expect(r.status).toBeLessThan(500);
      for (const id of [world.ws.id, world.project.id, world.task.id, world.identity.id]) expect(r.text).not.toContain(id);
    });

    it.each(['/agents/keys/self/rotate', '/agents/keys/self/revoke'])('%s changes only the key own rows', async (path) => {
      const world = await seedWorld();
      const foreign = await seedForeignAgent();
      const mine = () => prisma.apiKey.findMany({ where: { agent: { workspaceId: world.ws.id } }, orderBy: { id: 'asc' } });
      const before = await mine();
      await send(foreign.key, 'post', path).expect(200);
      expect(await mine()).toEqual(before);
    });
  });

  describe('routes that answer from the caller own memberships', () => {
    it('outsider lists see nothing of another workspace', async () => {
      const world = await seedWorld();
      const outsider = await seedOutsider();
      for (const path of ['/workspaces', '/tasks', `/migration/work-items/search?legacyId=${world.identity.legacyId}`]) {
        const r = await send(outsider.token, 'get', path).expect(200);
        for (const id of [world.ws.id, world.task.id, world.identity.id]) expect(JSON.stringify(r.body)).not.toContain(id);
      }
    });

    it.each([
      ['batch', (w: World) => `/migration/batches/${w.batch.id}`],
      ['legacy lookup', (w: World) => `/migration/work-items/by-legacy/${w.identity.sourceNamespace}/${w.identity.legacyId}`],
      ['identity mappings', (w: World) => `/migration/identities/${w.identity.id}/mappings`],
    ])('migration %s: not found for an outsider, readable by a member', async (_name, path) => {
      const world = await seedWorld();
      const outsider = await seedOutsider();
      await send(outsider.token, 'get', path(world)).expect(404);
      await send(world.tokens.viewer, 'get', path(world)).expect(200);
    });

    it('a signed-in user can create a workspace, and it changes no other', async () => {
      const world = await seedWorld();
      const outsider = await seedOutsider();
      const members = await prisma.workspaceMember.count({ where: { workspaceId: world.ws.id } });
      await send(outsider.token, 'post', '/workspaces', { name: 'n', slug: `own-${randomUUID().slice(0, 8)}` }).expect(201);
      expect(await prisma.workspaceMember.count({ where: { workspaceId: world.ws.id } })).toBe(members);
    });

    it.each(['/tasks/digest', '/tasks/digest/transitions'])('%s gives no human an answer', async (path) => {
      const world = await seedWorld();
      const r = await send(world.tokens.owner, 'get', path);
      expect([400, 403]).toContain(r.status);
    });
  });

  describe('responses', () => {
    it('webhook responses omit the signing secret', async () => {
      const w = await seedWorld();
      const responses = [
        await send(w.tokens.owner, 'post', '/webhooks', { workspaceId: w.ws.id, url: 'https://example.com/s', events: ['task:moved'], secret: HOOK_SECRET }).expect(201),
        await send(w.tokens.owner, 'get', `/webhooks/workspace/${w.ws.id}`).expect(200),
        await send(w.tokens.owner, 'patch', `/webhooks/${w.webhook.id}/deactivate`).expect(200),
        await send(w.tokens.owner, 'patch', `/webhooks/${w.webhook.id}/activate`).expect(200),
      ];
      for (const r of responses) {
        expect(r.text).not.toContain(HOOK_SECRET);
        for (const row of [r.body].flat()) expect(Object.keys(row)).not.toContain('secret');
      }
      expect((await prisma.webhookConfig.findUniqueOrThrow({ where: { id: w.webhook.id } })).secret).toBe(HOOK_SECRET);
    });

    it('the member list returns id, name and avatar only', async () => {
      const w = await seedWorld();
      await prisma.user.update({ where: { id: w.viewerId }, data: { githubId: BigInt(Date.now()) } });
      await prisma.user.update({ where: { id: w.managerId }, data: { telegramId: BigInt(Date.now() + 1) } });
      const r = await send(w.tokens.viewer, 'get', `/workspaces/${w.ws.id}/members`).expect(200);
      expect(r.body).toHaveLength(3);
      for (const row of r.body) {
        expect(Object.keys(row).sort()).toEqual(['role', 'user', 'userId', 'workspaceId']);
        expect(Object.keys(row.user).sort()).toEqual(['avatarUrl', 'id', 'name']);
      }
    });
  });

  describe('ids that are not UUIDs', () => {
    const withIds = CASES.filter((k) => /:\w*[Ii]d\b/.test(k.route));
    it.each(withIds.map((k) => [k.route, k] as const))('%s answers 4xx', async (_route, kase) => {
      const world = await seedWorld();
      const segments = kase.path(world).split('/');
      for (let i = 0; i < segments.length; i += 1) {
        if (!/^[0-9a-f-]{36}$/i.test(segments[i])) continue;
        const broken = segments.map((s, j) => (j === i ? 'not-a-uuid' : s)).join('/');
        const r = await send(world.tokens.owner, kase.method, broken, kase.body?.(world));
        expect([broken, r.status >= 400 && r.status < 500]).toEqual([broken, true]);
      }
    });
  });
});
