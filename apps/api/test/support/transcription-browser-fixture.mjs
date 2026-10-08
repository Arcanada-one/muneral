import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
const root = process.env.MUNERAL_BROWSER_REPO;
const database = new URL(process.env.DATABASE_URL);
if (database.hostname !== '127.0.0.1' || database.username !== 'synthetic') throw Error('Owned loopback synthetic database required');
const require = createRequire(root + '/apps/api/package.json');
require('reflect-metadata');
const {Test} = require('@nestjs/testing'); const {Module,ValidationPipe} = require('@nestjs/common');
let app, db, fixture, stopped=false;
const finish=async()=>{
 if(stopped)return;stopped=true;
 const cleanup={};
 if(db && fixture){
  await db.workspace.deleteMany({where:{id:fixture.workspaceId}});
  await db.user.deleteMany({where:{id:fixture.userId}});
  cleanup.workspaces=await db.workspace.count({where:{id:fixture.workspaceId}});
  cleanup.users=await db.user.count({where:{id:fixture.userId}});
  cleanup.tasks=await db.task.count({where:{id:fixture.taskId}});
  cleanup.transcriptionRecords=await db.activityLog.count({where:{taskId:fixture.taskId}});
 }
 if(app)await app.close();process.send?.({kind:'cleanup',cleanup});
};
try {
 process.env.JWT_SECRET=randomUUID();process.env.JWT_ACCESS_EXPIRES='60s';
 const load=p=>import(pathToFileURL(root+'/apps/api/dist/'+p+'.js'));
 const names=['prisma/prisma.module','auth/auth.module','activity/activity.module','agents/agents.module','tasks/tasks.module','workspaces/workspaces.module','projects/projects.module'];
 const imports=(await Promise.all(names.map(load))).map(x=>Object.values(x)[0]);
 const {KanbanService}=await load('ws/kanban.service');class FixtureApp{};Module({imports})(FixtureApp);
 const mod=await Test.createTestingModule({imports:[FixtureApp]}).overrideProvider(KanbanService).useValue({notify(){}}).compile();
 app=mod.createNestApplication();app.useLogger(false);app.setGlobalPrefix('api/v1');app.enableCors({origin:'http://127.0.0.1:'+process.env.MUNERAL_BROWSER_WEB_PORT,credentials:true});app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true}));await app.init();
 const {PrismaService}=await load('prisma/prisma.service'); const {AuthService}=await load('auth/auth.service');const {WorkspacesService}=await load('workspaces/workspaces.service');db=mod.get(PrismaService);const auth=mod.get(AuthService);
 const user=await db.user.create({data:{name:'Synthetic transcription reader'}});
 fixture={userId:user.id};
 const ws=await mod.get(WorkspacesService).create(user.id,{slug:'synthetic-transcript-'+randomUUID(),name:'Synthetic transcription workspace'});fixture.workspaceId=ws.id;
 const project=await db.project.create({data:{workspaceId:ws.id,slug:'synthetic-transcript-'+randomUUID(),name:'Synthetic transcription project'}});
 await app.listen(Number(process.env.MUNERAL_BROWSER_API_PORT),'127.0.0.1');
 const bearer=auth.signAccess(user.id); const jobId=randomUUID(); const producerRoute='https://example.invalid/v1/jobs/'+jobId+'/result?format=txt';
 const response=await fetch('http://127.0.0.1:'+process.env.MUNERAL_BROWSER_API_PORT+'/api/v1/tasks',{method:'POST',headers:{Authorization:'Bearer '+bearer,'Content-Type':'application/json'},body:JSON.stringify({projectId:project.id,title:'Synthetic transcription task',transcriptionLink:{jobId,producerRoute}})});
 if(response.status!==201)throw Error('Synthetic task creation failed');const task=await response.json();fixture.taskId=task.id;
 process.on('message',async message=>{if(message.op==='shutdown'){await finish();process.exit(0);}});
 process.on('SIGTERM',()=>finish().then(()=>process.exit(0)));
 process.send?.({kind:'ready',secret:randomUUID()+randomUUID(),userId:user.id,accessToken:bearer,ttl:60,fixture:{wsSlug:ws.slug,projSlug:project.slug,taskId:task.id,jobId,producerRoute}});
 setTimeout(()=>finish().then(()=>process.exit(0)),120000).unref();
} catch(e){await finish();console.error('SyntheticFixtureFailed:'+e.name);process.exitCode=1;}
