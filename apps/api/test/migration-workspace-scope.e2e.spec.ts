/**
 * MUN-0053 (e2e) — the workspace wall of the migration surface, and the agent
 * key's self-revocation, over real HTTP against the DATABASE_URL database.
 *
 * Found by MUN-0052's adversarial review and verified from code at 7bf0da87:
 * `POST /migration/work-items/:taskId/transitions` ran `ApiKeyGuard` alone and
 * `MigrationService.transition` read the task by id with no workspace clause,
 * so any valid key of any workspace could CAS-move any task (`revision` is 0 on
 * a task this path never moved). `search`, `by-legacy`, batches, decisions and
 * mappings answered across workspaces the same way.
 *
 * One test per route, each with both halves: the caller of the owning workspace
 * gets its answer, a caller of another workspace gets the route's not-found and
 * leaves no trace. The transition additionally follows MUN-0050's rule inside
 * the workspace: the creator or an executor moves the card, a stranger does not.
 */
import supertest from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, Module } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AgentsModule } from '../src/agents/agents.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { ActivityModule } from '../src/activity/activity.module.js';
import { MigrationModule } from '../src/migration/migration.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthService } from '../src/auth/auth.service.js';

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, MigrationModule],
})
class TestAppModule {}

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('Migration routes are scoped to the caller workspace (e2e, MUN-0053)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;

  let run: string;
  let homeUserId: string;
  let foreignUserId: string;
  let homeWs: string;
  let foreignWs: string;
  let homeProject: string;
  let foreignProject: string;
  let importerId: string;
  let executorId: string;
  let importerKey: string;
  let executorKey: string;
  let strangerKey: string;
  let foreignKey: string;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [TestAppModule],
    }).compile();
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
    run = uuidv4().slice(0, 8);
    homeUserId = (await prisma.user.create({ data: { name: `mun0053-home-${run}` } })).id;
    foreignUserId = (await prisma.user.create({ data: { name: `mun0053-foreign-${run}` } })).id;
    homeWs = (
      await prisma.workspace.create({
        data: { slug: `m53-home-${run}`, name: `Home ${run}`, ownerId: homeUserId },
      })
    ).id;
    foreignWs = (
      await prisma.workspace.create({
        data: { slug: `m53-foreign-${run}`, name: `Foreign ${run}`, ownerId: foreignUserId },
      })
    ).id;
    await prisma.workspaceMember.create({
      data: { workspaceId: homeWs, userId: homeUserId, role: 'owner' },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: foreignWs, userId: foreignUserId, role: 'owner' },
    });
    homeProject = (
      await prisma.project.create({
        data: { workspaceId: homeWs, slug: `p-${run}`, name: `P ${run}` },
      })
    ).id;
    foreignProject = (
      await prisma.project.create({
        data: { workspaceId: foreignWs, slug: `fp-${run}`, name: `FP ${run}` },
      })
    ).id;
    const agent = async (name: string, ws: string) =>
      (await prisma.agent.create({ data: { workspaceId: ws, name: `${name}-${run}` } })).id;
    importerId = await agent('importer', homeWs);
    executorId = await agent('executor', homeWs);
    const strangerId = await agent('stranger', homeWs);
    const foreignId = await agent('foreign', foreignWs);
    importerKey = (await authSvc.createApiKey(importerId, 'importer')).key;
    executorKey = (await authSvc.createApiKey(executorId, 'executor')).key;
    strangerKey = (await authSvc.createApiKey(strangerId, 'stranger')).key;
    foreignKey = (await authSvc.createApiKey(foreignId, 'foreign')).key;
  });

  afterEach(async () => {
    // Migration rows are append-only (identities, occurrences, batches keep
    // their projects alive), so the workspaces may survive. The keys and agents
    // go explicitly: every key left behind is one more bcrypt comparison on
    // every later request (see tasks-agent-status.e2e.spec.ts).
    for (const ws of [homeWs, foreignWs]) {
      await prisma.apiKey.deleteMany({ where: { agent: { workspaceId: ws } } });
      await prisma.taskAgent.deleteMany({ where: { agent: { workspaceId: ws } } });
      await prisma.agent.deleteMany({ where: { workspaceId: ws } });
    }
  });

  const http = () => supertest(app.getHttpServer());
  const bearer = (token: string) => `Bearer ${token}`;

  const openBatch = async (key: string, projectId: string) => {
    const res = await http()
      .post('/migration/batches')
      .set('Authorization', bearer(key))
      .send({ batchKey: `b-${uuidv4()}`, sourceSetEpoch: 'e', producer: 'mun0053', projectId })
      .expect(201);
    return res.body.id as string;
  };

  const importItem = (key: string, batchId: string, ns: string, legacyId: string) =>
    http()
      .post('/migration/work-items')
      .set('Authorization', bearer(key))
      .send({
        batchId,
        sourceNamespace: ns,
        legacyId,
        title: `Card ${legacyId}`,
        historicalStatus: 'todo',
        idempotencyKey: `wi-${uuidv4()}`,
        occurrence: {
          sourceRoot: ns,
          sourceLocator: `${ns}/tasks.md#${legacyId}-${uuidv4().slice(0, 4)}`,
          sourceKey: `heading:${legacyId}`,
          contentDigest: digest(`${legacyId}-${uuidv4()}`),
          capturedAt: '2026-09-14T00:00:00.000Z',
        },
      });

  /** A home work item imported by the importer key. */
  const homeItem = async () => {
    const ns = `m53/${run}`;
    const legacyId = `M53-${uuidv4().slice(0, 6)}`;
    const batchId = await openBatch(importerKey, homeProject);
    const res = await importItem(importerKey, batchId, ns, legacyId).expect(201);
    return {
      ns,
      legacyId,
      batchId,
      taskId: res.body.workItem.id as string,
      identityId: res.body.identity.id as string,
    };
  };

  const transition = (key: string, taskId: string, body: Record<string, unknown> = {}) =>
    http()
      .post(`/migration/work-items/${taskId}/transitions`)
      .set('Authorization', bearer(key))
      .send({
        expectedRevision: 0,
        toStatus: 'in_progress',
        idempotencyKey: `t-${uuidv4()}`,
        basis: 'mun0053',
        ...body,
      });

  /** An occurrence recorded on a home identity by a batch of the foreign
   *  workspace — the shape rows written before MUN-0053 may have. */
  const seedForeignOccurrence = async (identityId: string) => {
    const foreignBatch = await openBatch(foreignKey, foreignProject);
    await prisma.sourceOccurrence.create({
      data: {
        legacyIdentityId: identityId,
        batchId: foreignBatch,
        sourceRoot: 'foreign',
        sourceLocator: `foreign/tasks.md#${uuidv4()}`,
        sourceKey: 'heading:foreign',
        contentDigest: digest(uuidv4()),
        capturedAt: new Date('2026-09-14T00:00:00.000Z'),
        historicalStatus: 'todo',
      },
    });
  };

  const taskState = (id: string) =>
    prisma.task.findUniqueOrThrow({ where: { id }, select: { status: true, revision: true } });

  const transitionRows = (taskId: string) =>
    prisma.activityLog.count({ where: { taskId, action: 'migration.transition' } });

  // -------------------------------------------------------------------------
  // transitions
  // -------------------------------------------------------------------------

  describe('POST /migration/work-items/:taskId/transitions', () => {
    it('the importing key is the creator and moves its own work item', async () => {
      const item = await homeItem();
      const task = await prisma.task.findUniqueOrThrow({ where: { id: item.taskId } });
      expect(task.createdById).toBe(importerId);
      expect(task.actorType).toBe('agent');

      const res = await transition(importerKey, item.taskId).expect(200);
      expect(res.body).toMatchObject({ fromStatus: 'todo', toStatus: 'in_progress', revision: 1 });
      expect(await taskState(item.taskId)).toEqual({ status: 'in_progress', revision: 1 });
    });

    it('an executor of the workspace moves a task it did not create', async () => {
      const item = await homeItem();
      await prisma.taskAgent.create({
        data: { taskId: item.taskId, agentId: executorId, role: 'executor' },
      });
      await transition(executorKey, item.taskId).expect(200);
      expect(await taskState(item.taskId)).toEqual({ status: 'in_progress', revision: 1 });
    });

    it('a key of ANOTHER workspace gets 404 and moves nothing — same body as an unknown task', async () => {
      const item = await homeItem();
      const res = await transition(foreignKey, item.taskId).expect(404);
      expect(res.body.code).toBe('WORK_ITEM_NOT_FOUND');
      const unknown = uuidv4();
      const miss = await transition(foreignKey, unknown).expect(404);
      expect(Object.keys(res.body).sort()).toEqual(Object.keys(miss.body).sort());

      expect(await taskState(item.taskId)).toEqual({ status: 'todo', revision: 0 });
      expect(await transitionRows(item.taskId)).toBe(0);
    });

    it('a stranger of the SAME workspace (neither creator nor executor) gets 404 and moves nothing', async () => {
      const item = await homeItem();
      await transition(strangerKey, item.taskId).expect(404);
      expect(await taskState(item.taskId)).toEqual({ status: 'todo', revision: 0 });
      expect(await transitionRows(item.taskId)).toBe(0);
    });

    it('a creator row naming an agent of another workspace is not a grant across the wall', async () => {
      const item = await homeItem();
      const foreignAgent = await prisma.agent.findFirstOrThrow({
        where: { workspaceId: foreignWs },
      });
      await prisma.task.update({
        where: { id: item.taskId },
        data: { createdById: foreignAgent.id, actorType: 'agent' },
      });
      await transition(foreignKey, item.taskId).expect(404);
      expect(await taskState(item.taskId)).toEqual({ status: 'todo', revision: 0 });
    });

    it('a foreign key replaying the owner idempotency key does not get the stored response', async () => {
      const item = await homeItem();
      const idempotencyKey = `t-${uuidv4()}`;
      await transition(importerKey, item.taskId, { idempotencyKey }).expect(200);
      const res = await transition(foreignKey, item.taskId, { idempotencyKey }).expect(404);
      expect(res.body.revision).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // reads: by-legacy, search
  // -------------------------------------------------------------------------

  describe('GET /migration/work-items/by-legacy/:ns/:legacyId', () => {
    it('answers the owning workspace (key and member JWT); 404 to a foreign key and a non-member JWT', async () => {
      const item = await homeItem();
      await seedForeignOccurrence(item.identityId);
      const path = `/migration/work-items/by-legacy/${encodeURIComponent(item.ns)}/${item.legacyId}`;

      const own = await http().get(path).set('Authorization', bearer(importerKey)).expect(200);
      expect(own.body.workItem.id).toBe(item.taskId);
      expect(own.body.occurrences).toHaveLength(1);
      await http().get(path).set('Authorization', bearer(authSvc.signAccess(homeUserId))).expect(200);

      const foreign = await http().get(path).set('Authorization', bearer(foreignKey)).expect(404);
      expect(foreign.body.code).toBe('WORK_ITEM_NOT_FOUND');
      expect(JSON.stringify(foreign.body)).not.toContain(item.taskId);
      await http()
        .get(path)
        .set('Authorization', bearer(authSvc.signAccess(foreignUserId)))
        .expect(404);
    });
  });

  describe('GET /migration/work-items/search', () => {
    it('lists identities of the caller workspace only', async () => {
      const item = await homeItem();
      // The same legacy id in a namespace of the foreign workspace.
      const foreignBatch = await openBatch(foreignKey, foreignProject);
      const foreignNs = `m53-foreign/${run}`;
      await importItem(foreignKey, foreignBatch, foreignNs, item.legacyId).expect(201);

      const search = (token: string) =>
        http()
          .get(`/migration/work-items/search?legacyId=${item.legacyId}`)
          .set('Authorization', bearer(token))
          .expect(200);

      await seedForeignOccurrence(item.identityId);
      const home = await search(importerKey);
      expect(home.body.total).toBe(1);
      expect(home.body.identities[0].occurrenceCount).toBe(1);
      expect(home.body.identities.map((i: { sourceNamespace: string }) => i.sourceNamespace)).toEqual([
        item.ns,
      ]);
      const foreign = await search(foreignKey);
      expect(foreign.body.total).toBe(1);
      expect(foreign.body.identities[0].sourceNamespace).toBe(foreignNs);
      expect((await search(authSvc.signAccess(homeUserId))).body.total).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // writes: batches, work items, decisions
  // -------------------------------------------------------------------------

  describe('POST /migration/batches', () => {
    it('opens a batch on a project of the key workspace; 404 on a foreign project, nothing written', async () => {
      await openBatch(importerKey, homeProject);
      const batchKey = `b-${uuidv4()}`;
      const res = await http()
        .post('/migration/batches')
        .set('Authorization', bearer(foreignKey))
        .send({ batchKey, sourceSetEpoch: 'e', producer: 'mun0053', projectId: homeProject })
        .expect(404);
      expect(res.body.code).toBe('PROJECT_NOT_FOUND');
      expect(await prisma.migrationBatch.count({ where: { batchKey } })).toBe(0);
    });
  });

  describe('GET /migration/batches/:batchId and POST .../commit', () => {
    it('reads and commits a batch of the key workspace; 404 to a foreign key, batch stays open', async () => {
      const batchId = await openBatch(importerKey, homeProject);
      await http()
        .get(`/migration/batches/${batchId}`)
        .set('Authorization', bearer(importerKey))
        .expect(200);
      await http()
        .get(`/migration/batches/${batchId}`)
        .set('Authorization', bearer(foreignKey))
        .expect(404);

      await http()
        .post(`/migration/batches/${batchId}/commit`)
        .set('Authorization', bearer(foreignKey))
        .expect(404);
      expect((await prisma.migrationBatch.findUniqueOrThrow({ where: { id: batchId } })).status).toBe(
        'open',
      );
      await http()
        .post(`/migration/batches/${batchId}/commit`)
        .set('Authorization', bearer(importerKey))
        .expect(200);
    });
  });

  describe('POST /migration/work-items', () => {
    it('a foreign key cannot import into a home batch (404) nor attach a receipt to a home work item (409, no foreign ids)', async () => {
      const item = await homeItem();
      const before = await prisma.sourceOccurrence.count({
        where: { legacyIdentityId: item.identityId },
      });

      const intoHomeBatch = await importItem(foreignKey, item.batchId, item.ns, 'M53-OTHER').expect(
        404,
      );
      expect(intoHomeBatch.body.code).toBe('BATCH_NOT_FOUND');

      const foreignBatch = await openBatch(foreignKey, foreignProject);
      const collision = await importItem(foreignKey, foreignBatch, item.ns, item.legacyId).expect(
        409,
      );
      expect(collision.body.code).toBe('LEGACY_IDENTITY_OUTSIDE_WORKSPACE');
      const text = JSON.stringify(collision.body);
      expect(text).not.toContain(item.taskId);
      expect(text).not.toContain(homeProject);

      expect(
        await prisma.sourceOccurrence.count({ where: { legacyIdentityId: item.identityId } }),
      ).toBe(before);

      // The home importer still adds a receipt to its own work item.
      const again = await importItem(importerKey, item.batchId, item.ns, item.legacyId).expect(201);
      expect(again.body.workItem.id).toBe(item.taskId);
    });
  });

  describe('identity decisions and mappings', () => {
    it('decide and mappings answer the owning workspace; 404 to a foreign key, no mapping written', async () => {
      const a = await homeItem();
      const b = await homeItem();
      const decide = (key: string, idempotent = 0) =>
        http()
          .post(`/migration/identities/${a.identityId}/decisions`)
          .set('Authorization', bearer(key))
          .send({
            kind: 'candidate_conflict',
            targets: [b.identityId],
            basis: 'mun0053',
            expectedMappingRevision: idempotent,
          });

      await decide(foreignKey).expect(404);
      expect(await prisma.identityMapping.count({ where: { fromIdentityId: a.identityId } })).toBe(0);
      await http()
        .get(`/migration/identities/${a.identityId}/mappings`)
        .set('Authorization', bearer(foreignKey))
        .expect(404);

      await decide(importerKey).expect(200);
      const own = await http()
        .get(`/migration/identities/${a.identityId}/mappings`)
        .set('Authorization', bearer(importerKey))
        .expect(200);
      expect(own.body.identity.id).toBe(a.identityId);
    });
  });

  describe('identity decisions — the subject is scoped on its own', () => {
    it('a foreign key naming a home SUBJECT with its own target gets 404 and writes no mapping', async () => {
      const home = await homeItem();
      const foreignBatch = await openBatch(foreignKey, foreignProject);
      const own = await importItem(foreignKey, foreignBatch, `m53-foreign/${run}`, 'M53-OWN').expect(201);
      const ownIdentity = own.body.identity.id as string;

      await http()
        .post(`/migration/identities/${home.identityId}/decisions`)
        .set('Authorization', bearer(foreignKey))
        .send({
          kind: 'candidate_conflict',
          targets: [ownIdentity],
          basis: 'mun0053',
          expectedMappingRevision: 0,
        })
        .expect(404);
      expect(
        await prisma.identityMapping.count({
          where: { OR: [{ fromIdentityId: home.identityId }, { toIdentityId: home.identityId }] },
        }),
      ).toBe(0);
      expect(
        (await prisma.legacyIdentity.findUniqueOrThrow({ where: { id: home.identityId } }))
          .mappingRevision,
      ).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // POST /agents/keys/self/revoke
  // -------------------------------------------------------------------------

  describe('POST /agents/keys/self/revoke', () => {
    it('a key revokes itself: 200, one audit row, then 401 everywhere; the agent other key still works', async () => {
      const second = await authSvc.createApiKey(importerId, 'second');
      const first = await prisma.apiKey.findFirstOrThrow({
        where: { agentId: importerId, label: 'importer' },
      });

      const res = await http()
        .post('/agents/keys/self/revoke')
        .set('Authorization', bearer(importerKey))
        .expect(200);
      expect(res.body).toMatchObject({ keyId: first.id, agentId: importerId });

      expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: first.id } })).revokedAt).not.toBeNull();
      expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: second.keyId } })).revokedAt).toBeNull();
      const rows = await prisma.activityLog.findMany({
        where: { workspaceId: homeWs, action: 'agent:api_key_self_revoked' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorType: 'agent', actorId: importerId, taskId: null });
      expect(rows[0].payload).toEqual({ keyId: first.id });

      await http().post('/agents/keys/self/revoke').set('Authorization', bearer(importerKey)).expect(401);
      await http()
        .get(`/migration/work-items/search?legacyId=x`)
        .set('Authorization', bearer(importerKey))
        .expect(401);
      await http()
        .get(`/migration/work-items/search?legacyId=x`)
        .set('Authorization', bearer(second.key))
        .expect(200);
    });

    it('a JWT cannot use the self-revocation route (401), and no key is revoked', async () => {
      await http()
        .post('/agents/keys/self/revoke')
        .set('Authorization', bearer(authSvc.signAccess(homeUserId)))
        .expect(401);
      expect(
        await prisma.apiKey.count({ where: { agent: { workspaceId: homeWs }, revokedAt: { not: null } } }),
      ).toBe(0);
    });
  });
});
