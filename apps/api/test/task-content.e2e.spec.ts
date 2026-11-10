import type { NestExpressApplication } from '@nestjs/platform-express';
import { jest } from '@jest/globals';
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
import { createDisposablePostgres } from './support/disposable-postgres.js';

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

describe('Task content artifacts (MUN-ARTIFACTS, e2e)', () => {
  jest.setTimeout(60_000);
  const pg = createDisposablePostgres('mun-artifacts-content');
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;
  let contentSvc: TaskContentService;
  const savedUrl = process.env.DATABASE_URL;

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
    await pg.start();
    process.env.DATABASE_URL = pg.url();
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [TestAppModule] })
      .overrideProvider(KanbanService)
      .useValue({ notify: () => void 0 })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = moduleRef.get(PrismaService);
    authSvc = moduleRef.get(AuthService);
    contentSvc = moduleRef.get(TaskContentService);
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await pg.stop();
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
  }, 120_000);

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
  }, 60_000);

  // Disposable Postgres is dropped in afterAll; fixtures use unique UUIDs, so
  // per-test cascade is unnecessary and only inflated the default 5s hook budget.

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

  const uploadFile = (id: string, data: Buffer, key = executorKey, expectedSha?: string) => {
    const req = http().post(`/tasks/${id}/artifacts/bytes`).set('Authorization', `Bearer ${key}`)
      .field('name', 'large-receipt.bin').field('contentType', 'application/octet-stream');
    if (expectedSha !== undefined) req.field('sha256', expectedSha);
    return req.attach('content', data, { filename: 'ignored-client-filename.bin' });
  };

  it('stores a whole 1 MiB byte upload, verifies server SHA and shares idempotency with JSON', async () => {
    const task = await assignedTask();
    const large = Buffer.alloc(1024 * 1024, 0x81);
    const expected = createHash('sha256').update(large).digest('hex');
    const result = await uploadFile(task.id, large, executorKey, expected).expect(201);
    expect(result.body).toMatchObject({ sha256: expected, sizeBytes: large.length, revision: 1, actorId: executorAgentId });
    const fetched = await get(task.id, `/${result.body.id}`).expect(200);
    expect(Buffer.from(fetched.body.contentBase64, 'base64').equals(large)).toBe(true);
    expect((await uploadFile(task.id, large).expect(201)).body).toMatchObject({ id: result.body.id, idempotent: true });
    const small = Buffer.from('same bytes across both transports');
    const uploaded = await uploadFile(task.id, small).expect(201);
    const retry = await upload(task.id, executorKey, { ...payload(small, 'large-receipt.bin'), contentType: 'application/octet-stream' }).expect(201);
    expect(retry.body).toMatchObject({ id: uploaded.body.id, idempotent: true });
  });

  it('refuses oversize/missing byte files, digest mismatch and forged metadata before storage', async () => {
    const task = await assignedTask();
    await uploadFile(task.id, Buffer.alloc(1024 * 1024 + 1)).expect(413);
    await uploadFile(task.id, bytes, executorKey, '0'.repeat(64)).expect(400);
    await http().post(`/tasks/${task.id}/artifacts/bytes`).set('Authorization', `Bearer ${executorKey}`)
      .field('name', 'missing.bin').field('contentType', 'application/octet-stream').expect(400);
    await http().post(`/tasks/${task.id}/artifacts/bytes`).set('Authorization', `Bearer ${executorKey}`)
      .field('name', 'forged.bin').field('contentType', 'application/octet-stream').field('actorId', creatorAgentId)
      .attach('content', bytes, 'content.bin').expect(400);
    await http().post(`/tasks/${task.id}/artifacts/bytes`).set('Authorization', `Bearer ${executorKey}`)
      .field('name', 'duplicate-file.bin').field('contentType', 'application/octet-stream')
      .attach('content', bytes, 'one.bin').attach('content', bytes, 'two.bin').expect(400);
    expect(await prisma.taskArtifactRevision.count({ where: { taskId: task.id } })).toBe(0);
  });

  it('refuses byte writes by unassigned/foreign/creator-only keys and keeps DB byte limits', async () => {
    const task = await assignedTask();
    for (const key of [strangerKey, foreignKey, creatorKey]) await uploadFile(task.id, bytes, key).expect(403);
    const result = await uploadFile(task.id, Buffer.alloc(0)).expect(201);
    expect(result.body.sizeBytes).toBe(0);
    const row = await prisma.taskArtifactRevision.findUniqueOrThrow({ where: { id: result.body.id } });
    await expect(prisma.taskArtifactRevision.create({ data: {
      taskId: task.id, evidenceId: row.evidenceId, kind: 'artifact', name: 'db-oversize', revision: 1,
      content: new Uint8Array(1024 * 1024 + 1), sha256: '0'.repeat(64), sizeBytes: 1024 * 1024 + 1,
      contentType: 'application/octet-stream', actorType: 'agent', actorId: executorAgentId,
    } })).rejects.toThrow();
  });

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
    const restored = await Promise.all([upload(task.id), upload(task.id)]);
    expect(restored.every(r => r.status === 201 && r.body.revision === 3)).toBe(true);
    expect(restored[0].body.id).toBe(restored[1].body.id);
    expect(restored[0].body.id).not.toBe(results[0].body.id);
    expect((await upload(task.id).expect(201)).body).toMatchObject({ id: restored[0].body.id, revision: 3, idempotent: true });
    const rows = await prisma.taskArtifactRevision.findMany({ where: { taskId: task.id }, orderBy: { revision: 'asc' } });
    expect(rows.map(r => r.revision)).toEqual([1, 2, 3]);
    expect(rows[0].sha256).toBe(rows[2].sha256);
    expect(await prisma.taskEvidenceAttachment.count({ where: { taskId: task.id } })).toBe(2);
    expect(await prisma.activityLog.count({ where: { taskId: task.id, action: 'task:content_uploaded' } })).toBe(3);
    expect((await get(task.id, `/${results[0].body.id}`).expect(200)).body.contentBase64).toBe(bytes.toString('base64'));
    await expect(prisma.taskArtifactRevision.update({ where: { id: second.body.id }, data: { name: 'overwrite' } })).rejects.toThrow();
  });

  it('refuses digest mismatch, malformed base64, oversize content, and forged actor fields', async () => {
    const task = await assignedTask();
    await upload(task.id, executorKey, { ...payload(), sha256: '0'.repeat(64) }).expect(400);
    await upload(task.id, executorKey, { ...payload(), contentBase64: '!invalid' }).expect(400);
    await upload(task.id, executorKey, { ...payload(), actorId: creatorAgentId }).expect(400);
    await upload(task.id, executorKey, payload(Buffer.alloc(65537))).expect(413);
    expect(await prisma.taskArtifactRevision.count({ where: { taskId: task.id } })).toBe(0);
  });

  it('accepts boundary size and empty bytes', async () => {
    const task = await assignedTask();
    await upload(task.id, executorKey, payload(Buffer.alloc(65536), 'boundary.bin')).expect(201);
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
