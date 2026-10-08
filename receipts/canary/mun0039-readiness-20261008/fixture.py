import os,json,socket,subprocess,time,urllib.request,urllib.error,hashlib,secrets
from pathlib import Path
R=Path(__file__).resolve().parent
REPO=Path('/home/dev/aup/frontend-work/muneral-ui-read-errors')
PG=Path('/usr/lib/postgresql/16/bin')
NODE='/home/dev/aup/import-audit-work/runs/m211c/node-v24.21.0-linux-x64/bin/node'
TOOL='/home/dev/aup/import-audit-work/prog-dec0136/tools/graph/deploy_gate.py'
def port():
 with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
def run(args,**kw):return subprocess.run([str(x) for x in args],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,**kw)
def request(path):
 try:
  with urllib.request.urlopen('http://127.0.0.1:'+str(ap)+path,timeout=3) as x:return x.status,json.load(x)
 except urllib.error.HTTPError as x:return x.code,json.load(x)
pgp,rp,ap=[port() for _ in range(3)]
pgdir=R/'pgdata'; sock=R/'pgsocket';sock.mkdir(exist_ok=True)
processes=[]; pgstarted=False; obs={}
try:
 run([PG/'initdb','-D',pgdir,'-U','synthetic','--auth=trust','--no-locale'])
 run([PG/'pg_ctl','-D',pgdir,'-l',R/'postgres.log','-o',f'-h 127.0.0.1 -p {pgp} -k {sock}','-w','start']);pgstarted=True
 env={'PATH':str(Path(NODE).parent)+':/usr/bin:/bin','HOME':str(R),'TMPDIR':str(R),'NODE_ENV':'test','DATABASE_URL':f'postgresql://synthetic@127.0.0.1:{pgp}/postgres','REDIS_URL':f'redis://127.0.0.1:{rp}','REDIS_PREFIX':'mun0039-canary:','HOST':'127.0.0.1','PORT':str(ap),'WEB_URL':f'http://127.0.0.1:{ap}','JWT_SECRET':secrets.token_hex(32),'MUNERAL_BUILD_SHA':json.loads((R/'source-evidence.json').read_text())['commit']}
 for sql in sorted((REPO/'apps/api/prisma/migrations').glob('*/migration.sql')):run([PG/'psql',env['DATABASE_URL'],'-v','ON_ERROR_STOP=1','-f',sql])
 redislog=open(R/'redis.log','w'); apiLog=open(R/'api.log','w')
 redis=subprocess.Popen([str(R/'redis-root/usr/bin/redis-server'),'--bind','127.0.0.1','--port',str(rp),'--save','','--appendonly','no'],env=env,stdout=redislog,stderr=redislog);processes.append(redis)
 time.sleep(.4)
 api=subprocess.Popen([NODE,str(REPO/'apps/api/dist/main.js')],cwd=REPO/'apps/api',env=env,stdout=apiLog,stderr=apiLog);processes.append(api)
 for _ in range(80):
  if api.poll() is not None:raise RuntimeError('candidate exited; see owned api.log')
  try:
   code,body=request('/health/ready')
   if code==200:break
  except (OSError,urllib.error.URLError):pass
  time.sleep(.25)
 else:raise RuntimeError('candidate did not become ready')
 assert body['build']['sha']==env['MUNERAL_BUILD_SHA'] and body['checks']['database']=='ok'
 obs['db_up']={'readiness':code,'liveness':request('/health')[0]}
 subject=json.loads((R/'plan.json').read_text())['subject']
 for phase,status in [('up',200),('down',503)]:
  if phase=='down':run([PG/'pg_ctl','-D',pgdir,'-m','immediate','-w','stop']);pgstarted=False
  start=time.monotonic(); rc,data=request('/health/ready');elapsed=time.monotonic()-start
  assert rc==status and request('/health')[0]==200
  if phase=='down':assert elapsed<2 and data['checks']['database']=='unavailable';obs['db_down']={'readiness':rc,'liveness':200,'elapsed_ms':round(elapsed*1000)}
  plan={'schema':'CanaryPlan/v1','id':'mun0039-readiness-'+phase,'owner':'MUNERAL','environment':'owned-loopback-postgres-redis','base_url':f'http://127.0.0.1:{ap}','subject':subject,'probes':[{'id':'ready-'+phase,'method':'GET','path':'/health/ready','expect':{'status_in':[status],'json_has':['status','checks']},'entities':['route:GET /health/ready']},{'id':'live-'+phase,'method':'GET','path':'/health','expect':{'status_in':[200]},'entities':[]}]}
  (R/(phase+'-plan.json')).write_text(json.dumps(plan,indent=2)+'\n')
  run(['/usr/bin/python3.12',TOOL,'canary','--plan',phase+'-plan.json','--subject-repo',REPO,'--phase','pre','--out',phase+'-result.json'],cwd=R)
  result=json.loads((R/(phase+'-result.json')).read_text());assert all(x['verdict']=='verified' for x in result['entity_verdicts']),result.get('source_binding_errors')
finally:
 for p in reversed(processes):
  if p.poll() is None:p.terminate()
  try:p.wait(timeout=8)
  except subprocess.TimeoutExpired:p.kill();p.wait(timeout=3)
 if pgstarted:run([PG/'pg_ctl','-D',pgdir,'-m','immediate','-w','stop'])
 closed=[]
 for p in [pgp,rp,ap]:
  with socket.socket() as s:s.settimeout(.5);closed.append(s.connect_ex(('127.0.0.1',p))!=0)
 obs['teardown']={'processes_exited':all(p.poll() is not None for p in processes),'loopback_ports_closed':closed,'postgres_pid_absent':not (pgdir/'postmaster.pid').exists(),'production_requests':0}
 (R/'observation.json').write_text(json.dumps(obs,indent=2)+'\n')
 assert all(closed) and obs['teardown']['processes_exited'] and obs['teardown']['postgres_pid_absent']
print('MUN0039_CANARY_VERIFIED_TEARDOWN')
