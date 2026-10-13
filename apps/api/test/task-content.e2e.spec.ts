import type { NestExpressApplication } from '@nestjs/platform-express';
import supertest from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { ValidationPipe, Module } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { TasksModule } from '../src/tasks/tasks.module.js';
import { AgentsModule } from '../src/agents/agents.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { ActivityModule } from '../src/activity/activity.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KanbanService } from '../src/ws/kanban.service.js';
import { createHash } from 'node:crypto';
import { TaskContentService } from '../src/tasks/content/task-content.service.js';

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

describe('Task content artifacts (MUN-ARTIFACTS, e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;
  let contentSvc: TaskContentService;

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
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    app.useBodyParser('json', { limit: '384kb' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = moduleRef.get(PrismaService);
    authSvc = moduleRef.get(AuthService);
    contentSvc = moduleRef.get(TaskContentService);
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

  const bytes = Buffer.from('task-owned content \u0000 \u044f', 'utf8');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const payload = (content = bytes, name = 'receipt.json') => ({ name, contentType: 'application/json', contentBase64: content.toString('base64') });
  const upload = (id: string, key = executorKey, body: object = payload()) => http().post(`/tasks/${id}/artifacts`).set('Authorization', `Bearer ${key}`).send(body);
  const get = (id: string, suffix: string, key = executorKey) => http().get(`/tasks/${id}/artifacts${suffix}`).set('Authorization', `Bearer ${key}`);

  it('stores exact bytes with server digest and credential attribution; lists and retrieves by ID and SHA', async () => {
    const task = await assignedTask();
    const result = await upload(task.id).expect(201);
    expect(result.body).toMatchObject({ sha256: sha, sizeBytes: bytes.length, revision: 1, actorId: executorAgentId });
    expect(result.body.contentBase64).toBeUndefined();
    const fetched = await get(task.id, `/${result.body.id}`).expect(200);
    expect(Buffer.from(fetched.body.contentBase64, 'base64')).toEqual(bytes);
    expect((await get(task.id, `/by-sha/${sha}`).expect(200)).body.id).toBe(result.body.id);
    expect((await get(task.id, '').expect(200)).body.total).toBe(1);
    const audit = await prisma.activityLog.findFirst({ where: { taskId: task.id, action: 'task:content_uploaded' } });
    expect(audit?.actorId).toBe(executorAgentId);
    expect(await prisma.taskEvidenceAttachment.count({ where: { taskId: task.id, sha256: sha } })).toBe(1);
  });

  it('retains immutable revisions, retries idempotently, and serializes concurrent uploads', async () => {
    const task = await assignedTask();
    const results = await Promise.all([upload(task.id), upload(task.id)]);
    expect(results.every(r => r.status === 201)).toBe(true);
    expect(results[0].body.id).toBe(results[1].body.id);
    const second = await upload(task.id, executorKey, payload(Buffer.from('changed'))).expect(201);
    expect(second.body.revision).toBe(2);
    expect((await get(task.id, `/${results[0].body.id}`).expect(200)).body.contentBase64).toBe(bytes.toString('base64'));
    await expect(prisma.taskArtifactRevision.update({ where: { id: second.body.id }, data: { name: 'overwrite' } })).rejects.toThrow();
  });

  it('refuses digest mismatch, malformed base64, oversize content, and forged actor fields', async () => {
    const task = await assignedTask();
    await upload(task.id, executorKey, { ...payload(), sha256: '0'.repeat(64) }).expect(400);
    await upload(task.id, executorKey, { ...payload(), contentBase64: '!invalid' }).expect(400);
    await upload(task.id, executorKey, { ...payload(), actorId: creatorAgentId }).expect(400);
    await upload(task.id, executorKey, payload(Buffer.alloc(262145))).expect(413);
    expect(await prisma.taskArtifactRevision.count({ where: { taskId: task.id } })).toBe(0);
  });

  it('accepts boundary size and empty bytes', async () => {
    const task = await assignedTask();
    await upload(task.id, executorKey, payload(Buffer.alloc(262144), 'boundary.bin')).expect(201);
    await upload(task.id, executorKey, payload(Buffer.alloc(0), 'empty.bin')).expect(201);
  });

  it('refuses unassigned, creator-only and foreign keys on every read/write; no key is 401', async () => {
    const task = await assignedTask();
    const row = await upload(task.id).expect(201);
    for (const key of [strangerKey, creatorKey, foreignKey]) {
      await upload(task.id, key).expect(403);
      await get(task.id, '', key).expect(403);
      await get(task.id, `/${row.body.id}`, key).expect(403);
      await get(task.id, `/by-sha/${sha}`, key).expect(403);
    }
    await http().post(`/tasks/${task.id}/artifacts`).send(payload()).expect(401);
    const other = await assignedTask();
    await get(other.id, `/${row.body.id}`).expect(404);
  });

  it('shares existing evidence references without mutating legacy claims', async () => {
    const task = await assignedTask();
    const legacy = await prisma.taskEvidenceAttachment.create({ data: { taskId: task.id, sha256: sha,
      uri: 'file:///historical.json', contentType: 'application/json', createdByAgentId: creatorAgentId } });
    const row = await upload(task.id).expect(201);
    expect((await prisma.taskArtifactRevision.findUnique({ where: { id: row.body.id } }))?.evidenceId).toBe(legacy.id);
    expect((await prisma.taskEvidenceAttachment.findUnique({ where: { id: legacy.id } }))?.uri).toBe('file:///historical.json');
  });


  it('supports dashboard JWT reads and revokes them with membership; JWT upload stays refused', async () => {
    const task = await assignedTask();
    const row = await upload(task.id).expect(201);
    const user = await prisma.user.create({ data: { name: 'artifact-reader' } });
    await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id, role: 'viewer' } });
    const jwt = authSvc.signAccess(user.id);
    expect((await get(task.id, `/${row.body.id}`, jwt).expect(200)).body.contentBase64).toBe(bytes.toString('base64'));
    await upload(task.id, jwt).expect(403);
    await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId: user.id } } });
    await get(task.id, '', jwt).expect(403);
    await get(task.id, `/${row.body.id}`, jwt).expect(403);
    await prisma.user.delete({ where: { id: user.id } });
  });

  it('rolls back bytes and evidence if atomic audit fails', async () => {
    const task = await assignedTask();
    await prisma.$executeRawUnsafe(`CREATE FUNCTION fail_artifact_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'task:content_uploaded' THEN RAISE EXCEPTION 'audit red control'; END IF; RETURN NEW; END; $$`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER artifact_audit_red BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION fail_artifact_audit()');
    try {
      await expect(contentSvc.uploadArtifact(task.id, { type: 'agent', id: executorAgentId, name: 'executor' }, payload())).rejects.toThrow();
      expect(await prisma.taskArtifactRevision.count({ where: { taskId: task.id } })).toBe(0);
      expect(await prisma.taskEvidenceAttachment.count({ where: { taskId: task.id } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER artifact_audit_red ON activity_log');
      await prisma.$executeRawUnsafe('DROP FUNCTION fail_artifact_audit()');
    }
  });
});
