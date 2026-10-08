import assert from 'node:assert/strict';
import {fork,spawn,execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
const root=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
const options=new Map();for(let i=2;i<process.argv.length;i+=2)options.set(process.argv[i],process.argv[i+1]);
const out=options.get('--output');assert(out);
const apiPort=Number(options.get('--api-port')),webPort=Number(options.get('--web-port'));assert(apiPort&&webPort);
const origin='http://127.0.0.1:'+webPort,api='http://127.0.0.1:'+apiPort;
const {chromium}=await import(options.get('--playwright-module') ?? '@playwright/test');
const require=createRequire(root+'/apps/web/package.json');const {encode}=await import(require.resolve('next-auth/jwt'));
const closed=port=>new Promise(r=>{const s=net.createConnection({host:'127.0.0.1',port});s.setTimeout(1000);s.once('connect',()=>{s.destroy();r(false)});s.once('error',()=>r(true));s.once('timeout',()=>{s.destroy();r(false)});});
assert(await closed(apiPort));assert(await closed(webPort));
const waitExit=child=>new Promise((r,j)=>{if(child.exitCode!==null)return r();const t=setTimeout(()=>j(Error('Owned process teardown timeout')),15000);child.once('exit',()=>{clearTimeout(t);r();});});
let backend,next,browser,cleanup,failure,meta;const requests=[],external=[],errors=[];
try {
 backend=fork(root+'/apps/api/test/support/transcription-browser-fixture.mjs',[root,String(apiPort),String(webPort)],{execArgv:[],stdio:['ignore','ignore','ignore','ipc'],env:{...process.env}});
 meta=await new Promise((r,j)=>{const t=setTimeout(()=>j(Error('Fixture timeout')),30000);backend.on('message',m=>{if(m.kind==='cleanup')cleanup=m.cleanup;if(m.kind==='ready'){clearTimeout(t);r(m);}});backend.once('exit',()=>{clearTimeout(t);j(Error('Fixture exited'));});});assert.equal(meta.ttl,60);
 next=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(webPort)],{cwd:root+'/apps/web',stdio:'ignore',detached:true,env:{...process.env,NEXTAUTH_SECRET:meta.secret,AUTH_SECRET:meta.secret,AUTH_TRUST_HOST:'true',AUTH_URL:origin,NEXTAUTH_URL:origin,NEXT_TELEMETRY_DISABLED:'1'}});
 for(let i=0;i<75;i++){try{if((await fetch(origin+'/login')).status===200)break;}catch{}if(i===74)throw Error('Next timeout');await new Promise(r=>setTimeout(r,200));}
 browser=await chromium.launch({headless:true});const context=await browser.newContext();
 await context.route('**/*',route=>{const u=new URL(route.request().url());if([api,origin].includes(u.origin))return route.continue();external.push({origin:u.origin,path:u.pathname});return route.abort();});
 const cookie=await encode({token:{sub:meta.userId,name:'Synthetic transcription reader',accessToken:meta.accessToken},secret:meta.secret,salt:'authjs.session-token',maxAge:60});
 await context.addCookies([{name:'authjs.session-token',value:cookie,url:origin,httpOnly:true,sameSite:'Lax'}]);
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().startsWith(api))requests.push({method:r.method(),path:new URL(r.url()).pathname});});
 const url=origin+'/workspaces/'+meta.fixture.wsSlug+'/projects/'+meta.fixture.projSlug+'/tasks/'+meta.fixture.taskId;
 await page.goto(url,{waitUntil:'networkidle'});await page.getByRole('heading',{name:'Synthetic transcription task',exact:true}).waitFor();
 const link=page.getByRole('link',{name:'Open transcription',exact:true});await link.waitFor();assert(await link.isVisible());assert.equal(await link.getAttribute('href'),meta.fixture.producerRoute);assert.equal(await link.getAttribute('rel'),'noopener noreferrer');
 assert((await page.locator('body').innerText()).includes('Production R2 not measured.'));
 await page.reload({waitUntil:'networkidle'});await link.waitFor();assert.equal(await link.getAttribute('href'),meta.fixture.producerRoute);
 await page.screenshot({path:out+'/task-transcription.png',fullPage:true});
 assert.deepEqual(external,[]);assert.deepEqual(errors,[]);assert(requests.every(r=>r.method==='GET'));
} catch(e){failure={name:e.name,message:e.message};}
finally {
 if(browser)await browser.close();
 if(next){try{process.kill(-next.pid,'SIGTERM');await waitExit(next);}catch{failure??={name:'NextTeardownFailed'};}}
 if(backend){try{if(backend.connected)backend.send({op:'shutdown'});await waitExit(backend);}catch{backend.kill('SIGTERM');failure??={name:'FixtureTeardownFailed'};}}
 const portsClosed=await Promise.all([apiPort,webPort].map(closed));if(!cleanup||Object.values(cleanup).some(v=>v!==0)||!portsClosed.every(Boolean))failure??={name:'TeardownReadbackFailed'};
 const result={schema:'MuneralTranscriptionBrowserTest/v1',head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),verdict:failure?'failed':'verified',failure:failure??null,checks:['native synthetic task stores producer job id and route','built candidate task detail direct URL and hydration','link visible and exact href','hard reload preserves link','R2 explicitly NOT_MEASURED','no producer request or operator login','native synthetic rows removed and zero-row readback','owned API and web listeners closed'],jobId:meta?.fixture.jobId,producerRoute:meta?.fixture.producerRoute,requests,external,errors,cleanup,portsClosed,sessionTtlSeconds:60,credentialPersistence:false,productionRequests:0,r2:'not_measured'};fs.writeFileSync(out+'/browser-result.json',JSON.stringify(result,null,2)+'\n');
}
if(failure){console.error('TRANSCRIPTION_BROWSER_FAILED:'+failure.name);process.exitCode=1;}else console.log('TRANSCRIPTION_BROWSER_PASS');
