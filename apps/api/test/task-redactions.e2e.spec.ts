/**
 * MUN-0049 (e2e) — `POST /tasks/:taskId/redactions` over real HTTP against the
 * DATABASE_URL database: the assigned agent's key removes exactly the span the
 * kb-sync scanner named, the record and the activity row carry hashes only,
 * the field-state hash and the KB change registry move, a repeat is
 * idempotent, and every refusal is real (stranger, other workspace, no key,
 * wrong hash, dirty replacement). Every "secret" is synthetic, shaped to match
 * a rule, and never appears in a response or an activity payload.
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
import { TaskFieldStateService } from '../src/tasks/field-state/task-field-state.service.js';
import { sha256Hex } from '../src/tasks/redactions/secret-rules.js';
import { REDACTION_ACTION } from '../src/tasks/redactions/task-redaction.service.js';

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

const HVS = 'hvs.' + 'SyntheticTestToken' + '0'.repeat(10);
const PGP = 'PGPASSWORD=' + 'synthetic' + 'a'.repeat(12);
const marker = (rule: string, span: string) =>
  `[REDACTED ${rule} sha256:${sha256Hex(span).slice(0, 16)} — removed 2026-09-13 KBSYNC-0]`;

describe('POST /tasks/:taskId/redactions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;
  let fsSvc: TaskFieldStateService;

  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;
  let assignedAgentId: string;
  let assignedKey: string;
  let strangerKey: string;
  let foreignKey: string;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [TestAppModule] })
      .overrideProvider(KanbanService)
      .useValue({ notify: () => void 0 })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
    authSvc = moduleRef.get(AuthService);
    fsSvc = moduleRef.get(TaskFieldStateService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const id = uuidv4().slice(0, 8);
    const user = await prisma.user.create({ data: { name: `mun0049-${id}` } });
    workspaceId = (await prisma.workspace.create({ data: { slug: `ws-${id}`, name: `WS ${id}`, ownerId: user.id } })).id;
    otherWorkspaceId = (await prisma.workspace.create({ data: { slug: `ws-o-${id}`, name: `O ${id}`, ownerId: user.id } })).id;
    projectId = (await prisma.project.create({ data: { workspaceId, slug: `proj-${id}`, name: `Proj ${id}` } })).id;

    const assigned = await prisma.agent.create({ data: { workspaceId, name: `assigned-${id}` } });
    assignedAgentId = assigned.id;
    const stranger = await prisma.agent.create({ data: { workspaceId, name: `stranger-${id}` } });
    const foreign = await prisma.agent.create({ data: { workspaceId: otherWorkspaceId, name: `foreign-${id}` } });
    assignedKey = (await authSvc.createApiKey(assigned.id, 'assigned')).key;
    strangerKey = (await authSvc.createApiKey(stranger.id, 'stranger')).key;
    foreignKey = (await authSvc.createApiKey(foreign.id, 'foreign')).key;
  });

  afterEach(async () => {
    const taskIds = (await prisma.task.findMany({ where: { projectId }, select: { id: true } })).map((r) => r.id);
    if (taskIds.length > 0) {
      await prisma.taskAgent.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.taskFieldState.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.activityLog.deleteMany({ where: { taskId: { in: taskIds } } });
      // task_redactions rows cascade with the task.
      await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    }
    await prisma.project.delete({ where: { id: projectId } }).catch(() => void 0);
    for (const wid of [workspaceId, otherWorkspaceId]) {
      await prisma.activityLog.deleteMany({ where: { workspaceId: wid } });
      await prisma.workspace.delete({ where: { id: wid } }).catch(() => void 0);
    }
  });

  async function createTask(title: string, description: string | null = null) {
    const task = await prisma.task.create({
      data: { projectId, title, description, status: 'review', priority: 'high', actorType: 'human' },
    });
    await prisma.$transaction(async (tx) => {
      await fsSvc.recompute(tx, task);
    });
    await prisma.taskAgent.create({ data: { taskId: task.id, agentId: assignedAgentId, role: 'executor' } });
    return task;
  }

  const body = (span: string, rule: string, field: 'title' | 'description' = 'title') => ({
    field,
    span_sha256: sha256Hex(span),
    rule,
    replacement: marker(rule, span),
  });

  it('removes exactly the span: title, record, activity, field state and KB registry all agree', async () => {
    const title = `SEC-0076 rotate ${HVS} before the demo`;
    const task = await createTask(title);
    const fieldBefore = await prisma.taskFieldState.findUniqueOrThrow({ where: { taskId_fieldName: { taskId: task.id, fieldName: 'title' } } });
    const kbBefore = await prisma.muneralKbTaskChange.findUniqueOrThrow({ where: { taskId: task.id } });

    const res = await supertest(app.getHttpServer())
      .post(`/tasks/${task.id}/redactions`)
      .set('Authorization', `Bearer ${assignedKey}`)
      .send(body(HVS, 'vault-token-hvs'))
      .expect(201);

    const expected = `SEC-0076 rotate ${marker('vault-token-hvs', HVS)} before the demo`;
    expect(res.body).toMatchObject({
      task_id: task.id,
      field: 'title',
      rule: 'vault-token-hvs',
      span_sha256: sha256Hex(HVS),
      previous_value_sha256: sha256Hex(title),
      new_value_sha256: sha256Hex(expected),
      occurrences: 1,
      actor: { type: 'agent', id: assignedAgentId },
      idempotent: false,
    });
    expect(JSON.stringify(res.body)).not.toContain(HVS);

    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.title).toBe(expected);
    expect(after.status).toBe('review');
    expect(after.priority).toBe('high');
    expect(after.description).toBeNull();
    expect(after.revision).toBe(0);

    const record = await prisma.taskRedaction.findUniqueOrThrow({
      where: { taskId_field_spanSha256: { taskId: task.id, field: 'title', spanSha256: sha256Hex(HVS) } },
    });
    expect(record.id).toBe(res.body.redaction_id);
    expect(JSON.stringify(record)).not.toContain(HVS);

    const activity = await prisma.activityLog.findMany({ where: { taskId: task.id, action: REDACTION_ACTION } });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ actorType: 'agent', actorId: assignedAgentId, workspaceId });
    expect(JSON.stringify(activity[0].payload)).not.toContain(HVS);
    expect(activity[0].payload).toMatchObject({ redaction_id: record.id, span_sha256: sha256Hex(HVS) });

    const fieldAfter = await prisma.taskFieldState.findUniqueOrThrow({ where: { taskId_fieldName: { taskId: task.id, fieldName: 'title' } } });
    expect(fieldAfter.hash).not.toBe(fieldBefore.hash);
    expect(fieldAfter.version).toBeGreaterThan(fieldBefore.version);

    const kbAfter = await prisma.muneralKbTaskChange.findUniqueOrThrow({ where: { taskId: task.id } });
    expect(kbAfter.revision).toBeGreaterThan(kbBefore.revision);
  });

  it('a repeat is 200 idempotent: same record, no second write', async () => {
    const task = await createTask(`x ${HVS}`);
    const first = await supertest(app.getHttpServer())
      .post(`/tasks/${task.id}/redactions`).set('Authorization', `Bearer ${assignedKey}`).send(body(HVS, 'vault-token-hvs')).expect(201);
    const titleAfterFirst = (await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).title;

    const second = await supertest(app.getHttpServer())
      .post(`/tasks/${task.id}/redactions`).set('Authorization', `Bearer ${assignedKey}`).send(body(HVS, 'vault-token-hvs')).expect(200);

    expect(second.body).toMatchObject({ redaction_id: first.body.redaction_id, idempotent: true });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).title).toBe(titleAfterFirst);
    expect(await prisma.taskRedaction.count({ where: { taskId: task.id } })).toBe(1);
    expect(await prisma.activityLog.count({ where: { taskId: task.id, action: REDACTION_ACTION } })).toBe(1);
  });

  it('redacts the description by another rule and leaves the title untouched', async () => {
    const task = await createTask('clean title', `run with ${PGP} locally`);
    await supertest(app.getHttpServer())
      .post(`/tasks/${task.id}/redactions`).set('Authorization', `Bearer ${assignedKey}`).send(body(PGP, 'pgpassword', 'description')).expect(201);
    const after = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(after.title).toBe('clean title');
    expect(after.description).toBe(`run with ${marker('pgpassword', PGP)} locally`);
  });

  it('409 SPAN_NOT_FOUND for a hash that is not in the current value, and nothing changes', async () => {
    const task = await createTask(`x ${HVS}`);
    const res = await supertest(app.getHttpServer())
      .post(`/tasks/${task.id}/redactions`).set('Authorization', `Bearer ${assignedKey}`)
      .send({ ...body(HVS, 'vault-token-hvs'), span_sha256: sha256Hex('some other span') }).expect(409);
    expect(res.body).toMatchObject({ code: 'SPAN_NOT_FOUND', other_spans_of_rule: 1 });
    expect(JSON.stringify(res.body)).not.toContain(HVS);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).title).toBe(`x ${HVS}`);
    expect(await prisma.taskRedaction.count({ where: { taskId: task.id } })).toBe(0);
  });

  it('400 on a replacement the scanner would block, on an unknown rule, and on a malformed hash', async () => {
    const task = await createTask(`x ${HVS}`);
    const base = body(HVS, 'vault-token-hvs');
    const post = (b: object) =>
      supertest(app.getHttpServer()).post(`/tasks/${task.id}/redactions`).set('Authorization', `Bearer ${assignedKey}`).send(b);
    const dirty = await post({ ...base, replacement: `moved to ${HVS}` }).expect(400);
    expect(dirty.body).toMatchObject({ code: 'REPLACEMENT_NOT_CLEAN', rules: ['vault-token-hvs'] });
    await post({ ...base, rule: 'no-such-rule' }).expect(400);
    await post({ ...base, span_sha256: 'abc' }).expect(400);
    await post({ ...base, field: 'status' }).expect(400);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).title).toBe(`x ${HVS}`);
  });

  it('refuses a stranger, an agent of another workspace, and no credential at all', async () => {
    const task = await createTask(`x ${HVS}`);
    const b = body(HVS, 'vault-token-hvs');
    await supertest(app.getHttpServer()).post(`/tasks/${task.id}/redactions`).set('Authorization', `Bearer ${strangerKey}`).send(b).expect(403);
    await supertest(app.getHttpServer()).post(`/tasks/${task.id}/redactions`).set('Authorization', `Bearer ${foreignKey}`).send(b).expect(403);
    await supertest(app.getHttpServer()).post(`/tasks/${task.id}/redactions`).send(b).expect(401);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).title).toBe(`x ${HVS}`);
  });
});
