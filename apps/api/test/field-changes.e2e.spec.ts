/**
 * E2E tests for field-change tracking and per-agent read receipts.
 * Uses real Prisma + dev-postgres. Per-test fixtures created and cleaned up.
 */
import supertest from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, Module } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PrismaModule } from '../src/prisma/prisma.module';
import { TasksModule } from '../src/tasks/tasks.module';
import { AgentsModule } from '../src/agents/agents.module';
import { AuthModule } from '../src/auth/auth.module';
import { ActivityModule } from '../src/activity/activity.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { KanbanService } from '../src/ws/kanban.service';
import { TaskFieldStateService } from '../src/tasks/field-state/task-field-state.service';

// ---------------------------------------------------------------------------
// Minimal test AppModule: no BullMQ, no WebhooksModule, no WsGateway
// ---------------------------------------------------------------------------
@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule],
  providers: [
    {
      provide: KanbanService,
      useValue: { notify: () => void 0 },
    },
  ],
})
class TestAppModule {}

describe('Field-change tracking (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;
  let fsSvc: TaskFieldStateService;

  // Per-test data
  let workspaceId: string;
  let projectId: string;
  let agentAId: string;
  let agentAKey: string;
  let agentBId: string;
  let agentBKey: string;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [TestAppModule],
    })
      .overrideProvider(KanbanService)
      .useValue({ notify: () => void 0 })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    prisma = moduleRef.get(PrismaService);
    authSvc = moduleRef.get(AuthService);
    fsSvc = moduleRef.get(TaskFieldStateService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const testId = uuidv4().slice(0, 8);

    const user = await prisma.user.create({
      data: { name: `test-${testId}`, githubId: null, telegramId: null },
    });
    const workspace = await prisma.workspace.create({
      data: { slug: `ws-${testId}`, name: `WS ${testId}`, ownerId: user.id },
    });
    workspaceId = workspace.id;

    const project = await prisma.project.create({
      data: { workspaceId, slug: `proj-${testId}`, name: `Proj ${testId}` },
    });
    projectId = project.id;

    const agentA = await prisma.agent.create({
      data: { workspaceId, name: `AgentA-${testId}` },
    });
    agentAId = agentA.id;
    const agentB = await prisma.agent.create({
      data: { workspaceId, name: `AgentB-${testId}` },
    });
    agentBId = agentB.id;

    const { key: kA } = await authSvc.createApiKey(agentAId, 'key-a');
    const { key: kB } = await authSvc.createApiKey(agentBId, 'key-b');
    agentAKey = kA;
    agentBKey = kB;
  });

  afterEach(async () => {
    // Clean up in FK-safe order
    const taskIds = await prisma.task
      .findMany({ where: { projectId }, select: { id: true } })
      .then((rows) => rows.map((r) => r.id));

    if (taskIds.length > 0) {
      await prisma.agentFieldRead.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.taskFieldState.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.activityLog.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    }

    await prisma.project.delete({ where: { id: projectId } }).catch(() => void 0);
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => void 0);
  });

  // ---------------------------------------------------------------------------
  // Helper: create a task and populate field states
  // ---------------------------------------------------------------------------
  async function createTask(overrides: {
    title?: string;
    status?: string;
    priority?: string;
    description?: string | null;
  } = {}) {
    const task = await prisma.task.create({
      data: {
        projectId,
        title: overrides.title ?? 'Test Task',
        status: overrides.status ?? 'todo',
        priority: overrides.priority ?? 'medium',
        description: overrides.description ?? null,
        actorType: 'human',
        createdById: null,
      },
    });

    await prisma.$transaction(async (tx) => {
      await fsSvc.recompute(tx, task);
    });

    return task;
  }

  // ---------------------------------------------------------------------------
  // V-AC-4: field-changes delta
  // ---------------------------------------------------------------------------
  it('returns changed=true for all fields on first read', async () => {
    const task = await createTask({ title: 'Fresh Task' });

    const res = await supertest(app.getHttpServer())
      .get(`/tasks/${task.id}/field-changes?agentId=${agentAId}`)
      .set('Authorization', `Bearer ${agentAKey}`)
      .expect(200);

    expect(res.body.taskId).toBe(task.id);
    const titleField = res.body.fields.find((f: { field: string }) => f.field === 'title');
    expect(titleField).toBeDefined();
    expect(titleField.changed).toBe(true);
    expect(typeof titleField.version).toBe('number');
    expect(titleField.version).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // V-AC-5: ack moves only that agent watermark
  // ---------------------------------------------------------------------------
  it('ack moves only that agent watermark', async () => {
    const task = await createTask({ title: 'Watermark Test' });

    // Get current field versions
    const changesRes = await supertest(app.getHttpServer())
      .get(`/tasks/${task.id}/field-changes?agentId=${agentAId}`)
      .set('Authorization', `Bearer ${agentAKey}`)
      .expect(200);

    const titleField = changesRes.body.fields.find(
      (f: { field: string }) => f.field === 'title',
    );
    expect(titleField.changed).toBe(true);

    // Ack title
    await supertest(app.getHttpServer())
      .post(`/tasks/${task.id}/field-ack`)
      .set('Authorization', `Bearer ${agentAKey}`)
      .send({ agentId: agentAId, fields: [{ field: 'title', version: titleField.version }] })
      .expect(204);

    // After ack: title.changed should be false
    const afterRes = await supertest(app.getHttpServer())
      .get(`/tasks/${task.id}/field-changes?agentId=${agentAId}`)
      .set('Authorization', `Bearer ${agentAKey}`)
      .expect(200);

    const titleAfter = afterRes.body.fields.find(
      (f: { field: string }) => f.field === 'title',
    );
    expect(titleAfter.changed).toBe(false);

    // Update task title → flag should re-raise
    await prisma.task.update({ where: { id: task.id }, data: { title: 'Changed Title' } });
    const updated = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    await prisma.$transaction(async (tx) => { await fsSvc.recompute(tx, updated); });

    const reRaisedRes = await supertest(app.getHttpServer())
      .get(`/tasks/${task.id}/field-changes?agentId=${agentAId}`)
      .set('Authorization', `Bearer ${agentAKey}`)
      .expect(200);
    const reRaisedTitle = reRaisedRes.body.fields.find(
      (f: { field: string }) => f.field === 'title',
    );
    expect(reRaisedTitle.changed).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // V-AC-6: agent A ack does not clear flag for agent B
  // ---------------------------------------------------------------------------
  it('agent A ack does not clear flag for agent B', async () => {
    const task = await createTask({ title: 'Isolation Test' });

    const resA = await supertest(app.getHttpServer())
      .get(`/tasks/${task.id}/field-changes?agentId=${agentAId}`)
      .set('Authorization', `Bearer ${agentAKey}`)
      .expect(200);

    const titleA = resA.body.fields.find((f: { field: string }) => f.field === 'title');

    // Agent A acks title
    await supertest(app.getHttpServer())
      .post(`/tasks/${task.id}/field-ack`)
      .set('Authorization', `Bearer ${agentAKey}`)
      .send({ agentId: agentAId, fields: [{ field: 'title', version: titleA.version }] })
      .expect(204);

    // Agent B still sees it as changed
    const resB = await supertest(app.getHttpServer())
      .get(`/tasks/${task.id}/field-changes?agentId=${agentBId}`)
      .set('Authorization', `Bearer ${agentBKey}`)
      .expect(200);

    const titleB = resB.body.fields.find((f: { field: string }) => f.field === 'title');
    expect(titleB.changed).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // V-AC-8: tracks new activity by cursor not hash
  // ---------------------------------------------------------------------------
  it('tracks new activity by cursor not hash', async () => {
    const task = await createTask();

    // Ack activity sentinel
    await supertest(app.getHttpServer())
      .post(`/tasks/${task.id}/field-ack`)
      .set('Authorization', `Bearer ${agentAKey}`)
      .send({ agentId: agentAId, fields: [{ field: '__activity__', version: 0 }] })
      .expect(204);

    // Add a new activity (comment)
    await prisma.activityLog.create({
      data: {
        workspaceId,
        taskId: task.id,
        actorType: 'human',
        actorId: agentAId,
        action: 'comment',
        payload: { body: 'New comment after ack' },
      },
    });

    // Activity should now be changed
    const res = await supertest(app.getHttpServer())
      .get(`/tasks/${task.id}/field-changes?agentId=${agentAId}`)
      .set('Authorization', `Bearer ${agentAKey}`)
      .expect(200);

    expect(res.body.activity.changed).toBe(true);
    expect(res.body.activity.latestActivityId).toBeTruthy();
  });

  // ---------------------------------------------------------------------------
  // IDOR guard: 403 when body.agentId != authenticated agent
  // ---------------------------------------------------------------------------
  it('returns 403 when body agentId mismatches authenticated agent', async () => {
    const task = await createTask();

    await supertest(app.getHttpServer())
      .post(`/tasks/${task.id}/field-ack`)
      .set('Authorization', `Bearer ${agentAKey}`)
      .send({ agentId: agentBId, fields: [{ field: 'title', version: 1 }] })
      .expect(403);
  });

  // ---------------------------------------------------------------------------
  // 400 unknown field
  // ---------------------------------------------------------------------------
  it('returns 400 for unknown field in ack body', async () => {
    const task = await createTask();

    await supertest(app.getHttpServer())
      .post(`/tasks/${task.id}/field-ack`)
      .set('Authorization', `Bearer ${agentAKey}`)
      .send({ agentId: agentAId, fields: [{ field: 'nonExistentField', version: 1 }] })
      .expect(400);
  });

  // ---------------------------------------------------------------------------
  // 404 for missing task
  // ---------------------------------------------------------------------------
  it('returns 404 for non-existent task', async () => {
    await supertest(app.getHttpServer())
      .get(`/tasks/${uuidv4()}/field-changes?agentId=${agentAId}`)
      .set('Authorization', `Bearer ${agentAKey}`)
      .expect(404);
  });
});
