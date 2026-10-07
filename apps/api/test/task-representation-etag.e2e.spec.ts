import { jest } from '@jest/globals';
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
import { createHash, randomUUID } from 'node:crypto';
import { createDisposablePostgres } from './support/disposable-postgres.js';
import { MigrationModule } from '../src/migration/migration.module.js';
import { MigrationService } from '../src/migration/migration.service.js';
import { TaskFieldStateService } from '../src/tasks/field-state/task-field-state.service.js';
import { KanbanService } from '../src/ws/kanban.service.js';

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule, MigrationModule],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

const pg = createDisposablePostgres('task-representation-etag');

describe('Task representation validator and migration field-state (23e7, real PostgreSQL)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;
  let migration: MigrationService;
  let fields: TaskFieldStateService;

  let userId: string;
  let workspaceId: string;
  let projectId: string;
  let agentId: string;
  let agentKey: string;

  const http = () => supertest(app.getHttpServer());

  beforeAll(async () => {
    await pg.start();
    process.env.DATABASE_URL = pg.url();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [TestAppModule],
    })
      .overrideProvider(KanbanService)
      .useValue({ notify: () => void 0 })
      .compile();

    app = moduleRef.createNestApplication();
    // Exactly src/main.ts's pipe — see the header for why it matters here.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    prisma = moduleRef.get(PrismaService);
    authSvc = moduleRef.get(AuthService);
    migration = moduleRef.get(MigrationService);
    fields = moduleRef.select(MigrationModule).get(TaskFieldStateService, { strict: true });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await pg.stop();
  });

  beforeEach(async () => {
    const id = uuidv4().slice(0, 8);
    const user = await prisma.user.create({ data: { name: `a2267-${id}` } });
    userId = user.id;
    workspaceId = (
      await prisma.workspace.create({
        data: { slug: `ws-a2267-${id}`, name: `WS ${id}`, ownerId: user.id },
      })
    ).id;
    projectId = (
      await prisma.project.create({
        data: { workspaceId, slug: `proj-a2267-${id}`, name: `Proj ${id}` },
      })
    ).id;
    const agent = await prisma.agent.create({ data: { workspaceId, name: `intake-${id}` } });
    agentId = agent.id;
    agentKey = (await authSvc.createApiKey(agent.id, 'intake')).key;
  });


  const actor = () => ({ type: 'agent' as const, id: agentId, name: 'etag-producer' });
  const get = (id: string, etag?: string) => {
    const request = http().get(`/tasks/${id}`).set('Authorization', `Bearer ${agentKey}`);
    return etag ? request.set('If-None-Match', etag) : request;
  };
  const create = async () => (await http().post('/tasks')
    .set('Authorization', `Bearer ${agentKey}`)
    .send({ projectId, title: 'Representation validator fixture' }).expect(201)).body.id as string;
  const command = () => ({ expectedRevision: 0, toStatus: 'in_progress' as const,
    idempotencyKey: randomUUID(), basis: 'Read-only local database proof' });
  const transition = (id: string, body = command()) => http()
    .post(`/migration/work-items/${id}/transitions`)
    .set('Authorization', `Bearer ${agentKey}`).send(body);

  it('returns a new representation after a real migration CAS, then 304 for its unchanged replay', async () => {
    const id = await create();
    const before = await get(id).expect(200);
    await get(id, before.headers.etag).expect(304);
    const dto = command();
    await transition(id, dto).expect(200);
    const after = await get(id, before.headers.etag).expect(200);
    expect(after.body).toMatchObject({ status: 'in_progress', revision: 1 });
    expect(after.headers.etag).not.toBe(before.headers.etag);
    expect(after.headers.etag).toBe(`"${createHash('sha256').update(after.text).digest('hex')}"`);
    await transition(id, dto).expect(200);
    await get(id, after.headers.etag).expect(304);
  });

  it('atomically advances the status field hash and version with migration CAS', async () => {
    const id = await create();
    const before = await prisma.taskFieldState.findUniqueOrThrow({
      where: { taskId_fieldName: { taskId: id, fieldName: 'status' } },
    });
    const dto = command();
    await transition(id, dto).expect(200);
    const after = await prisma.taskFieldState.findUniqueOrThrow({
      where: { taskId_fieldName: { taskId: id, fieldName: 'status' } },
    });
    expect(after.hash).toBe(fields.sha256('in_progress'));
    expect(after.version).toBe(before.version + 1n);
    await transition(id, dto).expect(200);
    expect((await prisma.taskFieldState.findUniqueOrThrow({ where: {
      taskId_fieldName: { taskId: id, fieldName: 'status' },
    } })).version).toBe(after.version);
  });

  it('covers a late bootstrap stamp while existing tracked field versions stay unchanged', async () => {
    const batch = await migration.createBatch({ batchKey: randomUUID(),
      sourceSetEpoch: 'local-23e7', producer: 'etag-producer', projectId }, actor());
    const legacyId = `ETAG-${randomUUID()}`;
    const input = { batchId: batch.batch.id as string, sourceNamespace: 'local/23e7',
      legacyId, title: 'Imported fixture', historicalStatus: 'todo', idempotencyKey: randomUUID(),
      occurrence: { sourceRoot: 'local/23e7', sourceLocator: legacyId,
        sourceKey: legacyId, contentDigest: createHash('sha256').update(legacyId).digest('hex'),
        capturedAt: '2026-10-06T00:00:00.000Z' } };
    const imported = await migration.createWorkItem(input, actor());
    const id = (imported.body.workItem as { id: string }).id;
    const row = await prisma.task.findUniqueOrThrow({ where: { id } });
    await prisma.$transaction(async (tx) => fields.recompute(tx, row));
    const before = await get(id).expect(200);
    expect(before.headers.etag).toBeDefined();
    await get(id, before.headers.etag).expect(304);
    const bootstrapStamp = { seedRef: 'kc2://local/23e7' };
    await migration.createWorkItem({ ...input, idempotencyKey: randomUUID(), bootstrapStamp,
      occurrence: { ...input.occurrence, sourceLocator: `${legacyId}/late` } }, actor());
    const after = await get(id, before.headers.etag).expect(200);
    expect(after.body.bootstrapStamp).toEqual(bootstrapStamp);
    await get(id, after.headers.etag).expect(304);
  });

  it('provides a strong exact-body validator without any tracked field versions', async () => {
    const id = await create();
    await prisma.taskFieldState.deleteMany({ where: { taskId: id } });
    const row = await get(id).expect(200);
    expect(row.headers.etag).toBe(`"${createHash('sha256').update(row.text).digest('hex')}"`);
    await get(id, row.headers.etag).expect(304);
  });

  it('leaves the representation and field versions unchanged on stale and foreign refusals', async () => {
    const id = await create();
    const before = await get(id).expect(200);
    const versions = await prisma.taskFieldState.findMany({ where: { taskId: id } });
    await transition(id, { ...command(), expectedRevision: 9 }).expect(409);
    await prisma.task.update({ where: { id }, data: { createdById: randomUUID() } });
    const foreign = await get(id).expect(403);
    expect(foreign.body).toBeDefined();
    await transition(id).expect(404);
    await prisma.task.update({ where: { id }, data: { createdById: agentId, updatedAt: new Date(before.body.updatedAt) } });
    await get(id, before.headers.etag).expect(304);
    expect(await prisma.taskFieldState.findMany({ where: { taskId: id } })).toEqual(versions);
  });

  it('rolls back CAS, field versions and audit if recompute fails, allowing a genuine retry', async () => {
    const id = await create();
    const before = await get(id).expect(200);
    const versions = await prisma.taskFieldState.findMany({ where: { taskId: id } });
    const dto = command();
    const failure = jest.spyOn(fields, 'recompute').mockRejectedValueOnce(new Error('local recompute refusal'));
    await expect(migration.transition(id, dto, actor())).rejects.toThrow('local recompute refusal');
    failure.mockRestore();
    await get(id, before.headers.etag).expect(304);
    expect(await prisma.taskFieldState.findMany({ where: { taskId: id } })).toEqual(versions);
    expect(await prisma.activityLog.count({ where: { taskId: id, action: 'migration.transition' } })).toBe(0);
    await transition(id, dto).expect(200);
    await get(id, before.headers.etag).expect(200);
  });
});
