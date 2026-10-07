import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { ActivityModule } from '../src/activity/activity.module.js';
import { AgentsModule } from '../src/agents/agents.module.js';
import { TasksModule } from '../src/tasks/tasks.module.js';
import { ProjectsModule } from '../src/projects/projects.module.js';
import { WorkspacesModule } from '../src/workspaces/workspaces.module.js';
import { WorkspacesService } from '../src/workspaces/workspaces.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KanbanService } from '../src/ws/kanban.service.js';
import { createDisposablePostgres } from './support/disposable-postgres.js';
import { TaskFieldStateService } from '../src/tasks/field-state/task-field-state.service.js';
import { TasksService } from '../src/tasks/tasks.service.js';
import { HumanTaskReadGuard } from '../src/auth/guards/human-task-read.guard.js';
import type { ExecutionContext } from '@nestjs/common';

@Module({ imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule,
  ProjectsModule, WorkspacesModule] })
class FixtureModule {}

describe('Human task reads isolate workspace membership (real HTTP/PostgreSQL)', () => {
  const pg = createDisposablePostgres('human-task-read-isolation');
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let tasksService: TasksService;
  const users: string[] = [], workspaces: string[] = [], projects: string[] = [], tasks: string[] = [], tokens: string[] = [];
  beforeAll(async () => {
    await pg.start();
    process.env.DATABASE_URL = pg.url();
    const mod = await Test.createTestingModule({ imports: [FixtureModule] })
      .overrideProvider(KanbanService).useValue({ notify() {} }).compile();
    app = mod.createNestApplication();
    app.useLogger(false);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = mod.get(PrismaService); auth = mod.get(AuthService);
    tasksService = mod.get(TasksService);
    for (let i = 0; i < 2; i++) {
      const user = await prisma.user.create({ data: { name: 'Synthetic reader' } });
      const ws = await mod.get(WorkspacesService).create(user.id, { slug: randomUUID(), name: 'Synthetic workspace' });
      const project = await prisma.project.create({ data: { workspaceId: ws.id, slug: randomUUID(), name: 'Synthetic project' } });
      const task = await prisma.task.create({ data: { projectId: project.id, title: 'Synthetic task', actorType: 'human', createdById: user.id } });
      await prisma.$transaction(tx => mod.get(TaskFieldStateService).recompute(tx, task));
      users.push(user.id); workspaces.push(ws.id); projects.push(project.id); tasks.push(task.id); tokens.push(auth.signAccess(user.id));
    }
  }, 120_000);
  afterAll(async () => { if (app) await app.close(); await pg.stop(); }, 120_000);
  const taskRoutes = ['', '/evidence', '/checklist', '/activity', '/dependencies', '/dependency-graph', '/readiness'];
  for (const suffix of taskRoutes) {
    it(`own task ${suffix || 'row'} is readable`, async () => {
      await supertest(app.getHttpServer()).get(`/tasks/${tasks[0]}${suffix}`).auth(tokens[0], { type: 'bearer' }).expect(200);
    });
    it(`foreign task ${suffix || 'row'} is denied`, async () => {
      await supertest(app.getHttpServer()).get(`/tasks/${tasks[1]}${suffix}`).auth(tokens[0], { type: 'bearer' }).expect(403);
    });
    it(`anonymous task ${suffix || 'row'} is denied`, async () => {
      await supertest(app.getHttpServer()).get(`/tasks/${tasks[1]}${suffix}`).expect(401);
    });
  }
  it('global list and its total contain only memberships', async () => {
    const r = await supertest(app.getHttpServer()).get('/tasks').auth(tokens[0], { type: 'bearer' }).expect(200);
    expect(r.body.total).toBe(1); expect(r.body.items.map((x: { id: string }) => x.id)).toEqual([tasks[0]]);
  });
  it('foreign project filter is denied', async () => {
    await supertest(app.getHttpServer()).get(`/tasks?projectId=${projects[1]}`).auth(tokens[0], { type: 'bearer' }).expect(403);
  });
  for (const suffix of ['', '/staleness']) {
    it(`own project ${suffix || 'list'} is readable`, async () => {
      await supertest(app.getHttpServer()).get(`/tasks/project/${projects[0]}${suffix}`).auth(tokens[0], { type: 'bearer' }).expect(200);
    });
    it(`foreign project ${suffix || 'list'} is denied`, async () => {
      await supertest(app.getHttpServer()).get(`/tasks/project/${projects[1]}${suffix}`).auth(tokens[0], { type: 'bearer' }).expect(403);
    });
  }
  it('human index remains unavailable, even for own project', async () => {
    await supertest(app.getHttpServer()).get(`/tasks/project/${projects[0]}/index`).auth(tokens[0], { type: 'bearer' }).expect(403);
  });
  it('foreign git references are denied', async () => {
    await supertest(app.getHttpServer()).get(`/projects/tasks/${tasks[1]}/git-refs`).auth(tokens[0], { type: 'bearer' }).expect(403);
  });
  it('foreign HEAD and conditional GET do not bypass authorization', async () => {
    await supertest(app.getHttpServer()).head(`/tasks/${tasks[1]}`).auth(tokens[0], { type: 'bearer' }).expect(403);
    await supertest(app.getHttpServer()).get(`/tasks/${tasks[1]}`).set('If-None-Match', '*').auth(tokens[0], { type: 'bearer' }).expect(403);
  });
  it('foreign dependency counterpart fails closed instead of claiming readiness', async () => {
    const edge = await prisma.taskDependency.create({ data: { fromTaskId: tasks[0], toTaskId: tasks[1], type: 'depends_on' } });
    try {
      for (const suffix of ['/dependencies', '/dependency-graph', '/readiness']) {
        await supertest(app.getHttpServer()).get(`/tasks/${tasks[0]}${suffix}`).auth(tokens[0], { type: 'bearer' }).expect(403);
      }
    } finally { await prisma.taskDependency.delete({ where: { id: edge.id } }); }
  });
  it('membership revocation takes effect on the next request', async () => {
    const own = await supertest(app.getHttpServer()).get(`/tasks/${tasks[0]}`).auth(tokens[0], { type: 'bearer' }).expect(200);
    expect(own.headers.etag).toBeTruthy();
    await supertest(app.getHttpServer()).get(`/tasks/${tasks[0]}`).set('If-None-Match', own.headers.etag).auth(tokens[0], { type: 'bearer' }).expect(304);
    await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: workspaces[0], userId: users[0] } } });
    try {
      await supertest(app.getHttpServer()).get(`/tasks/${tasks[0]}`).auth(tokens[0], { type: 'bearer' }).expect(403);
      await supertest(app.getHttpServer()).get(`/tasks/${tasks[0]}`).set('If-None-Match', own.headers.etag).auth(tokens[0], { type: 'bearer' }).expect(403);
      const r = await supertest(app.getHttpServer()).get('/tasks').auth(tokens[0], { type: 'bearer' }).expect(200);
      expect(r.body.total).toBe(0);
    } finally { await prisma.workspaceMember.create({ data: { workspaceId: workspaces[0], userId: users[0], role: 'owner' } }); }
  });
  for (const role of ['owner', 'manager', 'developer', 'viewer']) {
    it(`existing ${role} membership authorizes reading`, async () => {
      await prisma.workspaceMember.create({ data: { workspaceId: workspaces[1], userId: users[0], role } });
      try { await supertest(app.getHttpServer()).get(`/tasks/${tasks[1]}`).auth(tokens[0], { type: 'bearer' }).expect(200); }
      finally { await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: workspaces[1], userId: users[0] } } }); }
    });
  }
  it('moving the task into a foreign project revokes reading', async () => {
    await prisma.task.update({ where: { id: tasks[0] }, data: { projectId: projects[1] } });
    try { await supertest(app.getHttpServer()).get(`/tasks/${tasks[0]}`).auth(tokens[0], { type: 'bearer' }).expect(403); }
    finally { await prisma.task.update({ where: { id: tasks[0] }, data: { projectId: projects[0] } }); }
  });
  it('expired tokens and anonymous collection requests fail authentication', async () => {
    process.env.JWT_ACCESS_EXPIRES = '-1s';
    let expired: string;
    try { expired = auth.signAccess(users[0]); } finally { delete process.env.JWT_ACCESS_EXPIRES; }
    await supertest(app.getHttpServer()).get(`/tasks/${tasks[0]}`).auth(expired, { type: 'bearer' }).expect(401);
    await supertest(app.getHttpServer()).get('/tasks').expect(401);
    await supertest(app.getHttpServer()).get(`/tasks/project/${projects[0]}`).expect(401);
  });
  it('malformed task ids fail closed', async () => {
    await supertest(app.getHttpServer()).get('/tasks/not-a-uuid').auth(tokens[0], { type: 'bearer' }).expect(403);
  });
  it('the second workspace has symmetric own/foreign isolation', async () => {
    await supertest(app.getHttpServer()).get(`/tasks/${tasks[1]}`).auth(tokens[1], { type: 'bearer' }).expect(200);
    await supertest(app.getHttpServer()).get(`/tasks/${tasks[0]}`).auth(tokens[1], { type: 'bearer' }).expect(403);
  });
  it('service rejects a foreign dependency inserted after the guard admitted the root', async () => {
    const context = { switchToHttp: () => ({ getRequest: () => ({
      method: 'GET', path: `/tasks/${tasks[0]}/dependencies`, params: { taskId: tasks[0] }, query: {}, user: { id: users[0] },
    }) }) } as unknown as ExecutionContext;
    await expect(new HumanTaskReadGuard(prisma).canActivate(context)).resolves.toBe(true);
    const edge = await prisma.taskDependency.create({ data: { fromTaskId: tasks[0], toTaskId: tasks[1], type: 'depends_on' } });
    try {
      await expect(tasksService.getDependencies(tasks[0], users[0])).rejects.toMatchObject({ status: 403 });
      await expect(tasksService.getDependencyGraph(tasks[0], undefined, users[0])).rejects.toMatchObject({ status: 403 });
      await expect(tasksService.getReadiness(tasks[0], undefined, users[0])).rejects.toMatchObject({ status: 403 });
    } finally { await prisma.taskDependency.delete({ where: { id: edge.id } }); }
  });
});
