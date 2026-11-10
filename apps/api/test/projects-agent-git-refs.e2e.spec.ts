/**
 * MUN-0079 (e2e) — agent-scoped GET /projects/tasks/:taskId/git-refs.
 *
 * Measured gap: GET .../git-refs → 403 MUN-0043 (route existed but lacked
 * @AgentScope). Human JWT reads already worked via HumanTaskReadGuard.
 *
 * Proves:
 *   1. Creator/assigned agent receives 200 with existing git-ref rows.
 *   2. Unowned same-workspace and foreign-workspace keys get 403.
 *   3. POST/DELETE git-ref routes remain unscoped (403 MUN-0043).
 */
import supertest from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, Module } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { TasksModule } from '../src/tasks/tasks.module.js';
import { ProjectsModule } from '../src/projects/projects.module.js';
import { AgentsModule } from '../src/agents/agents.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { ActivityModule } from '../src/activity/activity.module.js';
import { WorkspacesModule } from '../src/workspaces/workspaces.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KanbanService } from '../src/ws/kanban.service.js';
import { createDisposablePostgres } from './support/disposable-postgres.js';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    ActivityModule,
    AgentsModule,
    TasksModule,
    ProjectsModule,
    WorkspacesModule,
  ],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

describe('MUN-0079 GET /projects/tasks/:taskId/git-refs (e2e)', () => {
  const pg = createDisposablePostgres('mun-0079-git-refs');
  let app: INestApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;
  const savedUrl = process.env.DATABASE_URL;

  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;
  let foreignProjectId: string;
  let agentId: string;
  let agentKey: string;
  let strangerKey: string;
  let foreignKey: string;

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
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
    authSvc = moduleRef.get(AuthService);
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    await pg.stop();
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
  }, 120_000);

  beforeEach(async () => {
    const id = uuidv4().slice(0, 8);
    const user = await prisma.user.create({ data: { name: `mun0079-${id}` } });
    workspaceId = (
      await prisma.workspace.create({
        data: { slug: `ws-${id}`, name: `WS ${id}`, ownerId: user.id },
      })
    ).id;
    otherWorkspaceId = (
      await prisma.workspace.create({
        data: { slug: `ws-f-${id}`, name: `WS F ${id}`, ownerId: user.id },
      })
    ).id;
    projectId = (
      await prisma.project.create({
        data: { workspaceId, slug: `p-${id}`, name: `P ${id}` },
      })
    ).id;
    foreignProjectId = (
      await prisma.project.create({
        data: { workspaceId: otherWorkspaceId, slug: `pf-${id}`, name: `PF ${id}` },
      })
    ).id;
    agentId = (await prisma.agent.create({ data: { workspaceId, name: `a-${id}` } })).id;
    agentKey = (await authSvc.createApiKey(agentId, 'mun-0079')).key;
    const strangerId = (
      await prisma.agent.create({ data: { workspaceId, name: `s-${id}` } })
    ).id;
    strangerKey = (await authSvc.createApiKey(strangerId, 'mun-0079-stranger')).key;
    const foreignAgentId = (
      await prisma.agent.create({ data: { workspaceId: otherWorkspaceId, name: `f-${id}` } })
    ).id;
    foreignKey = (await authSvc.createApiKey(foreignAgentId, 'mun-0079-foreign')).key;
  });

  const http = () => supertest(app.getHttpServer());

  it(
    'lists git-refs for a creator agent and refuses unowned/foreign; writes stay denied',
    async () => {
    const owned = await prisma.task.create({
      data: {
        projectId,
        title: 'owned',
        actorType: 'agent',
        createdById: agentId,
      },
    });
    const unowned = await prisma.task.create({
      data: {
        projectId,
        title: 'unowned',
        actorType: 'human',
        createdById: uuidv4(),
      },
    });
    const foreign = await prisma.task.create({
      data: {
        projectId: foreignProjectId,
        title: 'foreign',
        actorType: 'agent',
        createdById: agentId,
      },
    });
    await prisma.taskGitRef.create({
      data: {
        taskId: owned.id,
        type: 'branch',
        url: 'https://example.invalid/repo',
        ref: 'mun-0079',
      },
    });

    const ok = await http()
      .get(`/projects/tasks/${owned.id}/git-refs`)
      .auth(agentKey, { type: 'bearer' })
      .expect(200);
    expect(ok.body).toEqual([
      expect.objectContaining({
        taskId: owned.id,
        type: 'branch',
        url: 'https://example.invalid/repo',
        ref: 'mun-0079',
      }),
    ]);

    await http()
      .get(`/projects/tasks/${unowned.id}/git-refs`)
      .auth(agentKey, { type: 'bearer' })
      .expect(403);
    await http()
      .get(`/projects/tasks/${unowned.id}/git-refs`)
      .auth(strangerKey, { type: 'bearer' })
      .expect(403);
    await http()
      .get(`/projects/tasks/${foreign.id}/git-refs`)
      .auth(agentKey, { type: 'bearer' })
      .expect(403);
    await http()
      .get(`/projects/tasks/${owned.id}/git-refs`)
      .auth(foreignKey, { type: 'bearer' })
      .expect(403);

    await http()
      .post('/projects/git-refs')
      .auth(agentKey, { type: 'bearer' })
      .send({ taskId: owned.id, type: 'branch', url: 'https://example.invalid/x' })
      .expect(403);
    await http()
      .delete(`/projects/git-refs/${ok.body[0].id}`)
      .auth(agentKey, { type: 'bearer' })
      .expect(403);
    },
    60_000,
  );
});
