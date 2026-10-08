import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { ActivityModule } from '../src/activity/activity.module.js';
import { AgentsModule } from '../src/agents/agents.module.js';
import { SyncModule } from '../src/sync/sync.module.js';
import { SyncService } from '../src/sync/sync.service.js';
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
import { JwtService } from '@nestjs/jwt';
import type { Socket, Server } from 'socket.io';
import { KanbanGateway } from '../src/ws/kanban.gateway.js';

@Module({ imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule,
  ProjectsModule, WorkspacesModule, SyncModule] })
class FixtureModule {}

describe('Human task reads isolate workspace membership (real HTTP/PostgreSQL)', () => {
  const pg = createDisposablePostgres('human-task-read-isolation');
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let tasksService: TasksService;
  const users: string[] = [], workspaces: string[] = [], projects: string[] = [], tasks: string[] = [], tokens: string[] = [];
  const counterparts: string[] = [], agentKeys: string[] = [], agentIds: string[] = [];
  const taskEtags: string[] = [];
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
      const task = await prisma.task.create({ data: { projectId: project.id, title: `Synthetic task ${i}`, status: 'in_progress', actorType: 'human', createdById: user.id } });
      const counterpart = await prisma.task.create({ data: { projectId: project.id, title: `Synthetic counterpart ${i}`, actorType: 'human', createdById: user.id } });
      counterparts.push(counterpart.id);
      await prisma.taskDependency.create({ data: { fromTaskId: task.id, toTaskId: counterpart.id, type: 'depends_on' } });
      await prisma.taskChecklist.create({ data: { taskId: task.id, text: `Synthetic checklist ${i}` } });
      await prisma.activityLog.create({ data: { taskId: task.id, workspaceId: ws.id, actorType: 'human', actorId: user.id, action: 'comment', payload: { body: `Synthetic comment ${i}` } } });
      const agent = await prisma.agent.create({ data: { workspaceId: ws.id, name: `Synthetic reader ${i}` } });
      agentIds.push(agent.id);
      agentKeys.push((await auth.createApiKey(agent.id, 'Synthetic read isolation')).key);
      await prisma.taskAgent.create({ data: { taskId: task.id, agentId: agent.id, role: 'executor' } });
      await prisma.taskEvidenceAttachment.create({ data: { taskId: task.id, uri: `https://example.test/synthetic-${i}.json`, sha256: 'a'.repeat(64), contentType: 'application/json', createdByAgentId: agent.id } });
      await prisma.taskGitRef.create({ data: { taskId: task.id, type: 'branch', url: 'https://example.test/synthetic', ref: `synthetic-${i}` } });
      await prisma.$transaction(tx => mod.get(TaskFieldStateService).recompute(tx, task));
      users.push(user.id); workspaces.push(ws.id); projects.push(project.id); tasks.push(task.id); tokens.push(auth.signAccess(user.id));
    }
    for (const i of [0,1]) {
      const own = await supertest(app.getHttpServer()).get(`/tasks/${tasks[i]}`).auth(tokens[i], { type: 'bearer' }).expect(200);
      expect(own.headers.etag).toBeTruthy(); taskEtags.push(own.headers.etag);
    }
  }, 120_000);
  afterAll(async () => { if (app) await app.close(); await pg.stop(); }, 120_000);
  const taskRoutes = ['', '/evidence', '/checklist', '/activity', '/dependencies', '/dependency-graph', '/readiness'];
  const assertDenied = (r: supertest.Response, target: number) => {
    // Express may add a weak validator for the generic error body. It must
    // never expose the protected task's actual, independently measured ETag.
    expect(r.headers.etag).not.toBe(taskEtags[target]);
    expect(r.headers['x-muneral-task-project']).toBeUndefined();
    expect(r.headers['x-muneral-dependencies']).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain(tasks[target]);
    expect(JSON.stringify(r.body)).not.toContain(`Synthetic task ${target}`);
  };
  for (const i of [0, 1]) for (const suffix of taskRoutes) {
    it(`principal ${i} own populated task ${suffix || 'row'} is readable`, async () => {
      const r = await supertest(app.getHttpServer()).get(`/tasks/${tasks[i]}${suffix}`).auth(tokens[i], { type: 'bearer' }).expect(200);
      if (suffix === '') expect(r.body).toMatchObject({ id: tasks[i], projectId: projects[i], title: `Synthetic task ${i}` });
      if (suffix === '/evidence') expect(r.body.evidence[0]).toMatchObject({ task_id: tasks[i], uri: `https://example.test/synthetic-${i}.json` });
      if (suffix === '/checklist') expect(r.body[0]).toMatchObject({ taskId: tasks[i], text: `Synthetic checklist ${i}` });
      if (suffix === '/activity') expect(r.body.data[0]).toMatchObject({ taskId: tasks[i], payload: { body: `Synthetic comment ${i}` } });
      if (suffix === '/dependencies') expect(r.body[0]).toMatchObject({ fromTaskId: tasks[i], toTaskId: counterparts[i] });
      if (suffix === '/dependency-graph') expect(r.body[0]).toMatchObject({ otherTaskId: counterparts[i], otherTaskTitle: `Synthetic counterpart ${i}` });
      if (suffix === '/readiness') { expect(r.body).toMatchObject({ taskId: tasks[i], ready: false, dependencyCount: 1 }); expect(r.body.blockedBy[0].otherTaskId).toBe(counterparts[i]); }
    });
    it(`principal ${i} foreign populated task ${suffix || 'row'} is denied`, async () => {
      const r = await supertest(app.getHttpServer()).get(`/tasks/${tasks[1-i]}${suffix}`).auth(tokens[i], { type: 'bearer' }).expect(403);
      assertDenied(r, 1-i);
    });
    it(`anonymous task ${suffix || 'row'} is denied`, async () => {
      await supertest(app.getHttpServer()).get(`/tasks/${tasks[1]}${suffix}`).expect(401);
    });
  }
  it('global list and its total contain only memberships', async () => {
    const r = await supertest(app.getHttpServer()).get('/tasks').auth(tokens[0], { type: 'bearer' }).expect(200);
    expect(r.body.total).toBe(2); expect(new Set(r.body.items.map((x: { id: string }) => x.id))).toEqual(new Set([tasks[0], counterparts[0]]));
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
    for (const i of [0,1]) {
      const own = await supertest(app.getHttpServer()).get(`/tasks/${tasks[1-i]}`).auth(tokens[1-i], { type: 'bearer' }).expect(200);
      expect(own.headers.etag).toBeTruthy();
      const head = await supertest(app.getHttpServer()).head(`/tasks/${tasks[1-i]}`).auth(tokens[i], { type: 'bearer' }).expect(403);
      assertDenied(head, 1-i);
      const conditional = await supertest(app.getHttpServer()).get(`/tasks/${tasks[1-i]}`).set('If-None-Match', own.headers.etag).auth(tokens[i], { type: 'bearer' }).expect(403);
      assertDenied(conditional, 1-i);
    }
  });
  it('foreign dependency counterpart fails closed instead of claiming readiness', async () => {
    const edge = await prisma.taskDependency.create({ data: { fromTaskId: tasks[0], toTaskId: tasks[1], type: 'depends_on' } });
    try {
      for (const suffix of ['/dependencies', '/dependency-graph', '/readiness']) {
        await supertest(app.getHttpServer()).get(`/tasks/${tasks[0]}${suffix}`).auth(tokens[0], { type: 'bearer' }).expect(403);
      }
    } finally { await prisma.taskDependency.delete({ where: { id: edge.id } }); }
  });
  it('agent assignment list excludes foreign assignments and tasks moved after assignment', async () => {
    await prisma.taskAgent.create({ data: { taskId: tasks[1], agentId: agentIds[0], role: 'executor' } });
    try {
      const own = await supertest(app.getHttpServer()).get('/agents/tasks').auth(agentKeys[0], { type: 'bearer' }).expect(200);
      expect(own.body.map((x: { taskId: string }) => x.taskId)).toEqual([tasks[0]]);
      expect(JSON.stringify(own.body)).not.toContain(tasks[1]);
      await prisma.task.update({ where: { id: tasks[0] }, data: { projectId: projects[1] } });
      const moved = await supertest(app.getHttpServer()).get('/agents/tasks').auth(agentKeys[0], { type: 'bearer' }).expect(200);
      expect(moved.body).toEqual([]);
    } finally {
      await prisma.task.update({ where: { id: tasks[0] }, data: { projectId: projects[0] } });
      await prisma.taskAgent.delete({ where: { taskId_agentId: { taskId: tasks[1], agentId: agentIds[0] } } });
    }
  });
  for (const incoming of [false, true]) {
    it(`agent refuses ${incoming ? 'incoming' : 'outgoing'} foreign dependency metadata on all three reads`, async () => {
      const edge = await prisma.taskDependency.create({ data: {
        fromTaskId: tasks[incoming ? 1 : 0], toTaskId: tasks[incoming ? 0 : 1], type: 'depends_on',
      } });
      try {
        for (const suffix of ['/dependencies', '/dependency-graph', '/readiness']) {
          const response = await supertest(app.getHttpServer()).get(`/tasks/${tasks[0]}${suffix}`).auth(agentKeys[0], { type: 'bearer' }).expect(403);
          expect(JSON.stringify(response.body)).not.toContain(tasks[1]);
          expect(response.body.ready).toBeUndefined();
        }
      } finally { await prisma.taskDependency.delete({ where: { id: edge.id } }); }
    });
  }
  it('agent same-workspace dependency status remains readable while unowned title is withheld', async () => {
    await supertest(app.getHttpServer()).get(`/tasks/${tasks[0]}/dependencies`).auth(agentKeys[0], { type: 'bearer' }).expect(200);
    const graph = await supertest(app.getHttpServer()).get(`/tasks/${tasks[0]}/dependency-graph`).auth(agentKeys[0], { type: 'bearer' }).expect(200);
    expect(graph.body[0]).toMatchObject({ otherTaskId: counterparts[0], otherTaskTitle: null, otherTaskTitleWithheld: true, otherTaskStatus: 'todo' });
    const ready = await supertest(app.getHttpServer()).get(`/tasks/${tasks[0]}/readiness`).auth(agentKeys[0], { type: 'bearer' }).expect(200);
    expect(ready.body).toMatchObject({ ready: false, dependencyCount: 1 });
  });
  it('agent dependency service rechecks a root moved after guard admission', async () => {
    await prisma.task.update({ where: { id: tasks[0] }, data: { projectId: projects[1] } });
    try {
      await expect(tasksService.getDependencies(tasks[0], undefined, agentIds[0])).rejects.toMatchObject({ status: 403 });
      await expect(tasksService.getDependencyGraph(tasks[0], agentIds[0])).rejects.toMatchObject({ status: 403 });
      await expect(tasksService.getReadiness(tasks[0], agentIds[0])).rejects.toMatchObject({ status: 403 });
    } finally { await prisma.task.update({ where: { id: tasks[0] }, data: { projectId: projects[0] } }); }
  });
  it('Kanban handlers deny foreign subscriptions and recheck revocation before delivery (real PostgreSQL)', async () => {
    const gateway = new KanbanGateway(new JwtService(), prisma);
    const rooms = new Set<string>();
    const received: unknown[] = [];
    const socket = {
      data: { userId: users[0] },
      join: async (room: string) => { rooms.add(room); },
      leave: async (room: string) => { rooms.delete(room); },
      emit: (_event: string, payload: unknown) => { received.push(payload); },
    };
    gateway.server = { in: (room: string) => ({ fetchSockets: async () => rooms.has(room) ? [socket] : [] }) } as unknown as Server;
    await gateway.handleJoinProject({ projectId: projects[1] }, socket as unknown as Socket);
    expect(rooms.size).toBe(0);
    await gateway.handleJoinProject({ projectId: projects[0] }, socket as unknown as Socket);
    expect(rooms.has(`project:${projects[0]}`)).toBe(true);
    await gateway.emit(projects[0], 'task:created', { id: tasks[0] });
    expect(received).toEqual([{ id: tasks[0] }]);
    await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: workspaces[0], userId: users[0] } } });
    try {
      await gateway.emit(projects[0], 'task:created', { id: counterparts[0] });
      expect(received).toEqual([{ id: tasks[0] }]);
      expect(rooms.size).toBe(0);
      await gateway.handleJoinProject({ projectId: projects[0] }, socket as unknown as Socket);
      expect(rooms.size).toBe(0);
    } finally { await prisma.workspaceMember.create({ data: { workspaceId: workspaces[0], userId: users[0], role: 'owner' } }); }
    await gateway.handleJoinProject({ projectId: projects[0] }, socket as unknown as Socket);
    await gateway.emit(projects[0], 'task:created', { id: counterparts[0] });
    expect(received.length).toBe(2);
    await prisma.project.update({ where: { id: projects[0] }, data: { workspaceId: workspaces[1] } });
    try {
      await gateway.emit(projects[0], 'task:created', { id: tasks[1] });
      expect(received.length).toBe(2);
      expect(rooms.size).toBe(0);
    } finally { await prisma.project.update({ where: { id: projects[0] }, data: { workspaceId: workspaces[0] } }); }
  });
  it('Kanban handlers disclose nothing when authorization storage is unavailable', async () => {
    const gateway = new KanbanGateway(new JwtService(), {
      project: { findFirst: async () => { throw new Error('Synthetic authorization store failure'); } },
    } as unknown as PrismaService);
    const received: unknown[] = [], joined: string[] = [], left: string[] = [];
    const socket = { data: { userId: users[0] },
      join: async (room: string) => { joined.push(room); },
      leave: async (room: string) => { left.push(room); },
      emit: (_event: string, payload: unknown) => { received.push(payload); },
    };
    gateway.server = { in: () => ({ fetchSockets: async () => [socket] }) } as unknown as Server;
    await gateway.handleJoinProject({ projectId: projects[0] }, socket as unknown as Socket);
    await gateway.emit(projects[0], 'task:created', { id: tasks[0] });
    expect(joined).toEqual([]); expect(received).toEqual([]);
    expect(left).toEqual([`project:${projects[0]}`, `project:${projects[0]}`]);
  });
  it('incoming foreign dependency also fails closed in both workspaces', async () => {
    const edge = await prisma.taskDependency.create({ data: { fromTaskId: tasks[1], toTaskId: tasks[0], type: 'depends_on' } });
    try {
      for (const i of [0, 1]) {
        for (const suffix of ['/dependencies', '/dependency-graph', '/readiness']) {
          const response = await supertest(app.getHttpServer()).get(`/tasks/${tasks[i]}${suffix}`).auth(tokens[i], { type: 'bearer' }).expect(403);
          assertDenied(response, 1-i);
        }
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
    const restored = await supertest(app.getHttpServer()).get(`/tasks/${tasks[0]}`).auth(tokens[0], { type: 'bearer' }).expect(200);
    expect(restored.body).toMatchObject({ id: tasks[0], projectId: projects[0] });
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
  for (const i of [0,1]) {
    it(`principal ${i} SQL pagination, project list and staleness expose only own rows`, async () => {
      const ids = new Set<string>();
      for (const offset of [0,1]) {
        const r = await supertest(app.getHttpServer()).get('/tasks').query({ projectId: projects[i], limit: 1, offset }).auth(tokens[i], { type: 'bearer' }).expect(200);
        expect(r.body.total).toBe(2); expect(r.body.items).toHaveLength(1); expect(r.body.items[0].projectId).toBe(projects[i]); ids.add(r.body.items[0].id);
      }
      expect(ids).toEqual(new Set([tasks[i], counterparts[i]]));
      const empty = await supertest(app.getHttpServer()).get('/tasks').query({ limit: 1, offset: 2 }).auth(tokens[i], { type: 'bearer' }).expect(200);
      expect(empty.body.total).toBe(2); expect(empty.body.items).toEqual([]);
      const list = await supertest(app.getHttpServer()).get(`/tasks/project/${projects[i]}`).auth(tokens[i], { type: 'bearer' }).expect(200);
      expect(new Set(list.body.map((t: { id: string }) => t.id))).toEqual(ids);
      const stale = await supertest(app.getHttpServer()).get(`/tasks/project/${projects[i]}/staleness`).auth(tokens[i], { type: 'bearer' }).expect(200);
      expect(stale.body.map((t: { taskId: string }) => t.taskId)).toEqual([tasks[i]]);
      await supertest(app.getHttpServer()).get(`/tasks/project/${projects[1-i]}`).auth(tokens[i], { type: 'bearer' }).expect(403);
      await supertest(app.getHttpServer()).get(`/tasks/project/${projects[1-i]}/staleness`).auth(tokens[i], { type: 'bearer' }).expect(403);
      const refs = await supertest(app.getHttpServer()).get(`/projects/tasks/${tasks[i]}/git-refs`).auth(tokens[i], { type: 'bearer' }).expect(200);
      expect(refs.body[0]).toMatchObject({ taskId: tasks[i], ref: `synthetic-${i}` });
      await supertest(app.getHttpServer()).get(`/projects/tasks/${tasks[1-i]}/git-refs`).auth(tokens[i], { type: 'bearer' }).expect(403);
    });
    it(`principal ${i} assigned agent read ACL is unchanged`, async () => {
      await supertest(app.getHttpServer()).get(`/tasks/${tasks[i]}`).auth(agentKeys[i], { type: 'bearer' }).expect(200);
      await supertest(app.getHttpServer()).get(`/tasks/${tasks[1-i]}`).auth(agentKeys[i], { type: 'bearer' }).expect(403);
    });
  }
  for (const i of [0, 1]) {
    it(`principal ${i} own populated sync export is readable`, async () => {
      const response = await supertest(app.getHttpServer()).get(`/sync/datarim/${projects[i]}`).auth(tokens[i], { type: 'bearer' }).expect(200);
      expect(response.text).toContain(`Synthetic task ${i}`);
      expect(response.text).toContain(`Synthetic counterpart ${i}`);
      expect(response.text).toContain('**Status:** in_progress');
      expect(response.text).not.toContain(`Synthetic task ${1-i}`);
    });
    it(`principal ${i} foreign sync export is denied`, async () => {
      const response = await supertest(app.getHttpServer()).get(`/sync/datarim/${projects[1-i]}`).auth(tokens[i], { type: 'bearer' }).expect(403);
      expect(response.text).not.toContain(`Synthetic task ${1-i}`);
      expect(response.text).not.toContain(`Synthetic counterpart ${1-i}`);
      expect(response.headers['x-muneral-task-project']).toBeUndefined();
    });
    it(`principal ${i} sync export denies revoked membership and restores the same JWT`, async () => {
      await supertest(app.getHttpServer()).get(`/sync/datarim/${projects[i]}`).auth(tokens[i], { type: 'bearer' }).expect(200);
      await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: workspaces[i], userId: users[i] } } });
      try {
        const denied = await supertest(app.getHttpServer()).get(`/sync/datarim/${projects[i]}`).auth(tokens[i], { type: 'bearer' }).expect(403);
        expect(denied.text).not.toContain(`Synthetic task ${i}`);
      } finally { await prisma.workspaceMember.create({ data: { workspaceId: workspaces[i], userId: users[i], role: 'owner' } }); }
      const restored = await supertest(app.getHttpServer()).get(`/sync/datarim/${projects[i]}`).auth(tokens[i], { type: 'bearer' }).expect(200);
      expect(restored.text).toContain(`Synthetic task ${i}`);
    });
    it(`principal ${i} sync export HEAD and conditional GET never bypass membership`, async () => {
      const target = await supertest(app.getHttpServer()).get(`/sync/datarim/${projects[1-i]}`).auth(tokens[1-i], { type: 'bearer' }).expect(200);
      expect(target.headers.etag).toBeTruthy();
      await supertest(app.getHttpServer()).get(`/sync/datarim/${projects[1-i]}`).set('If-None-Match', target.headers.etag).auth(tokens[1-i], { type: 'bearer' }).expect(304);
      const head = await supertest(app.getHttpServer()).head(`/sync/datarim/${projects[1-i]}`).auth(tokens[i], { type: 'bearer' }).expect(403);
      expect(head.headers.etag).not.toBe(target.headers.etag);
      const denied = await supertest(app.getHttpServer()).get(`/sync/datarim/${projects[1-i]}`).set('If-None-Match', target.headers.etag).auth(tokens[i], { type: 'bearer' }).expect(403);
      expect(denied.headers.etag).not.toBe(target.headers.etag);
      expect(denied.text).not.toContain(`Synthetic task ${1-i}`);
    });
    it(`principal ${i} anonymous sync export is unauthenticated`, async () => {
      await supertest(app.getHttpServer()).get(`/sync/datarim/${projects[i]}`).expect(401);
    });
  }
  it('sync export SQL rejects membership removed after guard authorization', async () => {
    const context = { switchToHttp: () => ({ getRequest: () => ({ method: 'GET', path: `/sync/datarim/${projects[0]}`, params: { projectId: projects[0] }, query: {}, user: { id: users[0] } }) }) } as unknown as ExecutionContext;
    await expect(new HumanTaskReadGuard(prisma).canActivate(context)).resolves.toBe(true);
    await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId: workspaces[0], userId: users[0] } } });
    try { await expect(app.get(SyncService).exportDatarim(projects[0], users[0])).rejects.toMatchObject({ status: 403 }); }
    finally { await prisma.workspaceMember.create({ data: { workspaceId: workspaces[0], userId: users[0], role: 'owner' } }); }
  });
});
