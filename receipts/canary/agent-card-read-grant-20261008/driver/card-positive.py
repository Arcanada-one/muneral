import os,pathlib,subprocess,urllib.parse,sys
r=pathlib.Path('/home/dev/aup/import-audit-work/runs');env=dict(os.environ)
env['MUN0021_PG_MODE']='database';env['MUN0021_PG_BASE_URL']='postgresql://'+urllib.parse.quote((r/'rev4-pg/role').read_text().strip(),safe='')+'@127.0.0.1:44959/postgres'
env['TMPDIR']=str(r/'tmp');env['PATH']=str(r/'m211c/node-v24.21.0-linux-x64/bin')+':'+env['PATH'];env['NODE_OPTIONS']='--experimental-vm-modules'
specs=sys.argv[2:]
with open(sys.argv[1],'x') as f:p=subprocess.run(['node','node_modules/jest/bin/jest.js','--runInBand',*specs],cwd='apps/api',env=env,stdout=f,stderr=subprocess.STDOUT,timeout=110)
print('Test exit',p.returncode);sys.exit(p.returncode)
