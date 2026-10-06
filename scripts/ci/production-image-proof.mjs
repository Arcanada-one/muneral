import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { commandFailureEvidence } from './command-failure-evidence.mjs';
import { assertEphemeralBase } from '../../apps/api/test/support/disposable-postgres-url.ts';

const argv = process.argv.slice(2);
const options = Object.fromEntries(argv.reduce((pairs, value, index) => {
  if (index % 2 === 0) pairs.push([value, argv[index + 1]]);
  return pairs;
}, []));
assert.equal(argv.length, 12, 'six explicit candidate/fixture arguments required');
const head = options['--head'];
assert.match(head, /^[0-9a-f]{40}$/);
assert.equal(options['--runner-environment'], 'github-hosted');
const run = options['--run'];
assert.match(run, /^[0-9]+-[0-9]+$/);
const service = options['--postgres-id'];
assert.match(service, /^[0-9a-f]{64}$/);
const port = options['--postgres-port'];
assert.match(port, /^[0-9]+$/);
assert(Number(port) > 0 && Number(port) <= 65535);
assertEphemeralBase(`postgresql://image_fixture:image_fixture@127.0.0.1:${port}/muneral_image_test`);
const out = resolve(options['--out']);
mkdirSync(out, { recursive: false });
const image = `muneral-image-proof:${run}`;
const label = `security14ea-image-${run}`;
const receipt = { schema: 'CandidateProductionImageProof/v1', head, run,
  verdict: 'not_measured', scope: 'Ephemeral hosted CI candidate image; not deploy/live permissions',
  runtime_authorized: false, observations: [] };
let phase = 'capability';
let container;
let exported;
function command(binary, args) {
  return execFileSync(binary, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    timeout: 20 * 60 * 1000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function docker(...args) { return command('docker', args); }
function observed(name, data) { receipt.observations.push({ name, verdict: 'verified', ...data }); }
function inImage(network, program, workdir = '/app/apps/api') {
  return docker('run', '--rm', '--network', network, '--workdir', workdir,
    '--env', 'DATABASE_URL=postgresql://image_fixture:image_fixture@postgres:5432/muneral_image_test',
    image, 'node', '--input-type=module', '-e', program);
}
try {
  assert.equal(command('git', ['rev-parse', 'HEAD']), head, 'checkout is not exact PR head');
  assert.equal(command('git', ['status', '--porcelain', '--untracked-files=no']), '', 'tracked checkout dirty');
  const dockerVersion = docker('info', '--format', '{{.ServerVersion}}');
  assert(dockerVersion);
  observed('direct_docker_capability', { dockerVersion });
  phase = 'fixture';
  const pg = JSON.parse(docker('inspect', service))[0];
  assert.equal(pg.Id, service);
  assert.match(pg.Config.Image, /^postgres:16(?:-alpine)?$/);
  assert.equal(pg.State.Health.Status, 'healthy');
  const networks = Object.entries(pg.NetworkSettings.Networks);
  assert.equal(networks.length, 1);
  const [network, binding] = networks[0];
  assert(binding.Aliases.includes('postgres'));
  const pgEnv = new Map(pg.Config.Env.map(item => {
    const index = item.indexOf('='); return [item.slice(0, index), item.slice(index + 1)];
  }));
  assert.equal(pgEnv.get('POSTGRES_DB'), 'muneral_image_test');
  assert.equal(pgEnv.get('POSTGRES_USER'), 'image_fixture');
  assert.equal(pgEnv.get('POSTGRES_PASSWORD'), 'image_fixture');
  observed('owned_postgres16_fixture', { service, network, database: 'muneral_image_test' });
  phase = 'build';
  docker('build', '--file', 'apps/api/Dockerfile', '--build-arg', `MUNERAL_BUILD_SHA=${head}`,
    '--tag', image, '--iidfile', join(out, 'image-id'), '.');
  const id = readFileSync(join(out, 'image-id'), 'utf8').trim();
  const config = JSON.parse(docker('image', 'inspect', id))[0];
  assert.equal(config.Id, id);
  assert.equal(config.Config.User, 'node');
  assert.deepEqual(config.Config.Cmd, ['node', 'dist/main.js']);
  observed('exact_head_image_build', { imageId: id, image });
  phase = 'filesystem';
  docker('image', 'save', '--output', join(out, 'image.tar'), image);
  exported = docker('create', '--label', `muneral.image-proof=${label}`, image);
  docker('export', '--output', join(out, 'rootfs.tar'), exported);
  command('python3', ['-B', 'scripts/ci/image-filesystem-proof.py', '--image', join(out, 'image.tar'),
    '--rootfs', join(out, 'rootfs.tar'), '--fingerprints', 'scripts/ci/braces-3.0.3-source-fingerprints.json',
    '--out', join(out, 'filesystem.json')]);
  const filesystem = JSON.parse(readFileSync(join(out, 'filesystem.json'), 'utf8'));
  assert.equal(filesystem.verdict, 'verified');
  observed('every_final_layer_and_rootfs_member', {
    layers: filesystem.layers.length, members: filesystem.rootfs.members.length });
  phase = 'proxy_trust_boundary';
  inImage(network, readFileSync('scripts/ci/proxy-trust-boundary.spec.mjs', 'utf8'), '/app');
  observed('final_image_express_proxy_trust_boundary', { tests: 2 });
  phase = 'migration';
  docker('run', '--rm', '--network', network, '--workdir', '/app',
    '--env', 'DATABASE_URL=postgresql://image_fixture:image_fixture@postgres:5432/muneral_image_test',
    image, 'node', 'apps/api/node_modules/prisma/build/index.js', 'migrate', 'deploy', '--config=/app/prisma.config.ts');
  observed('final_image_prisma_migrate_deploy', {});
  phase = 'query';
  const query = JSON.parse(inImage(network, String.raw`
    import assert from 'node:assert/strict';
    import { PrismaClient } from '@prisma/client';
    import { PrismaPg } from '@prisma/adapter-pg';
    import * as types from '@muneral/types';
    const prisma = new PrismaClient({adapter:new PrismaPg({connectionString:process.env.DATABASE_URL})});
    try {
      const rows=await prisma.$queryRawUnsafe('SELECT 1 AS ok, to_regclass(\'public.tasks\')::text AS tasks');
      assert.equal(rows[0].ok,1); assert.equal(rows[0].tasks,'tasks');
      const migrations=await prisma.$queryRawUnsafe('SELECT count(*)::int AS total, count(*) FILTER (WHERE finished_at IS NULL)::int AS unfinished FROM _prisma_migrations');
      assert(migrations[0].total>0); assert.equal(migrations[0].unfinished,0);
      await prisma.task.count();
      console.log(JSON.stringify({query:true,client:true,adapter:true,types:true,migrations:migrations[0].total}));
    } finally {await prisma.$disconnect();}`));
  observed('final_image_client_adapter_types_query', query);
  phase = 'health';
  container = docker('run', '-d', '--network', network, '--label', `muneral.image-proof=${label}`,
    '--env', 'DATABASE_URL=postgresql://image_fixture:image_fixture@postgres:5432/muneral_image_test',
    '--env', 'REDIS_URL=redis://redis:6379', '--env', 'PORT=3500',
    '--env', 'JWT_SECRET=isolated-image-fixture-not-a-production-key-14ea', image);
  let healthy;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      healthy = JSON.parse(docker('exec', container, 'node', '--input-type=module', '-e',
        `const res=await fetch('http://127.0.0.1:3500/health',{signal:AbortSignal.timeout(1000)});if(!res.ok)process.exit(1);console.log(JSON.stringify(await res.json()));`));
      break;
    } catch { await new Promise(done => setTimeout(done, 1000)); }
  }
  assert(healthy, 'candidate did not serve IPv4 health');
  assert.equal(healthy.status, 'ok');
  assert.equal(healthy.version, JSON.parse(readFileSync('apps/api/package.json', 'utf8')).version);
  assert.equal(healthy.build.sha, head);
  observed('candidate_ipv4_http_health_exact_build', { status: healthy.status, version: healthy.version, sha: healthy.build.sha });
  receipt.verdict = 'verified';
} catch (error) {
  receipt.verdict = 'failed';
  receipt.failure = { phase, error: error.name, exit: error.status ?? null,
    diagnostic: commandFailureEvidence(error) };
  process.exitCode = 1;
} finally {
  for (const id of [container, exported].filter(Boolean)) {
    try {
      assert.equal(JSON.parse(docker('inspect', id))[0].Config.Labels['muneral.image-proof'], label);
      docker('rm', '-f', id);
      assert.equal(docker('ps', '-a', '--filter', `id=${id}`, '--format', '{{.ID}}'), '');
    } catch { receipt.verdict = 'failed'; receipt.cleanup = 'failed'; process.exitCode = 1; }
  }
  writeFileSync(join(out, 'runtime.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ head, run, verdict: receipt.verdict, phase,
    observations: receipt.observations.map(row => row.name), cleanup: receipt.cleanup ?? 'own_exact_containers_removed' }));
}
