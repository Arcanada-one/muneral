import { TASK_PROJECT_READ_CAPABILITIES } from '../src/auth/task-project-read-capabilities.js';
import type { TaskProjectReadCapability } from '../src/auth/task-project-read-capabilities.js';
import { TASK_GRANTED_READ_ACTION, GrantedTaskReadService } from '../src/tasks/granted-task-read.service.js';
import { admitGrantedTaskRead } from '../src/auth/task-project-read-admission.js';
import { Prisma } from '@prisma/client';
import { jest as jestRuntime } from '@jest/globals';
import { TasksService } from '../src/tasks/tasks.service.js';
import { admitProjectIndex } from '../src/auth/project-index-admission.js';
const jest = jestRuntime as unknown as typeof globalThis.jest;
import { createDisposablePostgres } from './support/disposable-postgres.js';
import { WORKSPACE_INDEX_GRANTS } from '../src/auth/workspace-index-grants.js';
import type { WorkspaceIndexGrantEntry } from '../src/auth/workspace-index-grants.js';
/**
 * MUN-0052 (e2e) — the project task index for agent keys holding a read grant
 * (DEC-AUP-0029), over real HTTP against the DATABASE_URL database.
 *
 * `GET /tasks/project/:projectId/index` answers every task of the project as
 * ids, status and title hashes to a key named for that project in the grant
 * list, and a 404 — the answer an unknown project gets — to every other key.
 * The grant opens that one route and nothing else: every write route, and every
 * read route that keeps the own slice, answers a granted key exactly as before
 * on a task it neither created nor is assigned to. Each read writes one
 * activity row whose id is in the answer.
 */
import supertest from 'supertest';
import { createHash } from 'crypto';
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
import { PROJECT_READ_GRANTS, GRANT_RENEWAL_LEAD_DAYS } from '../src/auth/project-read-grants.js';
import type { ProjectReadGrantEntry } from '../src/auth/project-read-grants.js';
import { PROJECT_INDEX_COUNTED, PROJECT_INDEX_READ_ACTION } from '../src/tasks/tasks.service.js';
import { TaskFieldStateService } from '../src/tasks/field-state/task-field-state.service.js';

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

/** The exact keys of one index row (DEC-AUP-0029 R3). */
const ROW_KEYS = ['actorType', 'createdAt', 'id', 'parentId', 'priority', 'status', 'titleSha256', 'updatedAt'];
const ENVELOPE_KEYS = ['auditEventId', 'auditReadCount', 'counted', 'generatedAt', 'grant', 'projectId', 'tasks', 'total'];
const FUTURE = '2999-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';

describe('Separate named program task/evidence GET capability (real PostgreSQL/HTTP)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;
  let fsSvc: TaskFieldStateService;
  let tasksSvc: TasksService;
  // The guard reads this very array through DI; each test fills it.
  const capabilities: TaskProjectReadCapability[] = [];
  const grants: ProjectReadGrantEntry[] = [];
  const workspaceGrants: WorkspaceIndexGrantEntry[] = [];
  const database = createDisposablePostgres('task-granted-read');
  const previousDatabaseUrl = process.env.DATABASE_URL;

  let userId: string;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;
  let siblingProjectId: string;
  let foreignProjectId: string;
  const ids: Record<string, string> = {};
  const keys: Record<string, string> = {};

  beforeAll(async () => {
    await database.start();
    process.env.DATABASE_URL = database.url();
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [TestAppModule] })
      .overrideProvider(KanbanService)
      .useValue({ notify: () => void 0 })
      .overrideProvider(TASK_PROJECT_READ_CAPABILITIES)
      .useValue(capabilities)
      .overrideProvider(WORKSPACE_INDEX_GRANTS)
      .useValue(workspaceGrants)
      .overrideProvider(PROJECT_READ_GRANTS)
      .useValue(grants)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
    authSvc = moduleRef.get(AuthService);
    fsSvc = moduleRef.get(TaskFieldStateService);
    tasksSvc = moduleRef.get(TasksService);
  });

  afterAll(async () => {
    try { if (app) await app.close(); } finally {
      await database.stop();
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  beforeEach(async () => {
    capabilities.length = 0;
    grants.length = 0;
    workspaceGrants.length = 0;
    const id = uuidv4().slice(0, 8);
    const user = await prisma.user.create({ data: { name: `mun0052-${id}` } });
    userId = user.id;
    workspaceId = (
      await prisma.workspace.create({ data: { slug: `ws-${id}`, name: `WS ${id}`, ownerId: user.id } })
    ).id;
    otherWorkspaceId = (
      await prisma.workspace.create({ data: { slug: `ws-o-${id}`, name: `Other ${id}`, ownerId: user.id } })
    ).id;
    projectId = (await prisma.project.create({ data: { workspaceId, slug: `p-${id}`, name: `P ${id}` } })).id;
    siblingProjectId = (
      await prisma.project.create({ data: { workspaceId, slug: `s-${id}`, name: `S ${id}` } })
    ).id;
    foreignProjectId = (
      await prisma.project.create({ data: { workspaceId: otherWorkspaceId, slug: `f-${id}`, name: `F ${id}` } })
    ).id;
    for (const [name, ws] of [
      ['reader', workspaceId],
      ['creator', workspaceId],
      ['stranger', workspaceId],
      ['foreign', otherWorkspaceId],
    ] as const) {
      ids[name] = (await prisma.agent.create({ data: { workspaceId: ws, name: `${name}-${id}` } })).id;
      keys[name] = (await authSvc.createApiKey(ids[name], name)).key;
    }
  });

  afterEach(async () => {
    capabilities.length = 0;
    grants.length = 0;
    workspaceGrants.length = 0;
    const projectIds = [projectId, siblingProjectId, foreignProjectId];
    const taskIds = await prisma.task
      .findMany({ where: { projectId: { in: projectIds } }, select: { id: true } })
      .then((rows) => rows.map((r) => r.id));
    if (taskIds.length > 0) {
      await prisma.taskEvidenceAttachment.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.taskChecklist.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.taskAgent.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.taskFieldState.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.activityLog.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    }
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    for (const wid of [workspaceId, otherWorkspaceId]) {
      await prisma.activityLog.deleteMany({ where: { workspaceId: wid } });
      // explicit, not by cascade: leaked keys slow every later test's legacy scan
      await prisma.apiKey.deleteMany({ where: { agent: { workspaceId: wid } } });
      await prisma.agent.deleteMany({ where: { workspaceId: wid } });
      await prisma.workspace.delete({ where: { id: wid } }).catch(() => void 0);
    }
    await prisma.user.delete({ where: { id: userId } }).catch(() => void 0);
  });

  const grant = (agent: string, project: string, until = FUTURE) =>
    grants.push({
      agentId: ids[agent],
      agentName: agent,
      projectId: project,
      until,
      decision: 'DEC-TEST',
      evidence: 'e2e',
    });

  /** A task the reader neither created nor is assigned to: another agent's. */
  async function othersTask(project = projectId, status = 'todo') {
    return prisma.task.create({
      data: {
        projectId: project,
        title: `secret-bearing title ${uuidv4()}`,
        description: 'must never reach the index',
        status,
        priority: 'high',
        createdById: ids.creator,
        actorType: 'agent',
        bootstrapStamp: { receipt: 'must never reach the index' },
      },
    });
  }

  const http = () => supertest(app.getHttpServer());
  const bearer = (k: string) => ({ Authorization: `Bearer ${k}` });
  const index = (project: string, k: string) => http().get(`/tasks/project/${project}/index`).set(bearer(k));


  const taskRead = (id: string, key = keys.reader) => http().get(`/tasks/${id}`).set(bearer(key));
  const evidenceRead = (id: string, key = keys.reader) => http().get(`/tasks/${id}/evidence`).set(bearer(key));
  const capability = (until = FUTURE) => capabilities.push({ agentId: ids.reader, workspaceId,
    anchorProjectId: siblingProjectId, excludedProjectSlugs: ['tbt', 'mt5-bridge'], until, decision: 'DEC-TEST-READ' });
  const admit = () => { capability(); grant('reader', projectId); };
  const auditCount = (id: string) => prisma.activityLog.count({ where: { taskId: id, action: TASK_GRANTED_READ_ACTION } });

  it('index-only authority cannot disclose a nonowned task or evidence', async () => {
    const task = await othersTask(); grant('reader', projectId);
    await taskRead(task.id).expect(403); await evidenceRead(task.id).expect(403);
    expect(await auditCount(task.id)).toBe(0);
  });
  it('read capability without a live index grant cannot disclose', async () => {
    const task = await othersTask(); capability();
    await taskRead(task.id).expect(403); await evidenceRead(task.id).expect(403);
  });
  it('named nonowner gets the unchanged full task and populated evidence schema with distinct committed audits', async () => {
    const task = await othersTask(); admit();
    const attached = await http().post(`/tasks/${task.id}/evidence`).set(bearer(keys.creator))
      .send({uri:'urn:synthetic:task-read-evidence',sha256:'a'.repeat(64),contentType:'application/json'}).expect(201);
    const t = await taskRead(task.id).expect(200);
    expect(t.body.id).toBe(task.id); expect(t.body.projectId).toBe(projectId); expect(t.body.description).toBe(task.description);
    expect(t.body.bootstrapStamp).toEqual(task.bootstrapStamp);
    const e = await evidenceRead(task.id).expect(200);
    expect(e.body).toEqual({task_id:task.id,total:1,evidence:[{...attached.body,idempotent:undefined}]});
    expect(t.headers['x-muneral-read-audit']).toBeTruthy();
    expect(t.headers['x-muneral-read-audit-count']).toBe('1');
    expect(e.headers['x-muneral-read-audit-count']).toBe('2');
    expect(e.headers['x-muneral-read-audit']).not.toBe(t.headers['x-muneral-read-audit']);
    const audits = await prisma.activityLog.findMany({where:{taskId:task.id,action:TASK_GRANTED_READ_ACTION}});
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits.map(a=>a.payload))).not.toContain(task.title);
    expect(JSON.stringify(audits.map(a=>a.payload))).not.toContain('urn:synthetic');
  });
  it('authorized empty evidence is 200 and audited; missing task is not empty success', async () => {
    const task = await othersTask(); admit();
    const e = await evidenceRead(task.id).expect(200);
    expect(e.body).toEqual({task_id:task.id,total:0,evidence:[]}); expect(await auditCount(task.id)).toBe(1);
    await evidenceRead(uuidv4()).expect(403);
    await taskRead('malformed').expect(403);
    await evidenceRead('malformed').expect(403);
  });
  it('creator and assigned reader remain authorized without capability, even after broad expiry', async () => {
    const task = await othersTask(); capability(PAST);
    await taskRead(task.id,keys.creator).expect(200); await evidenceRead(task.id,keys.creator).expect(200);
    await prisma.taskAgent.create({data:{taskId:task.id,agentId:ids.reader,role:'reviewer'}});
    await taskRead(task.id).expect(200); await evidenceRead(task.id).expect(200);
    expect(await auditCount(task.id)).toBe(0);
  });
  it.each(['task','evidence'])('no-key %s read stays 401', async kind => {
    const task=await othersTask();admit();
    await http().get(`/tasks/${task.id}${kind==='evidence'?'/evidence':''}`).expect(401);
  });
  it.each(['stranger','foreign'])('unlisted %s principal gets no broad authority', async actor => {
    const task=await othersTask();admit();
    await taskRead(task.id,keys[actor]).expect(403);await evidenceRead(task.id,keys[actor]).expect(403);
  });
  it.each(['tbt','mt5-bridge'])('current excluded slug %s denies both broad GETs even with exact grant', async slug=>{
    const task=await othersTask();admit();await prisma.project.update({where:{id:projectId},data:{slug}});
    await taskRead(task.id).expect(403);await evidenceRead(task.id).expect(403);
  });
  it('foreign workspace task remains opaque even when explicit grant names it', async()=>{
    const task=await othersTask(foreignProjectId);admit();grant('reader',foreignProjectId);
    await taskRead(task.id).expect(403);await evidenceRead(task.id).expect(403);
  });
  it.each(['expired','invalid','duplicate','wrong-workspace','wrong-anchor'])('capability %s fails closed',async variant=>{
    const task=await othersTask();admit();
    if(variant==='expired') capabilities[0].until=PAST;
    if(variant==='invalid') capabilities[0].until='invalid';
    if(variant==='duplicate') capabilities.push({...capabilities[0]});
    if(variant==='wrong-workspace') capabilities[0].workspaceId=otherWorkspaceId;
    if(variant==='wrong-anchor') capabilities[0].anchorProjectId=foreignProjectId;
    await taskRead(task.id).expect(403);await evidenceRead(task.id).expect(403);
    expect(await auditCount(task.id)).toBe(0);
  });
  it('expired exact grant never falls back to live workspace authority',async()=>{
    const task=await othersTask();capability();grant('reader',projectId,PAST);
    workspaceGrants.push({agentId:ids.reader,agentName:'reader',workspaceId,anchorProjectId:siblingProjectId,
      excludedProjectSlugs:['tbt','mt5-bridge'],until:FUTURE,decision:'DEC-TEST-INDEX',evidence:'synthetic'});
    const e=await taskRead(task.id).expect(403);expect(e.body.code).toBe('GRANT_EXPIRED');
    await evidenceRead(task.id).expect(403);
  });
  it('eligible workspace-only project can be read through both independently dated permissions',async()=>{
    const task=await othersTask();capability();
    workspaceGrants.push({agentId:ids.reader,agentName:'reader',workspaceId,anchorProjectId:siblingProjectId,
      excludedProjectSlugs:['tbt','mt5-bridge'],until:FUTURE,decision:'DEC-TEST-INDEX',evidence:'synthetic'});
    await taskRead(task.id).expect(200);await evidenceRead(task.id).expect(200);
  });
  it('304 reauthorizes and audits without changing native validator or dependency header',async()=>{
    const task=await othersTask();admit();await prisma.$transaction(async tx=>{await fsSvc.recompute(tx,task);});
    const first=await taskRead(task.id).expect(200);expect(first.headers.etag).toMatch(/^"[0-9a-f]{64}"$/);
    const second=await taskRead(task.id).set('If-None-Match',first.headers.etag).expect(304);
    expect(second.headers['x-muneral-dependencies']).toContain('not-in-body');expect(second.headers['x-muneral-read-audit']).toBeTruthy();
    expect(await auditCount(task.id)).toBe(2);
    capabilities[0].until=PAST;
    await taskRead(task.id).set('If-None-Match',first.headers.etag).expect(403);expect(await auditCount(task.id)).toBe(2);
  });
  it('guard scope does not authorize moved task or anchor at the service boundary',async()=>{
    const task=await othersTask();admit();const checked=await admitGrantedTaskRead(prisma,ids.reader,task.id,new Date(),capabilities,grants,workspaceGrants);
    await prisma.task.update({where:{id:task.id},data:{projectId:foreignProjectId}});
    const svc=app.get(GrantedTaskReadService);await expect(svc.read(task.id,ids.reader,checked,'task')).rejects.toThrow();expect(await auditCount(task.id)).toBe(0);
  });
  it('additional capability never admits activity or any write sibling',async()=>{
    const task=await othersTask();admit();
    await http().get(`/tasks/${task.id}/activity`).set(bearer(keys.reader)).expect(403);
    await http().post(`/tasks/${task.id}/evidence`).set(bearer(keys.reader)).send({uri:'urn:synthetic:no',sha256:'b'.repeat(64),contentType:'application/json'}).expect(403);
    await http().post(`/tasks/${task.id}/comments`).set(bearer(keys.reader)).send({body:'no'}).expect(403);
    await http().patch(`/tasks/${task.id}/status`).set(bearer(keys.reader)).send({status:'done'}).expect(403);
    await http().post(`/agents/tasks/${task.id}/assign`).set(bearer(keys.reader)).send({agentId:ids.reader,role:'executor'}).expect(403);
    expect(await prisma.taskAgent.count({where:{taskId:task.id,agentId:ids.reader}})).toBe(0);
    expect((await prisma.task.findUniqueOrThrow({where:{id:task.id}})).status).toBe('todo');
  });

  it('anchor movement after guard admission is refused even for exact live project grant',async()=>{
    const task=await othersTask();admit();const checked=await admitGrantedTaskRead(prisma,ids.reader,task.id,new Date(),capabilities,grants,workspaceGrants);
    await prisma.project.update({where:{id:siblingProjectId},data:{workspaceId:otherWorkspaceId}});
    await expect(app.get(GrantedTaskReadService).read(task.id,ids.reader,checked,'evidence')).rejects.toThrow();
    expect(await auditCount(task.id)).toBe(0);
  });
  it('forged checked project context is refused at the service boundary',async()=>{
    const task=await othersTask();admit();const checked=await admitGrantedTaskRead(prisma,ids.reader,task.id,new Date(),capabilities,grants,workspaceGrants);
    await expect(app.get(GrantedTaskReadService).read(task.id,ids.reader,{...checked,projectId:siblingProjectId},'task')).rejects.toThrow();
    expect(await auditCount(task.id)).toBe(0);
  });
  it('audit insertion followed by failure rolls back before disclosure',async()=>{
    const task=await othersTask();admit();
    const original=prisma.$transaction.bind(prisma);
    const hook=jest.spyOn(prisma,'$transaction').mockImplementationOnce((async(fn:any,options:any)=>original(async(tx:any)=>{
      const delegate=tx.activityLog;
      const audited=new Proxy(tx,{get(target,property){
        if(property==='activityLog') return new Proxy(delegate,{get(log,method){
          if(method==='create') return async(args:any)=>{await log.create(args);throw new Error('synthetic late audit failure');};
          const value=Reflect.get(log,method);return typeof value==='function'?value.bind(log):value;
        }});
        const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
      }});
      return fn(audited);
    },options)) as any);
    try {const response=await evidenceRead(task.id).expect(500);expect(response.body.evidence).toBeUndefined();}
    finally {hook.mockRestore();}
    expect(await auditCount(task.id)).toBe(0);
  });
  it('fresh expiry after a real task-row lock wait refuses without a committed audit',async()=>{
    const task=await othersTask();admit();
    let ready!:()=>void;let release!:()=>void;
    const locked=new Promise<void>(r=>ready=r);const releaseLock=new Promise<void>(r=>release=r);
    const holding=prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM public.tasks WHERE id = ${task.id}::uuid FOR UPDATE`;
      ready();await releaseLock;
    },{timeout:10000});
    await locked;
    capabilities[0].until=new Date(Date.now()+2500).toISOString();
    const response=taskRead(task.id).then(r=>r);
    let waitObserved=false;
    try {
      for(let i=0;i<200;i++){
        const waits=await prisma.$queryRaw<Array<{waiting:boolean}>>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
            AND wait_event_type='Lock' AND query LIKE '%public.tasks%') AS waiting`;
        if(waits[0].waiting){waitObserved=true;break;}
        await prisma.$queryRaw`SELECT pg_sleep(0.01)::text`;
      }
      expect(waitObserved).toBe(true);
      await prisma.$queryRaw`SELECT pg_sleep(2.8)::text`;
    } finally {release();await holding;}
    expect((await response).status).toBe(403);
    expect(await auditCount(task.id)).toBe(0);
  });
});
