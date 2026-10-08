import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const repo=process.argv[2],out=process.argv[3];
const require=createRequire(`${repo}/apps/api/package.json`);require('reflect-metadata');
const {Test}=require('@nestjs/testing');const {Module,ValidationPipe}=require('@nestjs/common');
const {createDisposablePostgres}=await import(pathToFileURL(`${repo}/apps/api/test/support/disposable-postgres.ts`));
const pg=createDisposablePostgres('assigned-read-route-canary');await pg.start();let app;
try {
 process.env.DATABASE_URL=pg.url();process.env.JWT_SECRET=randomUUID();
 const load=p=>import(pathToFileURL(`${repo}/apps/api/dist/${p}.js`));
 const names=['prisma/prisma.module','auth/auth.module','activity/activity.module','agents/agents.module','tasks/tasks.module','workspaces/workspaces.module','projects/projects.module','sync/sync.module','migration/migration.module','solution-log-head/solution-log-head.module'];
 const mods=await Promise.all(names.map(load));const imports=mods.map(x=>Object.values(x)[0]);
 const {KanbanService}=await load('ws/kanban.service');class CanaryApp{};Module({imports,providers:[{provide:KanbanService,useValue:{notify(){}}}]})(CanaryApp);
 const mod=await Test.createTestingModule({imports:[CanaryApp]}).overrideProvider(KanbanService).useValue({notify(){}}).compile();
 app=mod.createNestApplication();app.useLogger(false);app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true}));await app.init();await app.listen(0,'127.0.0.1');const base=await app.getUrl();
 const {PrismaService}=await load('prisma/prisma.service');const {AuthService}=await load('auth/auth.service');const db=mod.get(PrismaService);const auth=mod.get(AuthService);const tag=randomUUID();
 const u=await db.user.create({data:{name:'synthetic-route-owner'}});const ws=await db.workspace.create({data:{ownerId:u.id,slug:'assigned-route-'+tag,name:'Synthetic route fixture'}});const a=await db.agent.create({data:{workspaceId:ws.id,name:'synthetic-header-agent'}});const key=(await auth.createApiKey(a.id,'synthetic-route-key')).key;
 const binding=JSON.parse(readFileSync('/home/dev/aup/import-audit-work/runs/assigned-read-route-binding.json'));
 for(const entity of binding.routes){const [method,pattern]=entity.slice(6).split(' ');const path=pattern.replace(/:[A-Za-z0-9_]+/g,randomUUID());const response=await fetch(base+path,{method,headers:{'X-API-Key':key,'Content-Type':'application/json'},...(method==='GET'?{}:{body:'{}'})});const expected=401;assert.equal(response.status,expected,`ALIAS_SCOPE_ROUTE ${entity}`);}
 console.log(`ALIAS_BOUNDARY_${binding.routes.length}_ROUTES_VERIFIED`);
 const prior=JSON.parse(readFileSync(`${out}/plan.json`));
 const plan={schema:'CanaryPlan/v1',id:'assigned-read-unauthenticated-route-floor',owner:'MUNERAL-IMPORT human task read security fix',environment:'Owned synthetic disposable PostgreSQL and actual compiled Nest modules',base_url:base,subject:prior.subject,purpose:'Actual unauthenticated dispatch401 only; authenticated full business semantics remain unmeasured.',probes:binding.routes.map((entity,i)=>{const [method,pattern]=entity.slice(6).split(' ');return {id:`route-${i}`,kind:'http',method,path:pattern.replace(/:[A-Za-z0-9_]+/g,randomUUID()),auth:'none',entities:[entity,binding.providers[entity]],mutating:method!=='GET',expect:{status_in:[401]}};})};writeFileSync(`${out}/route-plan.json`,JSON.stringify(plan,null,2));
 const code=await new Promise((resolve,reject)=>{const p=spawn('/home/dev/aup/import-audit-work/runs/m211c/venv-noyaml/bin/python',['/home/dev/aup/import-audit-work/prog-rev4/tools/graph/deploy_gate.py','canary','--plan','route-plan.json','--subject-repo',repo,'--phase','pre','--out','route-result.json'],{cwd:out,env:process.env,stdio:['ignore','inherit','inherit']});p.once('error',reject);p.once('exit',resolve);});assert.equal(code,0,'native route permission-floor canary');console.log('ACTUAL_ROUTE_PERMISSION_FLOOR_VERIFIED');
}finally{if(app)await app.close();await pg.stop();}
