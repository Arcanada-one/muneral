import type { NestExpressApplication } from '@nestjs/platform-express';
import supertest from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { ValidationPipe, Module } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { TasksModule } from '../src/tasks/tasks.module.js';
import { AgentsModule } from '../src/agents/agents.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { ActivityModule } from '../src/activity/activity.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KanbanService } from '../src/ws/kanban.service.js';
import { createHash } from 'node:crypto';
import { TaskContentService } from '../src/tasks/content/task-content.service.js';

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

describe('Task graph documents (MUN-ARTIFACTS, e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;
  let contentSvc: TaskContentService;

  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;
  let executorAgentId: string;
  let executorKey: string;
  let strangerKey: string;
  let foreignKey: string;
  let creatorAgentId: string;
  let creatorKey: string;

  const http = () => supertest(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [TestAppModule] })
      .overrideProvider(KanbanService)
      .useValue({ notify: () => void 0 })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = moduleRef.get(PrismaService);
    authSvc = moduleRef.get(AuthService);
    contentSvc = moduleRef.get(TaskContentService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const id = uuidv4().slice(0, 8);
    const user = await prisma.user.create({ data: { name: `a2274-${id}` } });
    workspaceId = (
      await prisma.workspace.create({ data: { slug: `ws-a2274-${id}`, name: `WS ${id}`, ownerId: user.id } })
    ).id;
    otherWorkspaceId = (
      await prisma.workspace.create({ data: { slug: `ws-a2274-o-${id}`, name: `O ${id}`, ownerId: user.id } })
    ).id;
    projectId = (
      await prisma.project.create({ data: { workspaceId, slug: `proj-a2274-${id}`, name: `Proj ${id}` } })
    ).id;

    const executor = await prisma.agent.create({ data: { workspaceId, name: `executor-${id}` } });
    executorAgentId = executor.id;
    executorKey = (await authSvc.createApiKey(executor.id, 'executor')).key;

    const creator = await prisma.agent.create({ data: { workspaceId, name: `creator-${id}` } });
    creatorAgentId = creator.id;
    creatorKey = (await authSvc.createApiKey(creator.id, 'creator')).key;

    const stranger = await prisma.agent.create({ data: { workspaceId, name: `stranger-${id}` } });
    strangerKey = (await authSvc.createApiKey(stranger.id, 'stranger')).key;

    const foreign = await prisma.agent.create({ data: { workspaceId: otherWorkspaceId, name: `foreign-${id}` } });
    foreignKey = (await authSvc.createApiKey(foreign.id, 'foreign')).key;
  });

  afterEach(async () => {
    const taskIds = (await prisma.task.findMany({ where: { projectId }, select: { id: true } })).map((r) => r.id);
    if (taskIds.length > 0) {
      // Evidence rows cascade with the task; the agent FK is RESTRICT, so they
      // must go before the agents do — which the cascade takes care of here.
      await prisma.taskAgent.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.taskFieldState.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.activityLog.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.taskExecutionAttempt.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    }
    await prisma.project.delete({ where: { id: projectId } }).catch(() => void 0);
    for (const wid of [workspaceId, otherWorkspaceId]) {
      await prisma.activityLog.deleteMany({ where: { workspaceId: wid } });
      await prisma.workspace.delete({ where: { id: wid } }).catch(() => void 0);
    }
  });

  /** A work item the executor agent is assigned to, created by another agent. */
  async function assignedTask() {
    const task = await prisma.task.create({
      data: {
        projectId,
        title: 'A2-274 fixture',
        status: 'in_progress',
        priority: 'medium',
        createdById: creatorAgentId,
        actorType: 'agent',
      },
    });
    await prisma.taskAgent.create({
      data: { taskId: task.id, agentId: executorAgentId, role: 'executor' },
    });
    return task;
  }

  const node = (name: string) => ({ node_id: name, node_version: 1, task_id: null as string | null,
    dependencies: [] as string[], inputs: [] as Array<{ artifact_id: string; sha256: string }>, expected_outputs: [{ name: 'result', schema: 'Result/v1', version: 1, artifact_refs: [] }],
    verifier: 'HTTP readback', acceptance: ['Exact bytes and scope'], risk: 'Bounded local write', state: 'planned', budget: null });
  const taskGraph = (task: { id: string; title: string }, revision = 1) => ({ schema: 'WorkItemTaskGraph/v1', kind: 'task_graph',
    work_id: task.id, graph_revision: revision, root_goal_digest: createHash('sha256').update(task.title).digest('hex'),
    nodes: [node('first')], edges: [] as Array<{ from: string; to: string; type: string; accepted_outcome_predicate: string; schema: string; version: number; artifact_refs: Array<{ artifact_id: string; sha256: string }> }>,
    decomposition: { decision: 'no_split', reason: 'One bounded verification step' } });
  const agentGraph = (taskId: string, revision = 1) => ({ schema: 'WorkItemAgentGraph/v1', kind: 'agent_graph', work_id: taskId,
    graph_revision: revision, runs: [{ node_id: 'worker', run_id: 'run_fixture', agent_id: executorAgentId, task_id: taskId,
      attempt_id: null as string | null, attempt_binding_reason: 'Native attempt is not issued' as string | null,
      node_version: 1, retry_ordinal: null as number | null, lease_ref: null, fence: null, package_digest: null,
      state: 'working', session_id: 'session_fixture', dispatch_id: 'ctx_fixture', terminal_id: 'term_fixture', invocation_ids: [] as string[] }],
    delegations: [] as Array<{ parent_node_id: string; child_node_id: string; objective: string; invariants: string[]; context_refs: never[]; tools: string[]; budget: null; stop_escalation: string; return_schema: string }> });
  const post = (taskId: string, kind: string, document: object, expectedRevision = 0, key = executorKey) =>
    http().post(`/tasks/${taskId}/graphs/${kind}`).set('Authorization', `Bearer ${key}`).send({ expectedRevision, document });
  const read = (taskId: string, suffix: string, key = executorKey) =>
    http().get(`/tasks/${taskId}/graphs/${suffix}`).set('Authorization', `Bearer ${key}`);

  it('stores task graph content and immutable revisions with server SHA, audit and no native dependency writes', async () => {
    const task = await assignedTask();
    const doc = taskGraph(task);
    const created = await post(task.id, 'task_graph', doc).expect(201);
    const value = await read(task.id, 'task_graph').expect(200);
    expect(value.body.document).toEqual(doc);
    const bytes = Buffer.from(value.body.contentBase64, 'base64');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(created.body.sha256);
    expect(value.body).toMatchObject({ revision: 1, actorId: executorAgentId, kind: 'task_graph' });
    const byId = await http().get(`/tasks/${task.id}/artifacts/${created.body.id}`).set('Authorization', `Bearer ${executorKey}`).expect(200);
    expect(byId.body.contentBase64).toBe(value.body.contentBase64);
    const bySha = await http().get(`/tasks/${task.id}/artifacts/by-sha/${created.body.sha256}`).set('Authorization', `Bearer ${executorKey}`).expect(200);
    expect(bySha.body.contentBase64).toBe(value.body.contentBase64);
    const secondDoc = taskGraph(task, 2);
    secondDoc.nodes[0].inputs.push({ artifact_id: created.body.id, sha256: created.body.sha256 });
    await post(task.id, 'task_graph', secondDoc, 1).expect(201);
    expect((await read(task.id, 'task_graph/1').expect(200)).body.document).toEqual(doc);
    expect((await read(task.id, 'task_graph/revisions').expect(200)).body.total).toBe(2);
    expect(await prisma.taskDependency.count({ where: { fromTaskId: task.id } })).toBe(0);
    expect(await prisma.taskExecutionAttempt.count({ where: { taskId: task.id } })).toBe(0);
    const audits = await prisma.activityLog.findMany({ where: { taskId: task.id, action: 'task:content_uploaded' } });
    expect(audits).toHaveLength(2);
    await expect(prisma.$executeRaw`UPDATE task_artifact_revisions SET content = ${Buffer.from('replacement')} WHERE id = ${created.body.id}::uuid`).rejects.toThrow();
  });

  it('rejects stale and concurrent CAS without losing history or writing duplicate audit', async () => {
    const task = await assignedTask();
    await post(task.id, 'task_graph', taskGraph(task)).expect(201);
    await post(task.id, 'task_graph', taskGraph(task)).expect(409);
    const results = await Promise.all([post(task.id, 'task_graph', taskGraph(task, 2), 1), post(task.id, 'task_graph', taskGraph(task, 2), 1)]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    expect((await read(task.id, 'task_graph').expect(200)).body.revision).toBe(2);
    expect(await prisma.activityLog.count({ where: { taskId: task.id, action: 'task:content_uploaded' } })).toBe(2);
  });

  it('rejects self edges, cycles, missing and duplicate nodes and mismatched dependency/output contracts', async () => {
    const task = await assignedTask();
    const edge = { from: 'first', to: 'second', type: 'blocks', accepted_outcome_predicate: 'verified', schema: 'Result/v1', version: 1, artifact_refs: [] };
    const valid = taskGraph(task); valid.nodes.push({ ...node('second'), dependencies: ['first'] }); valid.edges.push(edge);
    await post(task.id, 'task_graph', valid).expect(201);
    const variants = [
      { ...valid, edges: [{ ...edge, to: 'first' }] },
      { ...valid, edges: [edge, { ...edge, from: 'second', to: 'first' }] },
      { ...valid, edges: [{ ...edge, to: 'missing' }] },
      { ...valid, nodes: [node('first'), node('first')] },
      { ...valid, nodes: [node('first'), node('second')] },
      { ...valid, edges: [{ ...edge, schema: 'Incompatible/v1' }] },
    ];
    for (const doc of variants) await post(task.id, 'task_graph', { ...doc, graph_revision: 2 }, 1).expect(400);
    expect((await read(task.id, 'task_graph').expect(200)).body.revision).toBe(1);
  });

  it('rejects malformed kind, work ID, revision, forged fields, wrong goal digest and size cap', async () => {
    const task = await assignedTask(); const doc = taskGraph(task);
    await post(task.id, 'dependency_graph', doc).expect(400);
    await post(task.id, 'task_graph', { ...doc, work_id: uuidv4() }).expect(400);
    await post(task.id, 'task_graph', { ...doc, graph_revision: 2 }).expect(400);
    await post(task.id, 'task_graph', { ...doc, actor_id: executorAgentId }).expect(400);
    await post(task.id, 'task_graph', { ...doc, root_goal_digest: '0'.repeat(64) }).expect(400);
    await http().post(`/tasks/${task.id}/graphs/task_graph`).set('Authorization', `Bearer ${executorKey}`).send({ expectedRevision: '0', document: doc }).expect(400);
    const large = taskGraph(task); large.nodes = Array.from({ length: 100 }, (_, i) => ({ ...node(`n${i}`), risk: 'r'.repeat(512) }));
    const oversized = await post(task.id, 'task_graph', large).expect(413);
    expect(oversized.body.message).toBe('Graph document exceeds 64 KiB');
    await read(task.id, 'task_graph/0').expect(400);
    await read(task.id, 'task_graph').expect(404);
  });

  it('pins task-owned artifact refs and existing root or direct child task identities', async () => {
    const task = await assignedTask();
    const artifact = await http().post(`/tasks/${task.id}/artifacts`).set('Authorization', `Bearer ${executorKey}`).send({ name: 'input', contentType: 'text/plain', contentBase64: Buffer.from('input').toString('base64') }).expect(201);
    const doc = taskGraph(task); doc.nodes[0].task_id = task.id;
    doc.edges = []; doc.nodes[0].inputs = [{ artifact_id: artifact.body.id, sha256: artifact.body.sha256 }];
    await post(task.id, 'task_graph', doc).expect(201);
    await post(task.id, 'task_graph', { ...doc, graph_revision: 2, nodes: [{ ...doc.nodes[0], inputs: [{ artifact_id: artifact.body.id, sha256: '0'.repeat(64) }] }] }, 1).expect(400);
    const unrelated = await assignedTask();
    await post(task.id, 'task_graph', { ...doc, graph_revision: 2, nodes: [{ ...doc.nodes[0], task_id: unrelated.id }] }, 1).expect(400);
    await post(unrelated.id, 'task_graph', { ...taskGraph(unrelated), nodes: [{ ...node('first'), inputs: doc.nodes[0].inputs }] }).expect(400);
    const child = await prisma.task.create({ data: { projectId, parentId: task.id, title: 'Native child' } });
    await post(task.id, 'task_graph', { ...doc, graph_revision: 2, nodes: [{ ...doc.nodes[0], task_id: child.id }] }, 1).expect(201);
    const foreignProject = await prisma.project.create({ data: { workspaceId: otherWorkspaceId, slug: `foreign-child-${uuidv4()}`, name: 'Foreign child project' } });
    const foreignChild = await prisma.task.create({ data: { projectId: foreignProject.id, parentId: task.id, title: 'Forged cross-workspace parent' } });
    await post(task.id, 'task_graph', { ...doc, graph_revision: 3, nodes: [{ ...doc.nodes[0], task_id: foreignChild.id }] }, 2).expect(400);
  });

  it('mirrors assigned agents and distinguishes unissued attempts from existing native attempt identities', async () => {
    const task = await assignedTask(); const doc = agentGraph(task.id);
    await post(task.id, 'agent_graph', doc).expect(201);
    expect((await read(task.id, 'agent_graph').expect(200)).body.document).toEqual(doc);
    expect(await prisma.taskExecutionAttempt.count({ where: { taskId: task.id } })).toBe(0);
    const attemptId = uuidv4();
    await prisma.taskExecutionAttempt.create({ data: { attemptId, taskId: task.id, ordinal: 1, status: 'issued', issuedAt: new Date() } });
    const next = agentGraph(task.id, 2); next.runs[0] = { ...next.runs[0], attempt_id: attemptId, attempt_binding_reason: null, retry_ordinal: 0, state: 'issued' };
    await post(task.id, 'agent_graph', next, 1).expect(201);
    await post(task.id, 'agent_graph', { ...next, graph_revision: 3, runs: [{ ...next.runs[0], attempt_id: uuidv4() }] }, 2).expect(400);
    await post(task.id, 'agent_graph', { ...next, graph_revision: 3, runs: [{ ...next.runs[0], retry_ordinal: 2 }] }, 2).expect(400);
    await post(task.id, 'agent_graph', { ...next, graph_revision: 3, runs: [{ ...next.runs[0], state: 'succeeded' }] }, 2).expect(400);
    const other = await assignedTask();
    const foreignAttempt = uuidv4();
    await prisma.taskExecutionAttempt.create({ data: { attemptId: foreignAttempt, taskId: other.id, ordinal: 1, status: 'issued', issuedAt: new Date() } });
    await post(task.id, 'agent_graph', { ...next, graph_revision: 3, runs: [{ ...next.runs[0], attempt_id: foreignAttempt }] }, 2).expect(400);
    expect((await prisma.taskExecutionAttempt.findUniqueOrThrow({ where: { attemptId } })).status).toBe('issued');
  });

  it('rejects foreign agent/attempt mirrors, duplicate run bindings/invocations and malformed delegation edges', async () => {
    const task = await assignedTask(); const doc = agentGraph(task.id);
    await post(task.id, 'agent_graph', { ...doc, runs: [{ ...doc.runs[0], agent_id: creatorAgentId }] }).expect(400);
    const foreign = await prisma.agent.findFirstOrThrow({ where: { workspaceId: otherWorkspaceId } });
    await prisma.taskAgent.create({ data: { taskId: task.id, agentId: foreign.id, role: 'reviewer' } });
    await post(task.id, 'agent_graph', { ...doc, runs: [{ ...doc.runs[0], agent_id: foreign.id }] }).expect(400);
    await post(task.id, 'agent_graph', { ...doc, runs: [{ ...doc.runs[0], task_id: uuidv4() }] }).expect(400);
    await post(task.id, 'agent_graph', { ...doc, runs: [{ ...doc.runs[0], attempt_binding_reason: null }] }).expect(400);
    await post(task.id, 'agent_graph', { ...doc, runs: [doc.runs[0], { ...doc.runs[0], node_id: 'second' }] }).expect(400);
    await post(task.id, 'agent_graph', { ...doc, runs: [{ ...doc.runs[0], invocation_ids: ['invocation_same', 'invocation_same'] }] }).expect(400);
    const delegation = { parent_node_id: 'worker', child_node_id: 'missing', objective: 'Bounded work', invariants: ['Do not widen authority'], context_refs: [], tools: [], budget: null, stop_escalation: 'Return to parent', return_schema: 'WorkerResult/v1' };
    await post(task.id, 'agent_graph', { ...doc, delegations: [delegation] }).expect(400);
    const second = { ...doc.runs[0], node_id: 'second', dispatch_id: 'ctx_second' };
    await post(task.id, 'agent_graph', { ...doc, runs: [doc.runs[0], second], delegations: [{ ...delegation, child_node_id: 'second' }] }).expect(201);
  });

  it('denies unassigned creator/stranger/foreign keys and human uploads, while permitting current dashboard members to read', async () => {
    const task = await assignedTask(); const doc = taskGraph(task);
    for (const key of [creatorKey, strangerKey, foreignKey]) {
      await post(task.id, 'task_graph', doc, 0, key).expect(403);
      await read(task.id, 'task_graph', key).expect(403);
    }
    await post(task.id, 'task_graph', doc).expect(201);
    const user = await prisma.user.create({ data: { name: 'graph-dashboard-reader' } });
    await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id, role: 'viewer' } });
    const jwt = authSvc.signAccess(user.id);
    await read(task.id, 'task_graph', jwt).expect(200);
    await post(task.id, 'task_graph', taskGraph(task, 2), 1, jwt).expect(403);
    await prisma.workspaceMember.delete({ where: { workspaceId_userId: { workspaceId, userId: user.id } } });
    await read(task.id, 'task_graph', jwt).expect(403);
    await prisma.user.delete({ where: { id: user.id } });
  });

  it('rechecks assignment inside the service and atomically rolls back graph bytes/evidence on audit failure', async () => {
    const task = await assignedTask(); const doc = taskGraph(task);
    await prisma.taskAgent.deleteMany({ where: { taskId: task.id } });
    await expect(contentSvc.storeGraph(task.id, { type: 'agent', id: executorAgentId, name: 'executor' }, 'task_graph', { expectedRevision: 0, document: doc })).rejects.toThrow('outside credential scope');
    await prisma.taskAgent.create({ data: { taskId: task.id, agentId: executorAgentId, role: 'executor' } });
    await prisma.$executeRawUnsafe(`CREATE FUNCTION fail_graph_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'task:content_uploaded' THEN RAISE EXCEPTION 'audit red control'; END IF; RETURN NEW; END; $$`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER graph_audit_red BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION fail_graph_audit()');
    try {
      await expect(contentSvc.storeGraph(task.id, { type: 'agent', id: executorAgentId, name: 'executor' }, 'task_graph', { expectedRevision: 0, document: doc })).rejects.toThrow();
      expect(await prisma.taskArtifactRevision.count({ where: { taskId: task.id } })).toBe(0);
      expect(await prisma.taskEvidenceAttachment.count({ where: { taskId: task.id } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER graph_audit_red ON activity_log');
      await prisma.$executeRawUnsafe('DROP FUNCTION fail_graph_audit()');
    }
  });
});

