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
import { jest as runtime } from '@jest/globals';
const jest = runtime as unknown as typeof globalThis.jest;
import { TaskContentService } from '../src/tasks/content/task-content.service.js';

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

describe('Whole work-item open (MUN-ARTIFACTS, e2e)', () => {
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


  const open = (taskId: string, key = executorKey) => http().get(`/tasks/${taskId}/open`).set('Authorization', `Bearer ${key}`);
  const upload = (taskId: string, text: string) => http().post(`/tasks/${taskId}/artifacts`).set('Authorization', `Bearer ${executorKey}`).send({name:'input',contentType:'text/plain',contentBase64:Buffer.from(text).toString('base64')});

  it('returns every byte revision beyond a metadata page, graph history, chronology, checklist and native attempts', async () => {
    const task = await assignedTask();
    for (let i=0;i<101;i++) {
      const bytes=Buffer.from(`version-${i}`);const sha256=createHash('sha256').update(bytes).digest('hex');
      const evidence=await prisma.taskEvidenceAttachment.create({data:{taskId:task.id,uri:`muneral://fixture/${i}`,sha256,contentType:'text/plain',createdByAgentId:executorAgentId}});
      await prisma.taskArtifactRevision.create({data:{taskId:task.id,evidenceId:evidence.id,kind:'artifact',name:'batch',revision:i+1,content:bytes,sha256,contentType:'text/plain',sizeBytes:bytes.length,actorType:'agent',actorId:executorAgentId}});
    }
    const legacy=await prisma.taskEvidenceAttachment.create({data:{taskId:task.id,uri:'file:///legacy-only',sha256:'f'.repeat(64),contentType:'application/json',createdByAgentId:executorAgentId}});
    await post(task.id,'task_graph',taskGraph(task)).expect(201);
    await post(task.id,'task_graph',taskGraph(task,2),1).expect(201);
    await post(task.id,'agent_graph',agentGraph(task.id)).expect(201);
    await prisma.taskChecklist.createMany({data:[{taskId:task.id,text:'one',position:1},{taskId:task.id,text:'two',position:2,checked:true}]});
    await prisma.activityLog.createMany({data:Array.from({length:25},(_,i)=>({workspaceId,taskId:task.id,actorType:'agent',actorId:executorAgentId,action:'fixture:chronology',payload:{step:i}}))});
    await prisma.taskExecutionAttempt.create({data:{attemptId:uuidv4(),taskId:task.id,ordinal:1,status:'issued',issuedAt:new Date()}});
    const row=(await open(task.id).expect(200)).body;
    expect(row.schema).toBe('WorkItemOpen/v1');expect(row.task.id).toBe(task.id);
    expect(row.artifacts).toHaveLength(101);
    for(const artifact of row.artifacts)expect(createHash('sha256').update(Buffer.from(artifact.contentBase64,'base64')).digest('hex')).toBe(artifact.sha256);
    expect(row.graphs.task_graph.revisions.map((r:{revision:number})=>r.revision)).toEqual([1,2]);
    expect(row.graphs.agent_graph.revisions[0].document).toEqual(agentGraph(task.id));
    expect(row.evidence.find((r:{id:string})=>r.id===legacy.id).availability).toBe('legacy_pointer');
    expect(row.completeness).toMatchObject({complete:true,snapshot:'repeatable_read',contentIntegrity:'verified',counts:{chronology:28,checklist:2,agents:1,attempts:1,evidence:105,artifacts:101,contentRevisions:104,dependencies:0}});
    expect(row.checklist.map((r:{text:string})=>r.text)).toEqual(['one','two']);
    expect(Object.keys(row.agents[0].agent).sort()).toEqual(['id','name','workspaceId']);
    expect(row.chronology.map((r:{createdAt:string;id:string})=>`${r.createdAt}/${r.id}`)).toEqual([...row.chronology].sort((a:{createdAt:string;id:string},b:{createdAt:string;id:string})=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)).map((r:{createdAt:string;id:string})=>`${r.createdAt}/${r.id}`));
  });

  it('reports absent graphs explicitly and does not write an audit or issue execution', async () => {
    const task=await assignedTask();const row=(await open(task.id).expect(200)).body;
    expect(row.graphs.task_graph).toEqual({state:'absent',latestRevision:null,revisions:[]});
    expect(row.graphs.agent_graph).toEqual({state:'absent',latestRevision:null,revisions:[]});
    expect(row.attempts).toEqual([]);expect(row.chronology).toEqual([]);
    expect(row.dependencyGraph.nodes.map((node:{id:string})=>node.id)).toEqual([task.id]);
    expect(await prisma.activityLog.count({where:{taskId:task.id}})).toBe(0);
  });

  it('requires actual assignment and workspace custody even for creator keys and direct service calls', async () => {
    const task=await assignedTask();
    for(const key of [strangerKey,foreignKey,creatorKey])await open(task.id,key).expect(403);
    await prisma.taskAgent.deleteMany({where:{taskId:task.id}});
    await expect(contentSvc.open(task.id,{type:'agent',id:executorAgentId,name:'executor'})).rejects.toThrow('outside credential scope');
  });

  it('allows current human membership and refuses its revoked credential', async () => {
    const task=await assignedTask();const user=await prisma.user.create({data:{name:'open-viewer'}});
    await prisma.workspaceMember.create({data:{workspaceId,userId:user.id,role:'viewer'}});const jwt=authSvc.signAccess(user.id);
    await open(task.id,jwt).expect(200);await prisma.workspaceMember.delete({where:{workspaceId_userId:{workspaceId,userId:user.id}}});
    await open(task.id,jwt).expect(403);await prisma.user.delete({where:{id:user.id}});
  });

  it('retains both directions and status for unassigned same-workspace dependencies without disclosing titles', async () => {
    const task=await assignedTask();const originalTarget=await assignedTask();
    const target=await prisma.task.update({where:{id:originalTarget.id},data:{title:'Other executor private title'}});
    await prisma.taskDependency.create({data:{fromTaskId:task.id,toTaskId:target.id,type:'blocks'}});
    const row=(await open(task.id).expect(200)).body;expect(row.dependencyGraph.nodes).toHaveLength(2);expect(row.dependencyGraph.edges).toHaveLength(1);
    await prisma.taskAgent.deleteMany({where:{taskId:target.id}});
    const withheld=(await open(task.id).expect(200)).body;
    expect(withheld.dependencyGraph.nodes.find((node:{id:string})=>node.id===target.id)).toEqual({id:target.id,status:target.status,projectId:target.projectId});
    expect(withheld.dependencyGraph.edges).toHaveLength(1);
    expect(JSON.stringify(withheld.dependencyGraph)).not.toContain(target.title);
    const native=await http().get(`/tasks/${task.id}/dependency-graph`).set('Authorization',`Bearer ${executorKey}`).expect(200);
    expect(native.body[0]).toMatchObject({otherTaskId:target.id,otherTaskTitle:null,otherTaskTitleWithheld:true,otherTaskStatus:target.status});
    await prisma.taskDependency.deleteMany({where:{fromTaskId:task.id}});
    await prisma.taskDependency.create({data:{fromTaskId:target.id,toTaskId:task.id,type:'blocks'}});
    const incoming=(await open(task.id).expect(200)).body;
    expect(incoming.dependencyGraph.edges[0]).toMatchObject({fromTaskId:target.id,toTaskId:task.id,type:'blocks'});
    expect(incoming.dependencyGraph.nodes.find((node:{id:string})=>node.id===target.id)).not.toHaveProperty('title');
    await prisma.task.update({where:{id:target.id},data:{createdById:executorAgentId,actorType:'human'}});
    expect((await open(task.id).expect(200)).body.dependencyGraph.nodes.find((node:{id:string})=>node.id===target.id)).not.toHaveProperty('title');
    await prisma.task.update({where:{id:target.id},data:{actorType:'agent'}});
    expect((await open(task.id).expect(200)).body.dependencyGraph.nodes.find((node:{id:string})=>node.id===target.id).title).toBe(target.title);
  });

  it('refuses cross-workspace dependency endpoints even if a forged assignment exists', async () => {
    const task=await assignedTask();
    const foreignProject=await prisma.project.create({data:{workspaceId:otherWorkspaceId,slug:'foreign-open-'+uuidv4(),name:'Foreign'}});
    const foreignTask=await prisma.task.create({data:{projectId:foreignProject.id,title:'Foreign secret task'}});
    await prisma.taskAgent.create({data:{taskId:foreignTask.id,agentId:executorAgentId,role:'executor'}});
    await prisma.taskDependency.create({data:{fromTaskId:foreignTask.id,toTaskId:task.id,type:'related_to'}});
    await open(task.id).expect(403);
  });

  it('refuses stored content whose bytes do not match its digest', async () => {
    const task=await assignedTask();const bytes=Buffer.from('corrupt fixture');const sha256='0'.repeat(64);
    const evidence=await prisma.taskEvidenceAttachment.create({data:{taskId:task.id,uri:'muneral://corrupt',sha256,contentType:'text/plain',createdByAgentId:executorAgentId}});
    await prisma.taskArtifactRevision.create({data:{taskId:task.id,evidenceId:evidence.id,kind:'artifact',name:'corrupt',revision:1,content:bytes,sha256,contentType:'text/plain',sizeBytes:bytes.length,actorType:'agent',actorId:executorAgentId}});
    const row=await open(task.id).expect(409);expect(row.body.message).toBe('STORED_CONTENT_DIGEST_MISMATCH');
  });

  it('keeps bytes and chronology in the original snapshot while a concurrent upload commits', async () => {
    const task=await assignedTask();await upload(task.id,'before').expect(201);
    let release!:()=>void;let entered!:()=>void;const paused=new Promise<void>(resolve=>{release=resolve;});const ready=new Promise<void>(resolve=>{entered=resolve;});
    const scoped=contentSvc as unknown as {authorize:(...args:unknown[])=>Promise<unknown>};const original=scoped.authorize.bind(contentSvc);let first=true;
    const spy=jest.spyOn(scoped,'authorize').mockImplementation(async(...args:unknown[])=>{const value=await original(...args);if(first){first=false;entered();await paused;}return value;});
    const reading=open(task.id).then(response=>response);
    try {await ready;await upload(task.id,'after').expect(201);release();const row=await reading;expect(row.status).toBe(200);expect(row.body.artifacts).toHaveLength(1);expect(Buffer.from(row.body.artifacts[0].contentBase64,'base64').toString()).toBe('before');expect(row.body.chronology).toHaveLength(1);}
    finally {release();spy.mockRestore();}
    expect((await open(task.id).expect(200)).body.artifacts).toHaveLength(2);
  });
});
