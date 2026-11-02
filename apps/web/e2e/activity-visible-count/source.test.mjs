import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { __test as driver } from './run.mjs';
import apiClient, { __test as adapter, TASK_IDS } from './synthetic-api-client.mjs';

const appRoot = '/repo/apps/web';
const repoRoot = '/repo';
const origin = 'http://127.0.0.1:43127';
const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));
const webDirectory = path.resolve(fixtureDirectory, '../..');
const repositoryDirectory = path.resolve(webDirectory, '../..');

test('the pinned Node runtime exposes its built-in WebSocket client', () => {
  assert.equal(typeof WebSocket, 'function');
});

test('only same-origin GETs for Vite and the bounded fixture source tree are allowed', () => {
  assert.equal(driver.isAllowedFixtureRequest(`${origin}/`, 'GET', origin, appRoot, repoRoot), true);
  assert.equal(driver.isAllowedFixtureRequest(`${origin}/@vite/client`, 'GET', origin, appRoot, repoRoot), true);
  assert.equal(driver.isAllowedFixtureRequest(`${origin}/@fs/repo/apps/web/components/task/AuditLog.tsx`, 'GET', origin, appRoot, repoRoot), true);
  assert.equal(driver.isAllowedFixtureRequest(`${origin}/@fs/repo/packages/types/src/index.ts`, 'GET', origin, appRoot, repoRoot), true);
  assert.equal(driver.isAllowedFixtureRequest('https://example.invalid/', 'GET', origin, appRoot, repoRoot), false);
  assert.equal(driver.isAllowedFixtureRequest(`${origin}/tasks/${TASK_IDS.populated}/activity?page=1&limit=20`, 'GET', origin, appRoot, repoRoot), false);
  assert.equal(driver.isAllowedFixtureRequest(`${origin}/@fs/repo/apps/web/%2e%2e/secrets`, 'GET', origin, appRoot, repoRoot), false);
  assert.equal(driver.isAllowedFixtureRequest(`${origin}/main.tsx`, 'POST', origin, appRoot, repoRoot), false);
});

test('the typed fixture entry is the only admitted root module path', () => {
  assert.equal(driver.isAllowedFixtureRequest(`${origin}/main.tsx`, 'GET', origin, appRoot, repoRoot), true);
  assert.equal(driver.isAllowedFixtureRequest(`${origin}/main.jsx`, 'GET', origin, appRoot, repoRoot), false);
  assert.equal(driver.isAllowedFixtureRequest(`${origin}/main.tsx/extra`, 'GET', origin, appRoot, repoRoot), false);
  assert.equal(driver.isAllowedFixtureRequest(`https://example.invalid/main.tsx`, 'GET', origin, appRoot, repoRoot), false);
  assert.equal(driver.isAllowedFixtureRequest(`${origin}/main.tsx`, 'POST', origin, appRoot, repoRoot), false);
});

test('workflow output allocation and CI-only inputs keep their bounded contract', async () => {
  const workflow = await readFile(path.join(repositoryDirectory, '.github/workflows/activity-visible-count-browser.yml'), 'utf8');
  const envExample = await readFile(path.join(webDirectory, '.env.example'), 'utf8');
  const allocationStep = workflow.split('id: allocate-output')[1]?.split('\n      - name:')[0];
  assert.ok(allocationStep);
  assert.match(allocationStep, /umask 077[\s\S]*mkdir -p "\$\{artifact_parent\}" "\$\{private_parent\}"/);
  assert.doesNotMatch(allocationStep, /mkdir -p -m 700/);
  assert.match(allocationStep, /mkdir -m 700 "\$\{artifact_root\}"/);
  assert.match(allocationStep, /mkdir -m 700 "\$\{private_root\}"/);
  assert.match(allocationStep, /printf 'artifact_root=%s\\n'[\s\S]*printf 'private_root=%s\\n'[\s\S]*printf 'ready=true\\n'[\s\S]*\} >> "\$\{GITHUB_OUTPUT\}"/);
  assert.equal((allocationStep.match(/>> "\$\{GITHUB_OUTPUT\}"/g) ?? []).length, 1);

  assert.match(envExample, /CI-injected metadata and paths/);
  assert.match(envExample, /not production defaults or credentials/);
  const declared = new Map(envExample.split(/\r?\n/).map((line) => line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/)).filter(Boolean).map((match) => [match[1], match[2]]));
  for (const key of [
    'ACTIVITY_COUNT_CANDIDATE_SHA', 'ACTIVITY_COUNT_OUTPUT_ROOT', 'ACTIVITY_COUNT_PRIVATE_ROOT',
    'CHROME_PATH', 'GITHUB_RUN_ATTEMPT', 'GITHUB_RUN_ID', 'GITHUB_WORKSPACE', 'RUNNER_TEMP',
  ]) assert.equal(declared.get(key), '', `${key} must be declared with an empty placeholder`);
});

test('the HTML entry and fixture implementation are genuinely TypeScript-covered', async () => {
  const html = await readFile(path.join(fixtureDirectory, 'index.html'), 'utf8');
  const fixtureSource = await readFile(path.join(fixtureDirectory, 'main.tsx'), 'utf8');
  assert.match(html, /src="\/main\.tsx"/);
  await assert.rejects(readFile(path.join(fixtureDirectory, 'main.jsx')));
  assert.match(fixtureSource, /declare global[\s\S]*interface Window/);
  assert.match(fixtureSource, /if \(!rootElement\)/);
  assert.doesNotMatch(fixtureSource, /@ts-ignore|@ts-nocheck/);
});

test('browser arguments retain Chromium sandbox defaults', () => {
  const args = driver.browserArguments('/private/profile');
  assert.ok(args.includes('--headless=new'));
  assert.ok(args.includes('--user-data-dir=/private/profile'));
  assert.ok(!args.some((arg) => /no-sandbox|disable-setuid-sandbox|disable-namespace-sandbox/i.test(arg)));
});

test('synthetic adapter serves only exact paginated activity GET inputs', async () => {
  const response = await apiClient.get(`/tasks/${TASK_IDS.populated}/activity?page=1&limit=20`);
  assert.equal(response.data.data.length, 20);
  assert.equal(response.data.total, 27);
  assert.equal(response.data.page, 1);
  assert.equal(response.data.limit, 20);
  assert.deepEqual(adapter.parseActivityRequest(`/tasks/${TASK_IDS.populated}/activity?page=2&limit=20`), {
    taskId: TASK_IDS.populated, page: 2,
  });
  assert.equal(adapter.parseActivityRequest(`/tasks/${TASK_IDS.populated}/activity?limit=20&page=1`), undefined);
  assert.equal(adapter.parseActivityRequest(`/tasks/${TASK_IDS.populated}/activity?page=3&limit=20`), undefined);
  assert.equal(adapter.parseActivityRequest(`/tasks/${TASK_IDS.populated}/activity?page=1&limit=20&extra=1`), undefined);
  await assert.rejects(apiClient.post(`/tasks/${TASK_IDS.populated}/activity`));
  assert.equal(adapter.stats.mutationAttempts, 1);
  assert.equal(adapter.stats.successfulGets, 1);
});

test('PASS result records require exact browser, network, and adapter evidence', () => {
  const candidateSha = 'a'.repeat(40);
  const valid = {
    schema: driver.RESULT_SCHEMA,
    status: 'PASS',
    reason: null,
    candidateSha,
    runId: '12345',
    runAttempt: 1,
    componentSha256: driver.EXPECTED_COMPONENT_SHA256,
    browserVersionOutcome: 'VERSION_OK',
    browserVersion: driver.EXPECTED_BROWSER_VERSION,
    browserSha256: driver.EXPECTED_BROWSER_SHA256,
    scenarioVerdicts: Object.fromEntries(driver.SCENARIOS.map((scenario) => [scenario, 'PASS'])),
    counts: {
      localAssetRequests: 4,
      blockedNetworkRequests: 0,
      networkViolations: 0,
      websocketAttempts: 0,
      syntheticGetAttempts: 3,
      syntheticGetSuccesses: 3,
      rejectedAdapterCalls: 0,
      mutationAttempts: 0,
    },
  };
  assert.equal(driver.validateResultRecord(valid, { candidateSha, runId: '12345', runAttempt: 1 }), true);
  assert.equal(driver.validateResultRecord({ ...valid, unexpected: true }), false);
  assert.equal(driver.validateResultRecord({ ...valid, browserVersionOutcome: 'NOT_STARTED' }), false);
  assert.equal(driver.validateResultRecord({ ...valid, browserSha256: 'b'.repeat(64) }), false);
  assert.equal(driver.validateResultRecord({ ...valid, scenarioVerdicts: { ...valid.scenarioVerdicts, emptyPage: 'NOT_MEASURED' } }), false);
  assert.equal(driver.validateResultRecord({ ...valid, counts: { ...valid.counts, syntheticGetAttempts: 4 } }), false);
  assert.equal(driver.validateResultRecord({ ...valid, counts: { ...valid.counts, blockedNetworkRequests: 1 } }), false);
});

test('the pinned Chrome digest is accepted only for a trusted root-owned non-writable executable', async () => {
  const acceptedPath = driver.EXPECTED_BROWSER_PATH;
  const acceptedStat = {
    isFile: () => true,
    isSymbolicLink: () => false,
    uid: 0,
    mode: 0o100755,
  };
  assert.equal(driver.browserBinaryIsAccepted(acceptedStat, acceptedPath, acceptedPath), true);
  assert.equal(driver.browserBinaryIsAccepted({ ...acceptedStat, mode: 0o100775 }, acceptedPath, acceptedPath), false);
  assert.equal(driver.browserBinaryIsAccepted({ ...acceptedStat, mode: 0o100757 }, acceptedPath, acceptedPath), false);
  assert.equal(driver.browserBinaryIsAccepted({ ...acceptedStat, uid: 1000 }, acceptedPath, acceptedPath), false);

  let versionChildren = 0;
  const state = { privateRoot: '/private' };
  await driver.verifyBrowser(state, {
    browserPath: acceptedPath,
    lstatPath: async () => acceptedStat,
    realpathPath: async () => acceptedPath,
    readDigest: async () => driver.EXPECTED_BROWSER_SHA256,
    launchVersion: (executable, argv) => {
      versionChildren += 1;
      assert.equal(executable, acceptedPath);
      assert.deepEqual(argv, ['--version']);
      return { completion: Promise.resolve({ captureFailed: false, spawnFailed: false, timedOut: false, exitCode: 0 }) };
    },
    readVersionOutput: async () => driver.EXPECTED_BROWSER_VERSION,
  });
  assert.equal(versionChildren, 1);
  assert.equal(state.browserSha256, driver.EXPECTED_BROWSER_SHA256);
  assert.equal(state.browserVersionOutcome, 'VERSION_OK');
  assert.equal(state.browserVersion, driver.EXPECTED_BROWSER_VERSION);
});

test('wrong bytes and writable modes fail before a version child can start', async () => {
  const acceptedPath = driver.EXPECTED_BROWSER_PATH;
  const acceptedStat = {
    isFile: () => true,
    isSymbolicLink: () => false,
    uid: 0,
    mode: 0o100755,
  };
  let digestReads = 0;
  let versionChildren = 0;
  let browserChildren = 0;
  const injected = {
    browserPath: acceptedPath,
    lstatPath: async () => acceptedStat,
    realpathPath: async () => acceptedPath,
    readDigest: async () => {
      digestReads += 1;
      return 'b'.repeat(64);
    },
    launchVersion: () => {
      versionChildren += 1;
      return { completion: Promise.resolve({ exitCode: 0 }) };
    },
    readVersionOutput: async () => driver.EXPECTED_BROWSER_VERSION,
  };
  await assert.rejects(
    driver.launchBrowserAfterVerification({ privateRoot: '/private' }, () => {
      browserChildren += 1;
      return { spawned: true };
    }, (state) => driver.verifyBrowser(state, injected)),
    (error) => error.failureReason === 'BROWSER_BINARY_HASH_MISMATCH',
  );
  assert.equal(digestReads, 1);
  assert.equal(versionChildren, 0);
  assert.equal(browserChildren, 0);

  digestReads = 0;
  await assert.rejects(
    driver.verifyBrowser({ privateRoot: '/private' }, {
      ...injected,
      lstatPath: async () => ({ ...acceptedStat, mode: 0o100775 }),
    }),
    (error) => error.failureReason === 'BROWSER_BINARY_UNAVAILABLE',
  );
  assert.equal(digestReads, 0);
  assert.equal(versionChildren, 0);
});

test('result publication is atomic and refuses to replace an existing result', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'activity-count-result-test-'));
  try {
    const value = { schema: 'test', status: 'FAIL' };
    const first = await driver.atomicPublishJson(root, value);
    assert.deepEqual(JSON.parse(await readFile(first, 'utf8')), value);
    await assert.rejects(driver.atomicPublishJson(root, { schema: 'replacement' }));
    assert.deepEqual(JSON.parse(await readFile(first, 'utf8')), value);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('timed-out child capture retains bounded streams and completes without a second writer', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'activity-count-timeout-test-'));
  try {
    const child = driver.spawnCaptured(
      process.execPath,
      ['-e', 'process.stdout.write("ready\\n"); process.stderr.write("bounded\\n"); setTimeout(() => {}, 5000)'],
      {
        cwd: root,
        env: { PATH: '/usr/bin:/bin' },
        label: 'timeout-child',
        privateRoot: root,
        timeoutMs: 100,
      },
    );
    const result = await child.completion;
    assert.equal(result.timedOut, true);
    assert.equal(result.spawnFailed, false);
    assert.equal(result.captureFailed, undefined);
    assert.ok(result.pid > 0);
    assert.equal(result.processGroup, result.pid);
    assert.equal(result.endedAtUtc !== null, true);
    assert.ok(result.signal === 'SIGTERM' || result.signal === 'SIGKILL');
    assert.equal((await readFile(path.join(root, 'timeout-child.stdout.raw'), 'utf8')).includes('ready'), true);
    assert.equal((await readFile(path.join(root, 'timeout-child.stderr.raw'), 'utf8')).includes('bounded'), true);
    const record = JSON.parse(await readFile(path.join(root, 'timeout-child.process.json'), 'utf8'));
    assert.equal(record.pid, result.pid);
    assert.equal(record.timedOut, true);
    assert.equal(record.stdout.truncated, false);
    assert.equal(record.stderr.truncated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
