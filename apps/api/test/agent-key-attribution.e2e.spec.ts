/**
 * MUN-0066 (e2e) — per-agent mun_sk_ attribution.
 *
 * Measured defect on the hygiene parent: 510/510 activity rows shared one
 * actorId because the fleet reused one mun_sk_. This suite proves the product
 * obtain path and the write path that ends the collapse:
 *
 *   1. A human JWT can register two agents and mint two keys (obtain).
 *   2. Status + comment writes from those keys carry distinct actorIds (e2e).
 *   3. Reusing one key collapses actorIds (negative control).
 *
 * Out of scope: mass re-attribution of historical rows; live fleet credential
 * rotation on production hosts (ops via scripts/issue-agent-key.sh + protected
 * credential path — see apps/api/docs/agent-key-issuance.md).
 */
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
import { KanbanService } from '../src/ws/kanban.service.js';
import { createDisposablePostgres } from './support/disposable-postgres.js';

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

const STATUS_ACTION = 'task:status_changed';

describe('MUN-0066 per-agent mun_sk_ attribution (e2e)', () => {
  const pg = createDisposablePostgres('mun-0066-attribution');
  let app: INestApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;
  const savedUrl = process.env.DATABASE_URL;

  let userId: string;
  let workspaceId: string;
  let projectId: string;
  let humanJwt: string;

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
  }, 120_000);

  afterAll(async () => {
    if (app) await app.close();
    await pg.stop();
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
  }, 120_000);

  beforeEach(async () => {
    const id = uuidv4().slice(0, 8);
    const user = await prisma.user.create({ data: { name: `mun0066-${id}` } });
    userId = user.id;
    humanJwt = authSvc.signAccess(userId);
    workspaceId = (
      await prisma.workspace.create({
        data: { slug: `ws-mun0066-${id}`, name: `WS ${id}`, ownerId: user.id },
      })
    ).id;
    projectId = (
      await prisma.project.create({
        data: { workspaceId, slug: `proj-${id}`, name: `Proj ${id}` },
      })
    ).id;
  });

  // No per-test cascade: disposable Postgres is dropped in afterAll, and
  // fixtures use unique UUIDs. Restrict FK children of Task make a full wipe
  // brittle; leftover rows cannot collide with later assertions.

  const http = () => supertest(app.getHttpServer());

  async function obtainAgentKey(name: string, label: string) {
    const reg = await http()
      .post('/agents')
      .set('Authorization', `Bearer ${humanJwt}`)
      .send({ workspaceId, name })
      .expect(201);
    const agentId = reg.body.id as string;
    expect(agentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const minted = await http()
      .post(`/agents/${agentId}/keys`)
      .set('Authorization', `Bearer ${humanJwt}`)
      .send({ label })
      .expect((res) => {
        // Nest may answer 200 or 201 depending on controller defaults.
        if (res.status !== 200 && res.status !== 201) {
          throw new Error(`unexpected key mint status ${res.status}`);
        }
      });
    const key = minted.body.key as string;
    const keyId = (minted.body.keyId ?? minted.body.id) as string;
    expect(key.startsWith('mun_sk_')).toBe(true);
    expect(keyId).toBeTruthy();
    return { agentId, key, keyId };
  }

  it(
    'JWT obtain path: two agents get two distinct mun_sk_ keys',
    async () => {
      const a = await obtainAgentKey('runtime-a', 'runtime-a');
      const b = await obtainAgentKey('runtime-b', 'runtime-b');
      expect(a.agentId).not.toBe(b.agentId);
      expect(a.key).not.toBe(b.key);
      expect(a.keyId).not.toBe(b.keyId);

      const rows = await prisma.agent.findMany({ where: { workspaceId } });
      expect(rows).toHaveLength(2);
      const keys = await prisma.apiKey.findMany({
        where: { agentId: { in: [a.agentId, b.agentId] }, revokedAt: null },
      });
      expect(keys).toHaveLength(2);
    },
    60_000,
  );

  it(
    'status_changed and comment rows carry the issuing agent id (distinct e2e)',
    async () => {
    const a = await obtainAgentKey('lane-a', 'lane-a');
    const b = await obtainAgentKey('lane-b', 'lane-b');

    // A creates the task (creator may move status without an assignment).
    const created = await http()
      .post('/tasks')
      .set('Authorization', `Bearer ${a.key}`)
      .send({ projectId, title: 'MUN-0066 attribution probe' })
      .expect(201);
    const taskId = created.body.id as string;

    // Assign B as executor so B may comment under task scope.
    await prisma.taskAgent.create({
      data: { taskId, agentId: b.agentId, role: 'executor' },
    });

    await http()
      .patch(`/tasks/${taskId}/status`)
      .set('Authorization', `Bearer ${a.key}`)
      .send({ status: 'in_progress' })
      .expect(200);

    await http()
      .post(`/tasks/${taskId}/comments`)
      .set('Authorization', `Bearer ${b.key}`)
      .send({ body: 'CONTENT — MUN-0066 distinct-actor probe' })
      .expect(201);

    const statusRows = await prisma.activityLog.findMany({
      where: { taskId, action: STATUS_ACTION },
      orderBy: { createdAt: 'asc' },
    });
    expect(statusRows.length).toBeGreaterThanOrEqual(1);
    expect(statusRows[0].actorType).toBe('agent');
    expect(statusRows[0].actorId).toBe(a.agentId);

    const commentRows = await prisma.activityLog.findMany({
      where: { taskId, action: 'comment' },
      orderBy: { createdAt: 'asc' },
    });
    expect(commentRows.length).toBeGreaterThanOrEqual(1);
    expect(commentRows[0].actorType).toBe('agent');
    expect(commentRows[0].actorId).toBe(b.agentId);

    expect(statusRows[0].actorId).not.toBe(commentRows[0].actorId);
    },
    60_000,
  );

  it(
    'negative control: one shared key collapses status and comment actorIds',
    async () => {
      const shared = await obtainAgentKey('shared-runtime', 'shared');

      const created = await http()
        .post('/tasks')
        .set('Authorization', `Bearer ${shared.key}`)
        .send({ projectId, title: 'MUN-0066 shared-key collapse' })
        .expect(201);
      const taskId = created.body.id as string;

      await http()
        .patch(`/tasks/${taskId}/status`)
        .set('Authorization', `Bearer ${shared.key}`)
        .send({ status: 'in_progress' })
        .expect(200);

      await http()
        .post(`/tasks/${taskId}/comments`)
        .set('Authorization', `Bearer ${shared.key}`)
        .send({ body: 'same key' })
        .expect(201);

      const rows = await prisma.activityLog.findMany({
        where: {
          taskId,
          action: { in: [STATUS_ACTION, 'comment'] },
        },
      });
      expect(rows.length).toBeGreaterThanOrEqual(2);
      expect(new Set(rows.map((r) => r.actorId))).toEqual(
        new Set([shared.agentId]),
      );
    },
    60_000,
  );

  it(
    'agent key cannot mint keys or list workspace agents (issuance stays JWT)',
    async () => {
      const a = await obtainAgentKey('cannot-mint', 'cannot-mint');
      await http()
        .post('/agents')
        .set('Authorization', `Bearer ${a.key}`)
        .send({ workspaceId, name: 'sibling' })
        .expect(401);
      await http()
        .post(`/agents/${a.agentId}/keys`)
        .set('Authorization', `Bearer ${a.key}`)
        .send({ label: 'second' })
        .expect(401);
      await http()
        .get(`/agents/workspace/${workspaceId}`)
        .set('Authorization', `Bearer ${a.key}`)
        .expect(401);
    },
    60_000,
  );
});
