/**
 * E2E: TasksController accepts a long-lived `mun_sk_` agent API key in
 * addition to the 15m human JWT (MUN-0032). Uses real Prisma + dev-postgres,
 * same harness as field-changes.e2e.spec.ts.
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

describe('Tasks — API key auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;

  let workspaceId: string;
  let projectId: string;
  let agentId: string;
  let agentKey: string;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [TestAppModule],
    })
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

    const agent = await prisma.agent.create({
      data: { workspaceId, name: `Agent-${testId}` },
    });
    agentId = agent.id;

    const { key } = await authSvc.createApiKey(agentId, 'assistant-key');
    agentKey = key;
  });

  afterEach(async () => {
    const taskIds = await prisma.task
      .findMany({ where: { projectId }, select: { id: true } })
      .then((rows) => rows.map((r) => r.id));

    if (taskIds.length > 0) {
      await prisma.activityLog.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    }

    await prisma.project.delete({ where: { id: projectId } }).catch(() => void 0);
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => void 0);
  });

  it('creates a task using a mun_sk_ API key (no JWT involved)', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/tasks')
      .set('Authorization', `Bearer ${agentKey}`)
      .send({ projectId, title: 'Created via API key' })
      .expect(201);

    expect(res.body.title).toBe('Created via API key');
    expect(res.body.projectId).toBe(projectId);
  });

  it('records the API-key agent as the task creator (Actor type=agent)', async () => {
    const res = await supertest(app.getHttpServer())
      .post('/tasks')
      .set('Authorization', `Bearer ${agentKey}`)
      .send({ projectId, title: 'Actor check' })
      .expect(201);

    const activity = await prisma.activityLog.findFirst({
      where: { taskId: res.body.id, action: 'task:created' },
    });
    expect(activity?.actorType).toBe('agent');
    expect(activity?.actorId).toBe(agentId);
  });

  it('rejects an invalid mun_sk_ key with 401 (never falls back to JWT check)', async () => {
    await supertest(app.getHttpServer())
      .post('/tasks')
      .set('Authorization', 'Bearer mun_sk_doesnotexist')
      .send({ projectId, title: 'Should fail' })
      .expect(401);
  });

  it('still accepts a human JWT on the same route', async () => {
    const user = await prisma.user.create({
      data: { name: 'human-tester', githubId: null, telegramId: null },
    });
    const jwt = authSvc.signAccess(user.id);

    const res = await supertest(app.getHttpServer())
      .post('/tasks')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ projectId, title: 'Created via JWT' })
      .expect(201);

    expect(res.body.title).toBe('Created via JWT');

    await prisma.activityLog.deleteMany({ where: { taskId: res.body.id } });
    await prisma.task.delete({ where: { id: res.body.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });
});
