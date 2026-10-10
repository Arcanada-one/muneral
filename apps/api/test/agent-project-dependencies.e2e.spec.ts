/** API959a: real authenticated HTTP/Prisma workflow, never borrowed user JWTs. */
import supertest from 'supertest';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe, Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { TasksModule } from '../src/tasks/tasks.module.js';
import { ProjectsModule } from '../src/projects/projects.module.js';
import { WorkspacesModule } from '../src/workspaces/workspaces.module.js';
import { ActivityModule } from '../src/activity/activity.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KanbanService } from '../src/ws/kanban.service.js';

@Module({imports:[PrismaModule,AuthModule,ActivityModule,TasksModule,ProjectsModule,WorkspacesModule],
  providers:[{provide:KanbanService,useValue:{notify:()=>void 0}}]})
class TestApp {}

describe('API959a scoped project discovery and dependency writes',()=>{
  let app:INestApplication, db:PrismaService, auth:AuthService;
  let ws:string, foreignWs:string, project:string, foreignProject:string, agent:string, key:string;
  const projects:string[]=[];
  const tasks:string[]=[];
  beforeAll(async()=>{
    const m=await Test.createTestingModule({imports:[TestApp]})
      .overrideProvider(KanbanService).useValue({notify:()=>void 0}).compile();
    app=m.createNestApplication();app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true}));await app.init();
    db=m.get(PrismaService);auth=m.get(AuthService);
    const user=await db.user.create({data:{name:'api959a-'+randomUUID()}});
    ws=(await db.workspace.create({data:{slug:'api959a-'+randomUUID(),name:'Own',ownerId:user.id}})).id;
    foreignWs=(await db.workspace.create({data:{slug:'api959a-'+randomUUID(),name:'Foreign',ownerId:user.id}})).id;
    project=(await db.project.create({data:{workspaceId:ws,slug:'own',name:'Own',description:'withheld'}})).id;
    foreignProject=(await db.project.create({data:{workspaceId:foreignWs,slug:'foreign',name:'Foreign'}})).id;
    projects.push(project,foreignProject);
    agent=(await db.agent.create({data:{workspaceId:ws,name:'api959a'}})).id;
    key=(await auth.createApiKey(agent,'test')).key;
  });
  afterAll(async()=>{
    await db.taskDependency.deleteMany({where:{fromTaskId:{in:tasks}}});
    await db.taskAgent.deleteMany({where:{taskId:{in:tasks}}});
    await db.activityLog.deleteMany({where:{taskId:{in:tasks}}});
    await db.task.deleteMany({where:{id:{in:tasks}}});
    await db.project.deleteMany({where:{id:{in:projects}}});
    await db.apiKey.deleteMany({where:{agentId:agent}});
    await db.agent.delete({where:{id:agent}});
    await db.workspaceMember.deleteMany({where:{workspaceId:{in:[ws,foreignWs]}}});
    await db.workspace.deleteMany({where:{id:{in:[ws,foreignWs]}}});
    await app.close();
  });
  const request=()=>supertest(app.getHttpServer());
  async function task(owned=true,pid=project){
    const t=await db.task.create({data:{projectId:pid,title:'api959a',actorType:owned?'agent':'human',createdById:owned?agent:randomUUID()}});
    tasks.push(t.id);return t.id;
  }
  it('discovers only own workspace and own project identity metadata',async()=>{
    const w=await request().get('/workspaces').auth(key,{type:'bearer'}).expect(200);
    expect(w.body).toEqual([{id:ws,slug:expect.any(String),name:'Own'}]);
    const p=await request().get('/projects/workspace/'+ws).auth(key,{type:'bearer'}).expect(200);
    expect(p.body).toEqual([{id:project,workspaceId:ws,slug:'own',name:'Own'}]);
    await request().get('/projects/'+project).auth(key,{type:'bearer'}).expect(200);
  });
  it('refuses foreign/unknown project and workspace discovery equally',async()=>{
    for(const id of [foreignWs,randomUUID()]) await request().get('/projects/workspace/'+id).auth(key,{type:'bearer'}).expect(404);
    for(const id of [foreignProject,randomUUID()]) await request().get('/projects/'+id).auth(key,{type:'bearer'}).expect(404);
    await request().get('/projects/'+project).expect(401);
  });
  it('creates within own workspace then reads back, refusing foreign creation',async()=>{
    const res=await request().post('/projects').auth(key,{type:'bearer'}).send({workspaceId:ws,slug:'new-'+randomUUID(),name:'New'}).expect(201);
    projects.push(res.body.id);
    await request().get('/projects/'+res.body.id).auth(key,{type:'bearer'}).expect(200);
    await request().post('/projects').auth(key,{type:'bearer'}).send({workspaceId:foreignWs,slug:'bad',name:'Bad'}).expect(404);
  });
  it('deduplicates concurrent project retries and refuses slug conflicts',async()=>{
    const dto={workspaceId:ws,slug:'retry-'+randomUUID(),name:'Retry'};
    const results=await Promise.all([1,2].map(()=>request().post('/projects').auth(key,{type:'bearer'}).send(dto).expect(201)));
    expect(results[0].body.id).toBe(results[1].body.id);projects.push(results[0].body.id);
    await request().post('/projects').auth(key,{type:'bearer'}).send({...dto,name:'Different'}).expect(409);
    expect(await db.project.count({where:{workspaceId:ws,slug:dto.slug}})).toBe(1);
  });
  it('refuses self/cycles and deduplicates concurrent edge retries',async()=>{
    const a=await task(),b=await task(),c=await task();
    const write=(from:string,to:string,type='depends_on')=>request().post('/tasks/'+from+'/dependencies').auth(key,{type:'bearer'}).send({toTaskId:to,type});
    await write(a,a).expect(400);
    const retries=await Promise.all([write(a,b).expect(201),write(a,b).expect(201)]);
    expect(retries[0].body.id).toBe(retries[1].body.id);
    await write(b,c).expect(201);
    await write(c,a).expect(409);
    await write(c,b,'blocks').expect(201);
    await write(a,c,'blocks').expect(409);
    const x=await task(),y=await task();
    const opposite=await Promise.all([write(x,y),write(y,x)]);
    expect(opposite.map(v=>v.status).sort()).toEqual([201,409]);
  });
  it('retains default deny for project delete, gitrefs and workspace membership writes',async()=>{
    await request().delete('/projects/'+project).auth(key,{type:'bearer'}).expect(403);
    await request().post('/projects/git-refs').auth(key,{type:'bearer'}).send({}).expect(403);
    await request().post('/workspaces/'+ws+'/members/'+randomUUID()).auth(key,{type:'bearer'}).expect(403);
    await request().post('/workspaces').auth(key,{type:'bearer'}).send({}).expect(403);
  });
  it('creates, reads graph and deletes a dependency between owned tasks',async()=>{
    const a=await task(),b=await task();
    const e=await request().post('/tasks/'+a+'/dependencies').auth(key,{type:'bearer'}).send({toTaskId:b,type:'depends_on'}).expect(201);
    const list=await request().get('/tasks/'+a+'/dependencies').auth(key,{type:'bearer'}).expect(200);
    expect(list.body.some((d:{id:string})=>d.id===e.body.id)).toBe(true);
    await request().get('/tasks/'+a+'/dependency-graph').auth(key,{type:'bearer'}).expect(200);
    await request().delete('/tasks/'+a+'/dependencies/'+e.body.id).auth(key,{type:'bearer'}).expect(204);
    expect(await db.taskDependency.findUnique({where:{id:e.body.id}})).toBeNull();
  });
  it('refuses foreign/unowned source and target, including reviewer-only target',async()=>{
    const own=await task(),unowned=await task(false),foreign=await task(true,foreignProject);
    await db.taskAgent.create({data:{taskId:unowned,agentId:agent,role:'reviewer'}});
    for(const [from,to] of [[own,foreign],[foreign,own],[own,unowned],[unowned,own]]){
      await request().post('/tasks/'+from+'/dependencies').auth(key,{type:'bearer'}).send({toTaskId:to,type:'depends_on'}).expect(403);
      expect(await db.taskDependency.count({where:{fromTaskId:from,toTaskId:to}})).toBe(0);
    }
  });
  it('admits same-tenant executors but refuses missing/malformed targets',async()=>{
    const a=await task(false),b=await task(false);
    for(const id of [a,b]) await db.taskAgent.create({data:{taskId:id,agentId:agent,role:'executor'}});
    await request().post('/tasks/'+a+'/dependencies').auth(key,{type:'bearer'}).send({toTaskId:b,type:'depends_on'}).expect(201);
    for(const toTaskId of [undefined,'malformed',randomUUID()]){
      await request().post('/tasks/'+a+'/dependencies').auth(key,{type:'bearer'}).send({toTaskId,type:'depends_on'}).expect(403);
    }
    await request().delete('/tasks/'+a+'/dependencies/'+randomUUID()).auth(key,{type:'bearer'}).expect(403);
  });
  it('refuses forged delete task path and unowned/foreign stored target',async()=>{
    const a=await task(),b=await task(),other=await task(),unowned=await task(false),foreign=await task(true,foreignProject);
    const e=await db.taskDependency.create({data:{fromTaskId:a,toTaskId:b,type:'depends_on'}});
    await request().delete('/tasks/'+other+'/dependencies/'+e.id).auth(key,{type:'bearer'}).expect(403);
    expect(await db.taskDependency.findUnique({where:{id:e.id}})).not.toBeNull();
    for(const target of [unowned,foreign]){
      const bad=await db.taskDependency.create({data:{fromTaskId:a,toTaskId:target,type:'depends_on'}});
      await request().delete('/tasks/'+a+'/dependencies/'+bad.id).auth(key,{type:'bearer'}).expect(403);
      expect(await db.taskDependency.findUnique({where:{id:bad.id}})).not.toBeNull();
    }
  });
});
