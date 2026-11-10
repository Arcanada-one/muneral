/**
 * MUN-0080 (e2e) — agent-scoped GET /tasks/:taskId/checklist.
 *
 * Measured gap: GET .../checklist → 403 MUN-0043 (route existed but lacked
 * @AgentScope). Human JWT reads already worked.
 *
 * Proves:
 *   1. Creator/assigned agent receives 200 with existing checklist rows.
 *   2. Unowned same-workspace and foreign-workspace keys get 403.
 *   3. POST/PATCH/DELETE checklist routes remain unscoped (403 MUN-0043).
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

describe('MUN-0080 GET /tasks/:taskId/checklist (e2e)', () => {
  const pg = createDisposablePostgres('mun-0080-checklist-get');
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
    const user = await prisma.user.create({ data: { name: `mun0080-${id}` } });
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
    agentKey = (await authSvc.createApiKey(agentId, 'mun-0080')).key;
    const strangerId = (
      await prisma.agent.create({ data: { workspaceId, name: `s-${id}` } })
    ).id;
    strangerKey = (await authSvc.createApiKey(strangerId, 'mun-0080-stranger')).key;
    const foreignAgentId = (
      await prisma.agent.create({ data: { workspaceId: otherWorkspaceId, name: `f-${id}` } })
    ).id;
    foreignKey = (await authSvc.createApiKey(foreignAgentId, 'mun-0080-foreign')).key;
  });

  const http = () => supertest(app.getHttpServer());

  it(
    'lists checklist for a creator agent and refuses unowned/foreign; writes stay denied',
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
      const item = await prisma.taskChecklist.create({
        data: {
          taskId: owned.id,
          text: 'AC1 map evidence',
          position: 0,
        },
      });

      const ok = await http()
        .get(`/tasks/${owned.id}/checklist`)
        .auth(agentKey, { type: 'bearer' })
        .expect(200);
      expect(ok.body).toEqual([
        expect.objectContaining({
          id: item.id,
          taskId: owned.id,
          text: 'AC1 map evidence',
          checked: false,
        }),
      ]);

      await http()
        .get(`/tasks/${unowned.id}/checklist`)
        .auth(agentKey, { type: 'bearer' })
        .expect(403);
      await http()
        .get(`/tasks/${unowned.id}/checklist`)
        .auth(strangerKey, { type: 'bearer' })
        .expect(403);
      await http()
        .get(`/tasks/${foreign.id}/checklist`)
        .auth(agentKey, { type: 'bearer' })
        .expect(403);
      await http()
        .get(`/tasks/${owned.id}/checklist`)
        .auth(foreignKey, { type: 'bearer' })
        .expect(403);

      await http()
        .post(`/tasks/${owned.id}/checklist`)
        .auth(agentKey, { type: 'bearer' })
        .send({ text: 'must stay denied' })
        .expect(403);
      await http()
        .patch(`/tasks/${owned.id}/checklist/${item.id}`)
        .auth(agentKey, { type: 'bearer' })
        .send({ checked: true })
        .expect(403);
      await http()
        .delete(`/tasks/${owned.id}/checklist/${item.id}`)
        .auth(agentKey, { type: 'bearer' })
        .expect(403);

      const still = await prisma.taskChecklist.findUnique({ where: { id: item.id } });
      expect(still?.checked).toBe(false);
      expect(await prisma.taskChecklist.count({ where: { taskId: owned.id } })).toBe(1);
    },
    60_000,
  );
});
