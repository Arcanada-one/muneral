/**
 * A2-274 (MUN-EVIDENCE, e2e) — `POST /tasks/:taskId/evidence` and
 * `GET /tasks/:taskId/evidence` over real HTTP against the DATABASE_URL
 * database.
 *
 * Each test names the half of the change it goes red without:
 *
 *   201 + the record        the migration, the service, the route
 *   the list carries sha256 `list()` and the GET route
 *   a repeat is idempotent  UNIQUE (task_id, sha256) + the `existing` branch
 *   a changed claim is 409  the uri/contentType comparison in `repeat()`
 *   malformed value → 400   requireSha256 / requireUri / requireContentType
 *   a stranger → 403        the 'task-evidence' case in AgentTaskScopeGuard
 *   no key → 401            JwtOrApiKeyGuard, unchanged
 *   the creator may attach  assertOwnTask, NOT assertAssignedToTask (MUN-0054)
 *
 * The pipe here is main.ts's own (`whitelist` + `forbidNonWhitelisted`), so the
 * refusals a caller actually meets in production are the ones measured.
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
import {
  EVIDENCE_ATTACHED_ACTION,
  TaskEvidenceService,
  WORK_ITEM_EVIDENCE_SCHEMA,
} from '../src/tasks/evidence/task-evidence.service.js';

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b1'.repeat(32);
const URI_A = 'https://github.com/Arcanada-one/muneral/blob/main/receipts/readiness-a2-274.json';
const CT = 'application/json';

describe('Task evidence attachments (A2-274, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;
  let evidenceSvc: TaskEvidenceService;

  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;
  let executorAgentId: string;
  let executorKey: string;
  let strangerKey: string;
  let foreignKey: string;
  let creatorAgentId: string;
  let creatorKey: string;

  const http = () => supertest(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [TestAppModule] })
      .overrideProvider(KanbanService)
      .useValue({ notify: () => void 0 })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = moduleRef.get(PrismaService);
    authSvc = moduleRef.get(AuthService);
    evidenceSvc = moduleRef.get(TaskEvidenceService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const id = uuidv4().slice(0, 8);
    const user = await prisma.user.create({ data: { name: `a2274-${id}` } });
    workspaceId = (
      await prisma.workspace.create({ data: { slug: `ws-a2274-${id}`, name: `WS ${id}`, ownerId: user.id } })
    ).id;
    otherWorkspaceId = (
      await prisma.workspace.create({ data: { slug: `ws-a2274-o-${id}`, name: `O ${id}`, ownerId: user.id } })
    ).id;
    projectId = (
      await prisma.project.create({ data: { workspaceId, slug: `proj-a2274-${id}`, name: `Proj ${id}` } })
    ).id;

    const executor = await prisma.agent.create({ data: { workspaceId, name: `executor-${id}` } });
    executorAgentId = executor.id;
    executorKey = (await authSvc.createApiKey(executor.id, 'executor')).key;

    const creator = await prisma.agent.create({ data: { workspaceId, name: `creator-${id}` } });
    creatorAgentId = creator.id;
    creatorKey = (await authSvc.createApiKey(creator.id, 'creator')).key;

    const stranger = await prisma.agent.create({ data: { workspaceId, name: `stranger-${id}` } });
    strangerKey = (await authSvc.createApiKey(stranger.id, 'stranger')).key;

    const foreign = await prisma.agent.create({ data: { workspaceId: otherWorkspaceId, name: `foreign-${id}` } });
    foreignKey = (await authSvc.createApiKey(foreign.id, 'foreign')).key;
  });

  afterEach(async () => {
    const taskIds = (await prisma.task.findMany({ where: { projectId }, select: { id: true } })).map((r) => r.id);
    if (taskIds.length > 0) {
      // Evidence rows cascade with the task; the agent FK is RESTRICT, so they
      // must go before the agents do — which the cascade takes care of here.
      await prisma.taskAgent.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.taskFieldState.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.activityLog.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    }
    await prisma.project.delete({ where: { id: projectId } }).catch(() => void 0);
    for (const wid of [workspaceId, otherWorkspaceId]) {
      await prisma.activityLog.deleteMany({ where: { workspaceId: wid } });
      await prisma.workspace.delete({ where: { id: wid } }).catch(() => void 0);
    }
  });

  /** A work item the executor agent is assigned to, created by another agent. */
  async function assignedTask() {
    const task = await prisma.task.create({
      data: {
        projectId,
        title: 'A2-274 fixture',
        status: 'in_progress',
        priority: 'medium',
        createdById: creatorAgentId,
        actorType: 'agent',
      },
    });
    await prisma.taskAgent.create({
      data: { taskId: task.id, agentId: executorAgentId, role: 'executor' },
    });
    return task;
  }

  const body = (over: Record<string, unknown> = {}) => ({
    uri: URI_A,
    sha256: SHA_A,
    contentType: CT,
    ...over,
  });

  const attach = (taskId: string, key: string, payload: Record<string, unknown> = body()) =>
    http().post(`/tasks/${taskId}/evidence`).set('Authorization', `Bearer ${key}`).send(payload);

  const listWith = (taskId: string, key: string) =>
    http().get(`/tasks/${taskId}/evidence`).set('Authorization', `Bearer ${key}`);

  // ---- the acceptance ----

  it('201: the assigned agent attaches an artefact, and the row and the activity entry agree', async () => {
    const task = await assignedTask();

    const res = await attach(task.id, executorKey).expect(201);

    expect(res.body).toMatchObject({
      schema: WORK_ITEM_EVIDENCE_SCHEMA,
      task_id: task.id,
      uri: URI_A,
      sha256: SHA_A,
      content_type: CT,
      created_by_agent_id: executorAgentId,
      idempotent: false,
    });
    expect(typeof res.body.evidence_id).toBe('string');
    expect(typeof res.body.created_at).toBe('string');

    const rows = await prisma.taskEvidenceAttachment.findMany({ where: { taskId: task.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: res.body.evidence_id,
      uri: URI_A,
      sha256: SHA_A,
      contentType: CT,
      createdByAgentId: executorAgentId,
    });

    const activity = await prisma.activityLog.findMany({
      where: { taskId: task.id, action: EVIDENCE_ATTACHED_ACTION },
    });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ actorType: 'agent', actorId: executorAgentId, workspaceId });
    expect(activity[0].payload).toMatchObject({ sha256: SHA_A, uri: URI_A, content_type: CT });
  });

  it('GET returns the list, with the sha256 of every attachment, oldest first', async () => {
    const task = await assignedTask();
    await attach(task.id, executorKey).expect(201);
    await attach(task.id, executorKey, body({ sha256: SHA_B, uri: `${URI_A}.sig`, contentType: 'text/plain' })).expect(201);

    const res = await listWith(task.id, executorKey).expect(200);

    expect(res.body).toMatchObject({ task_id: task.id, total: 2 });
    expect(res.body.evidence.map((e: { sha256: string }) => e.sha256)).toEqual([SHA_A, SHA_B]);
    expect(res.body.evidence[0]).toMatchObject({
      schema: WORK_ITEM_EVIDENCE_SCHEMA,
      uri: URI_A,
      content_type: CT,
      created_by_agent_id: executorAgentId,
    });
    // `idempotent` is a fact about a call, never about a stored row.
    expect(res.body.evidence[0].idempotent).toBeUndefined();
  });

  it('a repeat of the same claim is idempotent: 200, and still exactly one record', async () => {
    const task = await assignedTask();
    const first = await attach(task.id, executorKey).expect(201);

    const second = await attach(task.id, executorKey).expect(200);

    expect(second.body).toMatchObject({
      evidence_id: first.body.evidence_id,
      sha256: SHA_A,
      idempotent: true,
    });
    expect(await prisma.taskEvidenceAttachment.count({ where: { taskId: task.id } })).toBe(1);
    expect(
      await prisma.activityLog.count({ where: { taskId: task.id, action: EVIDENCE_ATTACHED_ACTION } }),
    ).toBe(1);
    const list = await listWith(task.id, executorKey).expect(200);
    expect(list.body.total).toBe(1);
  });

  it('two concurrent first calls settle on one record', async () => {
    const task = await assignedTask();
    const results = await Promise.all([
      attach(task.id, executorKey),
      attach(task.id, executorKey),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(await prisma.taskEvidenceAttachment.count({ where: { taskId: task.id } })).toBe(1);
  });

  it('409: the same digest re-attached under a different uri is refused, not silently kept', async () => {
    const task = await assignedTask();
    await attach(task.id, executorKey).expect(201);

    const res = await attach(task.id, executorKey, body({ uri: 'https://example.invalid/other.json' })).expect(409);

    expect(res.body).toMatchObject({
      code: 'EVIDENCE_DIGEST_CONFLICT',
      sha256: SHA_A,
      stored_uri: URI_A,
      attempted_uri: 'https://example.invalid/other.json',
    });
    const rows = await prisma.taskEvidenceAttachment.findMany({ where: { taskId: task.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].uri).toBe(URI_A);
  });

  it('409 likewise when only the media type differs', async () => {
    const task = await assignedTask();
    await attach(task.id, executorKey).expect(201);
    const res = await attach(task.id, executorKey, body({ contentType: 'text/plain' })).expect(409);
    expect(res.body.code).toBe('EVIDENCE_DIGEST_CONFLICT');
  });

  // ---- the negative controls ----

  describe.each([
    ['uppercase hex', 'A'.repeat(64)],
    ['63 hex digits', 'a'.repeat(63)],
    ['65 hex digits', 'a'.repeat(65)],
    ['an algorithm prefix', `sha256:${'a'.repeat(64)}`],
    ['a non-hex digit', `${'a'.repeat(63)}z`],
    ['the empty string', ''],
    ['leading whitespace', ` ${'a'.repeat(64)}`],
  ])('400 EVIDENCE_SHA256_MALFORMED — %s', (_name, value) => {
    it('is refused with a machine code and stores nothing', async () => {
      const task = await assignedTask();
      const res = await attach(task.id, executorKey, body({ sha256: value })).expect(400);
      expect(res.body.code).toBe('EVIDENCE_SHA256_MALFORMED');
      expect(await prisma.taskEvidenceAttachment.count({ where: { taskId: task.id } })).toBe(0);
    });
  });

  describe.each([
    ['a bare path', 'receipts/graph/readiness.json'],
    ['a scheme-less host', '//example.invalid/x.json'],
    ['embedded whitespace', 'https://example.invalid/a b.json'],
    ['a newline', 'https://example.invalid/a.json\n'],
    ['the empty string', ''],
    ['over 2048 characters', `https://example.invalid/${'x'.repeat(2048)}`],
  ])('400 EVIDENCE_URI_MALFORMED — %s', (_name, value) => {
    it('is refused with a machine code and stores nothing', async () => {
      const task = await assignedTask();
      const res = await attach(task.id, executorKey, body({ uri: value })).expect(400);
      expect(res.body.code).toBe('EVIDENCE_URI_MALFORMED');
      expect(await prisma.taskEvidenceAttachment.count({ where: { taskId: task.id } })).toBe(0);
    });
  });

  it('400: a uri carrying a credential is refused before it can be stored or logged', async () => {
    const task = await assignedTask();
    const res = await attach(task.id, executorKey, body({
      uri: 'https://reader:hunter2@example.invalid/receipt.json',
    })).expect(400);
    expect(res.body.code).toBe('EVIDENCE_URI_HAS_CREDENTIALS');
    expect(await prisma.taskEvidenceAttachment.count({ where: { taskId: task.id } })).toBe(0);
    const logged = await prisma.activityLog.findMany({ where: { taskId: task.id } });
    expect(JSON.stringify(logged)).not.toContain('hunter2');
  });

  describe.each([
    ['no slash', 'application'],
    ['uppercase', 'Application/JSON'],
    ['embedded whitespace', 'application /json'],
    ['the empty string', ''],
  ])('400 EVIDENCE_CONTENT_TYPE_MALFORMED — %s', (_name, value) => {
    it('is refused with a machine code', async () => {
      const task = await assignedTask();
      const res = await attach(task.id, executorKey, body({ contentType: value })).expect(400);
      expect(res.body.code).toBe('EVIDENCE_CONTENT_TYPE_MALFORMED');
    });
  });

  it('403: an agent neither assigned to the task nor its creator may not attach or read', async () => {
    const task = await assignedTask();
    await attach(task.id, strangerKey).expect(403);
    expect(await prisma.taskEvidenceAttachment.count({ where: { taskId: task.id } })).toBe(0);
    await listWith(task.id, strangerKey).expect(403);
  });

  it('403: an agent of another workspace may not attach', async () => {
    const task = await assignedTask();
    await attach(task.id, foreignKey).expect(403);
    expect(await prisma.taskEvidenceAttachment.count({ where: { taskId: task.id } })).toBe(0);
  });

  it('403: an unknown task id answers exactly as an unowned one, so ids cannot be enumerated', async () => {
    const task = await assignedTask();
    const unknown = await attach(uuidv4(), executorKey).expect(403);
    const unowned = await attach(task.id, strangerKey).expect(403);
    expect(unknown.body.statusCode).toBe(unowned.body.statusCode);
  });

  it('401: no credential at all', async () => {
    const task = await assignedTask();
    await http().post(`/tasks/${task.id}/evidence`).send(body()).expect(401);
    await http().get(`/tasks/${task.id}/evidence`).expect(401);
    expect(await prisma.taskEvidenceAttachment.count({ where: { taskId: task.id } })).toBe(0);
  });

  it('401: a key that is not a mun_sk_ key', async () => {
    const task = await assignedTask();
    await attach(task.id, 'not-a-key').expect(401);
  });

  // ---- the deliberate choices ----

  it('the CREATOR of a work item may attach without a task_agents row (MUN-0054)', async () => {
    const task = await prisma.task.create({
      data: {
        projectId,
        title: 'registered by the executor itself',
        status: 'in_progress',
        priority: 'medium',
        createdById: creatorAgentId,
        actorType: 'agent',
      },
    });
    expect(await prisma.taskAgent.count({ where: { taskId: task.id } })).toBe(0);

    const res = await attach(task.id, creatorKey).expect(201);
    expect(res.body.created_by_agent_id).toBe(creatorAgentId);
  });

  it('a human actor is refused by the service: the record names an agent, and a human has no agent id', async () => {
    const task = await assignedTask();
    await expect(
      evidenceSvc.attach(
        task.id,
        { type: 'human', id: uuidv4(), name: 'operator' },
        { uri: URI_A, sha256: SHA_A, contentType: CT },
      ),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'EVIDENCE_AGENT_KEY_REQUIRED' },
    });
    expect(await prisma.taskEvidenceAttachment.count({ where: { taskId: task.id } })).toBe(0);
  });

  it('the database refuses a digest written around the DTO', async () => {
    const task = await assignedTask();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO task_evidence_attachments (task_id, uri, sha256, content_type, created_by_agent_id)
         VALUES ($1::uuid, $2, $3, $4, $5::uuid)`,
        task.id,
        URI_A,
        'NOT-A-DIGEST',
        CT,
        executorAgentId,
      ),
    ).rejects.toThrow();
    expect(await prisma.taskEvidenceAttachment.count({ where: { taskId: task.id } })).toBe(0);
  });

  it('the unique index holds against a second row for one digest, written around the route', async () => {
    const task = await assignedTask();
    await attach(task.id, executorKey).expect(201);
    await expect(
      prisma.taskEvidenceAttachment.create({
        data: { taskId: task.id, uri: 'https://example.invalid/copy.json', sha256: SHA_A, contentType: CT, createdByAgentId: executorAgentId },
      }),
    ).rejects.toThrow();
  });

  it('deleting the work item takes its evidence with it', async () => {
    const task = await assignedTask();
    await attach(task.id, executorKey).expect(201);
    await prisma.taskAgent.deleteMany({ where: { taskId: task.id } });
    await prisma.activityLog.deleteMany({ where: { taskId: task.id } });
    await prisma.task.delete({ where: { id: task.id } });
    expect(await prisma.taskEvidenceAttachment.count({ where: { taskId: task.id } })).toBe(0);
  });
});
