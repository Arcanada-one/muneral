import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { ActivityModule } from '../src/activity/activity.module.js';
import { AgentsModule } from '../src/agents/agents.module.js';
import { SyncModule } from '../src/sync/sync.module.js';
import { TasksModule } from '../src/tasks/tasks.module.js';
import { ProjectsModule } from '../src/projects/projects.module.js';
import { WorkspacesModule } from '../src/workspaces/workspaces.module.js';
import { WorkspacesService } from '../src/workspaces/workspaces.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KanbanService } from '../src/ws/kanban.service.js';
import { createDisposablePostgres } from './support/disposable-postgres.js';
import {
  TASK_ACTIVITY_DEFAULT_LIMIT,
  TASK_ACTIVITY_MAX_LIMIT,
} from '../src/tasks/dto/query-task-activity.dto.js';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    ActivityModule,
    AgentsModule,
    TasksModule,
    ProjectsModule,
    WorkspacesModule,
    SyncModule,
  ],
})
class FixtureModule {}

describe('GET /tasks/:taskId/activity limit bound (real HTTP/PostgreSQL)', () => {
  const pg = createDisposablePostgres('task-activity-limit');
  let app: INestApplication;
  let token: string;
  let taskId: string;

  beforeAll(async () => {
    await pg.start();
    process.env.DATABASE_URL = pg.url();
    const mod = await Test.createTestingModule({ imports: [FixtureModule] })
      .overrideProvider(KanbanService)
      .useValue({ notify() {} })
      .compile();
    app = mod.createNestApplication();
    app.useLogger(false);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    const prisma = mod.get(PrismaService);
    const auth = mod.get(AuthService);
    const user = await prisma.user.create({ data: { name: 'Activity limit reader' } });
    const ws = await mod.get(WorkspacesService).create(user.id, {
      slug: randomUUID(),
      name: 'Activity limit workspace',
    });
    const project = await prisma.project.create({
      data: { workspaceId: ws.id, slug: randomUUID(), name: 'Activity limit project' },
    });
    const task = await prisma.task.create({
      data: {
        projectId: project.id,
        title: 'Activity limit task',
        status: 'in_progress',
        actorType: 'human',
        createdById: user.id,
      },
    });
    await prisma.activityLog.create({
      data: {
        taskId: task.id,
        workspaceId: ws.id,
        actorType: 'human',
        actorId: user.id,
        action: 'comment',
        payload: { body: 'boundary fixture' },
      },
    });
    await prisma.activityLog.create({
      data: {
        taskId: task.id,
        workspaceId: ws.id,
        actorType: 'human',
        actorId: user.id,
        action: 'comment',
        payload: { body: 'second page fixture' },
      },
    });
    taskId = task.id;
    token = auth.signAccess(user.id);
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    await pg.stop();
  }, 120_000);

  it(`defaults to limit=${TASK_ACTIVITY_DEFAULT_LIMIT} when query is omitted`, async () => {
    const res = await supertest(app.getHttpServer())
      .get(`/tasks/${taskId}/activity`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(res.body.limit).toBe(TASK_ACTIVITY_DEFAULT_LIMIT);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeLessThanOrEqual(TASK_ACTIVITY_DEFAULT_LIMIT);
  });

  it(`defaults to limit=${TASK_ACTIVITY_DEFAULT_LIMIT} when only page=1 is set`, async () => {
    const res = await supertest(app.getHttpServer())
      .get(`/tasks/${taskId}/activity?page=1`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(res.body.limit).toBe(TASK_ACTIVITY_DEFAULT_LIMIT);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeLessThanOrEqual(TASK_ACTIVITY_DEFAULT_LIMIT);
  });

  it(`accepts limit=${TASK_ACTIVITY_MAX_LIMIT} (orchestration full-history page)`, async () => {
    const res = await supertest(app.getHttpServer())
      .get(`/tasks/${taskId}/activity?page=1&limit=${TASK_ACTIVITY_MAX_LIMIT}`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(res.body.limit).toBe(TASK_ACTIVITY_MAX_LIMIT);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeLessThanOrEqual(TASK_ACTIVITY_MAX_LIMIT);
  });

  it(`rejects limit=${TASK_ACTIVITY_MAX_LIMIT + 1} with 400`, async () => {
    await supertest(app.getHttpServer())
      .get(`/tasks/${taskId}/activity?page=1&limit=${TASK_ACTIVITY_MAX_LIMIT + 1}`)
      .auth(token, { type: 'bearer' })
      .expect(400);
  });

  it('rejects an unknown query parameter with 400 (forbidNonWhitelisted)', async () => {
    await supertest(app.getHttpServer())
      .get(`/tasks/${taskId}/activity?page=1&limit=20&cursor=abc`)
      .auth(token, { type: 'bearer' })
      .expect(400);
  });

  it('rejects limit=0 and a non-integer limit with 400', async () => {
    for (const limit of ['0', '1.5', 'abc']) {
      await supertest(app.getHttpServer())
        .get(`/tasks/${taskId}/activity?limit=${limit}`)
        .auth(token, { type: 'bearer' })
        .expect(400);
    }
  });

  it('pages by offset: page=1 and page=2 with limit=1 return distinct rows and the same total', async () => {
    const first = await supertest(app.getHttpServer())
      .get(`/tasks/${taskId}/activity?page=1&limit=1`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    const second = await supertest(app.getHttpServer())
      .get(`/tasks/${taskId}/activity?page=2&limit=1`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(first.body.total).toBe(2);
    expect(second.body.total).toBe(2);
    expect(first.body.page).toBe(1);
    expect(second.body.page).toBe(2);
    expect(first.body.data).toHaveLength(1);
    expect(second.body.data).toHaveLength(1);
    expect(first.body.data[0].id).not.toBe(second.body.data[0].id);
  });
});
