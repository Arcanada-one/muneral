import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const workflow = await readFile(new URL('../../../../.github/workflows/repository-destination-browser.yml', import.meta.url), 'utf8');
const steps = workflow.split('\n      - name: ');

function step(name) {
  const match = steps.find((source) => source.startsWith(`${name}\n`));
  assert.ok(match, `workflow step ${name}`);
  return match;
}

function runStep(source, env, setup = '') {
  const [, run] = source.split('\n        run: ');
  assert.ok(run, 'workflow step has a run command');
  const lines = run.trimEnd().split('\n');
  const command = lines[0] === '|'
    ? lines.slice(1).map((line) => line.slice(10)).join('\n')
    : lines[0] === '>-' ? lines.slice(1).map((line) => line.trim()).join(' ') : lines[0];
  const result = spawnSync('bash', ['-e', '-c', `${setup}\n${command}`], { env, encoding: 'utf8' });
  assert.ifError(result.error);
  return result;
}

const allocation = step('Allocate private Corepack home');
const installs = [step('Install locked workspace dependencies'), step('Install the isolated browser helper')];
const cleanup = step("Remove the job's Corepack home");
const directoryOutput = '${{ steps.allocate-corepack.outputs.directory }}';

test('the workflow schedules cleanup after both installs regardless of their result', () => {
  assert.ok(allocation.includes('id: allocate-corepack'));
  for (const install of installs) {
    assert.ok(install.includes(`COREPACK_HOME: ${directoryOutput}`));
    assert.ok(steps.indexOf(allocation) < steps.indexOf(install));
    assert.ok(steps.indexOf(install) < steps.indexOf(cleanup));
  }
  assert.match(cleanup, /^        if: always\(\) && steps\.allocate-corepack\.outputs\.directory != ''$/m);
  assert.ok(cleanup.includes(`COREPACK_DIRECTORY: ${directoryOutput}`));
});

for (const failedInstall of [null, 0, 1]) {
  test(`Corepack cleanup preserves the shared store after ${failedInstall === null ? 'success' : `install ${failedInstall + 1} fails`}`, async (t) => {
    const runnerTemp = await mkdtemp(join(tmpdir(), 'repository-destination-workflow-'));
    t.after(() => rm(runnerTemp, { recursive: true, force: true }));
    const output = join(runnerTemp, 'outputs');
    const sharedStore = join(runnerTemp, 'repository-destination-helper-store');
    await mkdir(sharedStore);
    await writeFile(join(sharedStore, 'sentinel'), 'shared');
    const env = { PATH: process.env.PATH, RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: output };

    const allocated = runStep(allocation, env);
    assert.equal(allocated.status, 0, allocated.stderr);
    const match = (await readFile(output, 'utf8')).match(/^directory=(.+)\n$/);
    assert.ok(match);
    const directory = match[1];
    assert.equal(dirname(directory), runnerTemp);
    assert.notEqual(directory, sharedStore);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);

    for (const [index, install] of installs.entries()) {
      const expected = index === failedInstall ? 42 : 0;
      const result = runStep(install, { ...env, COREPACK_HOME: directory, INSTALL_EXIT: String(expected) },
        'corepack() { touch "$COREPACK_HOME/cache-entry" && return "$INSTALL_EXIT"; }');
      assert.equal(result.status, expected, result.stderr);
      if (expected) break;
    }

    const removed = runStep(cleanup, { ...env, COREPACK_DIRECTORY: directory });
    assert.equal(removed.status, 0, removed.stderr);
    await assert.rejects(stat(directory), { code: 'ENOENT' });
    assert.equal(await readFile(join(sharedStore, 'sentinel'), 'utf8'), 'shared');
  });
}
