import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const expectedBrowserPath = '/opt/arcanada-browsers/cft-156.0.8078.4/chrome-linux64/chrome';
const expectedBrowserVersion = 'Google Chrome for Testing 156.0.8078.4';
const expectedComponentSha256 = '4d24338b977bf945d392445a9a5f8d27fdbd602d440ea914d4944cab29997702';
const baselineSourceCommit = '8a4ef29f34ccf57c01d7cbdf29eb1f9e40f75d2b';
const baselineSourceTree = '6f5975e24406b253e060c68bc50c9516318234f7';
const resultSchema = 'RepositoryDestinationBrowserFixture/v3';
const runnerExitSchema = 'RepositoryDestinationBrowserProcess/v2';
const versionCaptureSchema = 'RepositoryDestinationVersionChild/v1';
const timeoutMs = 15000;
const maxVersionOutputBytes = 4096;
const maxResultBytes = 16 * 1024;
const maxRunnerExitBytes = 2048;
const versionOutcomes = new Set([
  'NOT_STARTED', 'VERSION_OK', 'VERSION_EXIT_NONZERO', 'VERSION_SIGNALED',
  'VERSION_TIMEOUT', 'VERSION_SPAWN_FAILED', 'VERSION_OUTPUT_TRUNCATED', 'VERSION_MISMATCH',
]);
const failureReasons = new Set([
  'OUTPUT_ROOT_INVALID', 'OUTPUT_ROOT_NOT_CANONICAL', 'OUTPUT_ROOT_NOT_FRESH',
  'OUTPUT_ROOT_NOT_BOUND', 'PRIVATE_ROOT_INVALID', 'PRIVATE_ROOT_NOT_CANONICAL',
  'PRIVATE_ROOT_NOT_PRIVATE', 'PRIVATE_ROOT_NOT_BOUND',
  'OUTPUT_MODE_NOT_PRIVATE', 'WORKSPACE_ROOT_INVALID', 'WORKSPACE_ROOT_NOT_CANONICAL',
  'RUN_ID_INVALID', 'RUN_ATTEMPT_INVALID', 'CANDIDATE_SHA_INVALID',
  'FIXTURE_ROOT_NOT_CANONICAL', 'WEB_ROOT_NOT_CANONICAL', 'HELPER_MANIFEST_NOT_CANONICAL',
  'COMPONENT_PATH_NOT_CANONICAL', 'COMPONENT_HASH_MISMATCH', 'BROWSER_PATH_UNSUPPORTED',
  'BROWSER_BINARY_NOT_ROOT_OWNED_EXECUTABLE', 'BROWSER_BINARY_NOT_CANONICAL',
  'BROWSER_VERSION_UNSUPPORTED', 'TOOL_API_UNSUPPORTED', 'SCENARIO_OR_INPUT_CHECK_FAILED',
  'PRIVATE_CAPTURE_WRITE_FAILED', 'RESULT_CAPTURE_FAILED', 'UNEXPECTED_FAILURE',
]);
const resultKeys = [
  'schema', 'status', 'reason', 'scenarios', 'candidateSha', 'runId', 'runAttempt',
  'baselineSourceCommit', 'baselineSourceTree', 'componentSha256', 'browserVersionOutcome',
  'browserVersion', 'browserSha256', 'localGetRequests', 'blockedRequests',
  'blockedDataRequests', 'websocketCount',
];
const runnerExitKeys = ['schema', 'exitCode', 'candidateSha', 'runId', 'runAttempt'];

const state = {
  outputDir: null,
  resultPath: null,
  privateDir: null,
  versionDir: null,
  // Chromium AF_UNIX sockets are capped (~107 bytes). Keep runtime dirs short.
  browserRuntimeDir: null,
  browserTempDir: null,
  browserProfileDir: null,
  outputReady: false,
  outputWritten: false,
  server: null,
  context: null,
  candidateSha: null,
  runId: null,
  runAttempt: null,
  browserSha256: null,
  browserVersionResult: null,
  localRequests: 0,
  blockedRequests: 0,
  blockedDataRequests: 0,
  websocketCount: 0,
};

function fail(reason) {
  const error = new Error(reason);
  error.failureReason = reason;
  throw error;
}

function requireCondition(condition, reason) {
  if (!condition) fail(reason);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function sha256File(filePath) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest('hex');
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function validRunBinding(env = process.env) {
  return typeof env.REPOSITORY_DESTINATION_RUN_ID === 'string'
    && /^[0-9]+$/.test(env.REPOSITORY_DESTINATION_RUN_ID)
    && typeof env.REPOSITORY_DESTINATION_RUN_ATTEMPT === 'string'
    && /^[1-9][0-9]*$/.test(env.REPOSITORY_DESTINATION_RUN_ATTEMPT)
    && Number.isSafeInteger(Number(env.REPOSITORY_DESTINATION_RUN_ATTEMPT))
    && typeof env.REPOSITORY_DESTINATION_CANDIDATE_SHA === 'string'
    && /^[a-f0-9]{40}$/.test(env.REPOSITORY_DESTINATION_CANDIDATE_SHA)
    && env.GITHUB_RUN_ID === env.REPOSITORY_DESTINATION_RUN_ID
    && env.GITHUB_RUN_ATTEMPT === env.REPOSITORY_DESTINATION_RUN_ATTEMPT
    && env.GITHUB_SHA === env.REPOSITORY_DESTINATION_CANDIDATE_SHA;
}

export function validateResultRecord(value, binding) {
  if (!exactKeys(value, resultKeys)) return false;
  if (value.schema !== resultSchema || !['PASS', 'FAIL'].includes(value.status)) return false;
  if (value.status === 'PASS' ? value.reason !== null : !failureReasons.has(value.reason)) return false;
  if (value.scenarios !== 5 || value.candidateSha !== binding.candidateSha
      || value.runId !== binding.runId || !Number.isSafeInteger(value.runAttempt)
      || value.runAttempt !== binding.runAttempt) return false;
  if (value.baselineSourceCommit !== baselineSourceCommit || value.baselineSourceTree !== baselineSourceTree
      || value.componentSha256 !== expectedComponentSha256) return false;
  if (!versionOutcomes.has(value.browserVersionOutcome)) return false;
  if (value.browserVersionOutcome === 'VERSION_OK') {
    if (value.browserVersion !== expectedBrowserVersion || !/^[a-f0-9]{64}$/.test(value.browserSha256 ?? '')) return false;
  } else if (value.browserVersion !== null) {
    return false;
  }
  if (value.browserSha256 !== null && !/^[a-f0-9]{64}$/.test(value.browserSha256)) return false;
  for (const key of ['localGetRequests', 'blockedRequests', 'blockedDataRequests', 'websocketCount']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) return false;
  }
  if (value.status === 'PASS' && (value.browserVersionOutcome !== 'VERSION_OK'
      || value.localGetRequests < 1 || value.blockedRequests !== 0
      || value.blockedDataRequests !== 0 || value.websocketCount !== 0)) return false;
  return true;
}

export function validateRunnerExitRecord(value, binding) {
  return exactKeys(value, runnerExitKeys)
    && value.schema === runnerExitSchema
    && Number.isInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 255
    && value.candidateSha === binding.candidateSha
    && value.runId === binding.runId
    && value.runAttempt === binding.runAttempt;
}

export function classifyVersionOutcome(result) {
  if (!result) return 'NOT_STARTED';
  if (result.spawnFailed) return 'VERSION_SPAWN_FAILED';
  if (result.started !== true) return 'NOT_STARTED';
  if (result.timedOut) return 'VERSION_TIMEOUT';
  if (result.signal !== null) return 'VERSION_SIGNALED';
  if (result.exitCode !== 0) return 'VERSION_EXIT_NONZERO';
  if (result.stdout?.truncated || result.stderr?.truncated) return 'VERSION_OUTPUT_TRUNCATED';
  if (result.version !== expectedBrowserVersion) return 'VERSION_MISMATCH';
  return 'VERSION_OK';
}

async function atomicPublishJson(targetPath, value, validator) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const temporaryPath = path.join(path.dirname(targetPath), `.private-${path.basename(targetPath)}-${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const writtenBytes = await readFile(temporaryPath);
  const parsed = JSON.parse(writtenBytes.toString('utf8'));
  if (!validator(parsed) || writtenBytes.length !== bytes.length || !writtenBytes.equals(bytes)) {
    throw new Error('validated output mismatch');
  }
  await link(temporaryPath, targetPath);
  await unlink(temporaryPath);
}

async function readBoundedJson(filePath, maxBytes, validator) {
  const fileStat = await lstat(filePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > maxBytes) {
    throw new Error('invalid record file');
  }
  if ((fileStat.mode & 0o077) !== 0) throw new Error('record permissions are too broad');
  const bytes = await readFile(filePath);
  if (bytes.length > maxBytes) throw new Error('record exceeds bound');
  const parsed = JSON.parse(bytes.toString('utf8'));
  const canonicalBytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`);
  if (!validator(parsed) || !bytes.equals(canonicalBytes)) throw new Error('record schema mismatch');
  return parsed;
}

async function validateOutputFiles(outputDir, binding) {
  const resultPath = path.join(outputDir, 'result.json');
  const exitPath = path.join(outputDir, 'runner-exit.json');
  const result = await readBoundedJson(resultPath, maxResultBytes, value => validateResultRecord(value, binding));
  const exitRecord = await readBoundedJson(exitPath, maxRunnerExitBytes,
    value => validateRunnerExitRecord(value, binding));
  if ((result.status === 'PASS' && exitRecord.exitCode !== 0)
      || (result.status === 'FAIL' && exitRecord.exitCode !== 1)) {
    throw new Error('result and process outcome disagree');
  }
  return { result, exitRecord };
}

function expectedOutputRoot(env = process.env) {
  if (typeof env.RUNNER_TEMP !== 'string' || !path.isAbsolute(env.RUNNER_TEMP) || !validRunBinding(env)) return null;
  return path.join(env.RUNNER_TEMP, 'repository-destination-artifacts', env.REPOSITORY_DESTINATION_RUN_ID,
    env.REPOSITORY_DESTINATION_RUN_ATTEMPT, env.REPOSITORY_DESTINATION_CANDIDATE_SHA);
}

function expectedPrivateRoot(env = process.env) {
  if (typeof env.RUNNER_TEMP !== 'string' || !path.isAbsolute(env.RUNNER_TEMP) || !validRunBinding(env)) return null;
  return path.join(env.RUNNER_TEMP, 'repository-destination-private', env.REPOSITORY_DESTINATION_RUN_ID,
    env.REPOSITORY_DESTINATION_RUN_ATTEMPT, env.REPOSITORY_DESTINATION_CANDIDATE_SHA);
}

async function runValidateArtifacts() {
  requireCondition(validRunBinding(), 'CANDIDATE_SHA_INVALID');
  const configuredRoot = process.env.REPOSITORY_DESTINATION_OUTPUT_ROOT;
  requireCondition(typeof configuredRoot === 'string' && path.isAbsolute(configuredRoot), 'OUTPUT_ROOT_INVALID');
  requireCondition(configuredRoot === expectedOutputRoot(), 'OUTPUT_ROOT_NOT_BOUND');
  requireCondition(await realpath(configuredRoot) === path.resolve(configuredRoot), 'OUTPUT_ROOT_NOT_CANONICAL');
  const outputStat = await lstat(configuredRoot);
  requireCondition(outputStat.isDirectory() && !outputStat.isSymbolicLink()
    && (outputStat.mode & 0o077) === 0, 'OUTPUT_MODE_NOT_PRIVATE');
  await validateOutputFiles(configuredRoot, {
    candidateSha: process.env.REPOSITORY_DESTINATION_CANDIDATE_SHA,
    runId: process.env.REPOSITORY_DESTINATION_RUN_ID,
    runAttempt: Number(process.env.REPOSITORY_DESTINATION_RUN_ATTEMPT),
  });
}

async function runWriteRunnerExit(exitCodeText) {
  requireCondition(validRunBinding(), 'CANDIDATE_SHA_INVALID');
  requireCondition(/^(0|[1-9][0-9]{0,2})$/.test(exitCodeText), 'RESULT_CAPTURE_FAILED');
  const exitCode = Number(exitCodeText);
  requireCondition(exitCode <= 255, 'RESULT_CAPTURE_FAILED');
  const configuredRoot = process.env.REPOSITORY_DESTINATION_OUTPUT_ROOT;
  requireCondition(typeof configuredRoot === 'string' && path.isAbsolute(configuredRoot), 'OUTPUT_ROOT_INVALID');
  requireCondition(configuredRoot === expectedOutputRoot(), 'OUTPUT_ROOT_NOT_BOUND');
  requireCondition(await realpath(configuredRoot) === path.resolve(configuredRoot), 'OUTPUT_ROOT_NOT_CANONICAL');
  const record = {
    schema: runnerExitSchema,
    exitCode,
    candidateSha: process.env.REPOSITORY_DESTINATION_CANDIDATE_SHA,
    runId: process.env.REPOSITORY_DESTINATION_RUN_ID,
    runAttempt: Number(process.env.REPOSITORY_DESTINATION_RUN_ATTEMPT),
  };
  await atomicPublishJson(path.join(configuredRoot, 'runner-exit.json'), record,
    value => validateRunnerExitRecord(value, {
      candidateSha: record.candidateSha, runId: record.runId, runAttempt: record.runAttempt,
    }));
}

async function prepareOutput() {
  requireCondition(validRunBinding(), 'CANDIDATE_SHA_INVALID');
  const configuredRoot = process.env.REPOSITORY_DESTINATION_OUTPUT_ROOT;
  requireCondition(typeof configuredRoot === 'string' && path.isAbsolute(configuredRoot), 'OUTPUT_ROOT_INVALID');
  requireCondition(configuredRoot === expectedOutputRoot(), 'OUTPUT_ROOT_NOT_BOUND');
  const canonicalRoot = await realpath(configuredRoot);
  requireCondition(canonicalRoot === path.resolve(configuredRoot), 'OUTPUT_ROOT_NOT_CANONICAL');
  const rootStat = await lstat(canonicalRoot);
  requireCondition(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'OUTPUT_ROOT_INVALID');
  requireCondition((rootStat.mode & 0o077) === 0, 'OUTPUT_MODE_NOT_PRIVATE');
  const configuredPrivateRoot = process.env.REPOSITORY_DESTINATION_PRIVATE_ROOT;
  requireCondition(typeof configuredPrivateRoot === 'string' && path.isAbsolute(configuredPrivateRoot), 'PRIVATE_ROOT_INVALID');
  requireCondition(configuredPrivateRoot === expectedPrivateRoot(), 'PRIVATE_ROOT_NOT_BOUND');
  const canonicalPrivateRoot = await realpath(configuredPrivateRoot);
  requireCondition(canonicalPrivateRoot === path.resolve(configuredPrivateRoot), 'PRIVATE_ROOT_NOT_CANONICAL');
  const privateStat = await lstat(canonicalPrivateRoot);
  requireCondition(privateStat.isDirectory() && !privateStat.isSymbolicLink(), 'PRIVATE_ROOT_INVALID');
  requireCondition((privateStat.mode & 0o077) === 0, 'PRIVATE_ROOT_NOT_PRIVATE');
  requireCondition(canonicalPrivateRoot !== canonicalRoot
    && !canonicalPrivateRoot.startsWith(`${canonicalRoot}${path.sep}`)
    && !canonicalRoot.startsWith(`${canonicalPrivateRoot}${path.sep}`), 'PRIVATE_ROOT_INVALID');
  const existing = await readdir(canonicalRoot);
  requireCondition(existing.length === 0, 'OUTPUT_ROOT_NOT_FRESH');

  state.outputDir = canonicalRoot;
  state.resultPath = path.join(canonicalRoot, 'result.json');
  state.privateDir = canonicalPrivateRoot;
  state.versionDir = path.join(canonicalPrivateRoot, 'browser-version');
  state.candidateSha = process.env.REPOSITORY_DESTINATION_CANDIDATE_SHA;
  state.runId = process.env.REPOSITORY_DESTINATION_RUN_ID;
  state.runAttempt = Number(process.env.REPOSITORY_DESTINATION_RUN_ATTEMPT);
  await mkdir(path.join(state.privateDir, 'home'), { mode: 0o700 });
  await mkdir(path.join(state.privateDir, 'tmp'), { mode: 0o700 });
  await mkdir(state.versionDir, { mode: 0o700 });
  // Short path under the OS temp root; the bound private root alone is too long for Chromium sockets.
  const runtimeToken = sha256(`${state.runId}:${state.runAttempt}:${state.candidateSha}`).slice(0, 10);
  state.browserRuntimeDir = await mkdtemp(path.join(os.tmpdir(), `rd${runtimeToken}-`));
  const runtimeStat = await lstat(state.browserRuntimeDir);
  requireCondition(runtimeStat.isDirectory() && !runtimeStat.isSymbolicLink()
    && (runtimeStat.mode & 0o077) === 0, 'PRIVATE_ROOT_NOT_PRIVATE');
  state.browserTempDir = path.join(state.browserRuntimeDir, 't');
  state.browserProfileDir = path.join(state.browserRuntimeDir, 'p');
  await mkdir(state.browserTempDir, { mode: 0o700 });
  await mkdir(state.browserProfileDir, { mode: 0o700 });
  state.outputReady = true;
}

function browserEnvironment() {
  const temp = state.browserTempDir;
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: path.join(state.privateDir, 'home'),
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
  };
}

function boundedCollector(maxBytes) {
  const buffer = Buffer.alloc(maxBytes);
  let capturedBytes = 0;
  let observedBytes = 0n;
  let truncated = false;
  return {
    add(chunk) {
      observedBytes += BigInt(chunk.length);
      const count = Math.min(maxBytes - capturedBytes, chunk.length);
      if (count > 0) {
        chunk.copy(buffer, capturedBytes, 0, count);
        capturedBytes += count;
      }
      if (count < chunk.length) truncated = true;
    },
    finish() {
      const bytes = Buffer.from(buffer.subarray(0, capturedBytes));
      return {
        bytes,
        capturedBytes,
        observedBytes: observedBytes.toString(),
        truncated,
        sha256: sha256(bytes),
      };
    },
  };
}

export function captureVersionChild(executable, cwd, env, spawnChild = spawn, now = () => new Date().toISOString()) {
  const startedAt = now();
  const stdout = boundedCollector(maxVersionOutputBytes);
  const stderr = boundedCollector(maxVersionOutputBytes);
  let child;
  try {
    child = spawnChild(executable, ['--version'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return Promise.resolve({
      started: false, pid: null, startedAt, exitCode: null, signal: null, timedOut: false,
      spawnFailed: true, stdout: stdout.finish(), stderr: stderr.finish(), version: '',
    });
  }
  return new Promise(resolve => {
    let timedOut = false;
    let spawnFailed = false;
    let settled = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, 5000);
    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      const stdoutCapture = stdout.finish();
      const stderrCapture = stderr.finish();
      resolve({
        started: true,
        pid: Number.isInteger(child.pid) ? child.pid : null,
        startedAt,
        exitCode,
        signal,
        timedOut,
        spawnFailed,
        stdout: stdoutCapture,
        stderr: stderrCapture,
        version: stdoutCapture.bytes.toString('utf8').trim(),
      });
    };
    child.stdout.on('data', chunk => stdout.add(chunk));
    child.stderr.on('data', chunk => stderr.add(chunk));
    child.once('error', () => {
      spawnFailed = true;
      finish(null, null);
    });
    child.once('close', (exitCode, signal) => finish(exitCode, signal));
  });
}

async function persistVersionChild(result, versionDir = state.versionDir) {
  try {
    await writeFile(path.join(versionDir, 'stdout.bin'), result.stdout.bytes, { flag: 'wx', mode: 0o600 });
    await writeFile(path.join(versionDir, 'stderr.bin'), result.stderr.bytes, { flag: 'wx', mode: 0o600 });
    const privateRecord = {
      schema: versionCaptureSchema,
      started: result.started,
      pid: result.pid,
      startedAt: result.startedAt,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      spawnFailed: result.spawnFailed,
      stdout: {
        file: 'stdout.bin', capturedBytes: result.stdout.capturedBytes,
        observedBytes: result.stdout.observedBytes, sha256: result.stdout.sha256,
        truncated: result.stdout.truncated,
      },
      stderr: {
        file: 'stderr.bin', capturedBytes: result.stderr.capturedBytes,
        observedBytes: result.stderr.observedBytes, sha256: result.stderr.sha256,
        truncated: result.stderr.truncated,
      },
    };
    await writeFile(path.join(versionDir, 'outcome.json'), `${JSON.stringify(privateRecord, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 });
  } catch {
    fail('PRIVATE_CAPTURE_WRITE_FAILED');
  }
}

async function browserVersion(executable, cwd, env) {
  const result = await captureVersionChild(executable, cwd, env);
  await persistVersionChild(result);
  return { ...result, outcome: classifyVersionOutcome(result) };
}

function safeFailureReason(error) {
  return typeof error?.failureReason === 'string' && failureReasons.has(error.failureReason)
    ? error.failureReason : 'UNEXPECTED_FAILURE';
}

function makeResult(status, reason) {
  const version = state.browserVersionResult;
  return {
    schema: resultSchema,
    status,
    reason,
    scenarios: 5,
    candidateSha: state.candidateSha,
    runId: state.runId,
    runAttempt: state.runAttempt,
    baselineSourceCommit,
    baselineSourceTree,
    componentSha256: expectedComponentSha256,
    browserVersionOutcome: version?.outcome ?? 'NOT_STARTED',
    browserVersion: version?.outcome === 'VERSION_OK' ? expectedBrowserVersion : null,
    browserSha256: state.browserSha256,
    localGetRequests: state.localRequests,
    blockedRequests: state.blockedRequests,
    blockedDataRequests: state.blockedDataRequests,
    websocketCount: state.websocketCount,
  };
}

async function writeResult(value) {
  requireCondition(state.outputReady, 'RESULT_CAPTURE_FAILED');
  requireCondition(!state.outputWritten, 'RESULT_CAPTURE_FAILED');
  const binding = { candidateSha: state.candidateSha, runId: state.runId, runAttempt: state.runAttempt };
  requireCondition(validateResultRecord(value, binding), 'RESULT_CAPTURE_FAILED');
  await atomicPublishJson(state.resultPath, value, parsed => validateResultRecord(parsed, binding));
  state.outputWritten = true;
}

async function requireVisible(page, text) {
  const locator = page.getByText(text, { exact: true });
  await locator.waitFor({ state: 'visible', timeout: timeoutMs });
  return locator;
}

async function runFixture() {
  await prepareOutput();

  const workspaceRoot = process.env.GITHUB_WORKSPACE;
  requireCondition(typeof workspaceRoot === 'string' && path.isAbsolute(workspaceRoot), 'WORKSPACE_ROOT_INVALID');
  const repoRoot = await realpath(workspaceRoot);
  requireCondition(repoRoot === path.resolve(workspaceRoot), 'WORKSPACE_ROOT_NOT_CANONICAL');

  const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
  requireCondition(await realpath(fixtureRoot) === fixtureRoot, 'FIXTURE_ROOT_NOT_CANONICAL');
  const appRoot = path.join(repoRoot, 'apps', 'web');
  requireCondition(await realpath(appRoot) === appRoot, 'WEB_ROOT_NOT_CANONICAL');
  const toolAnchor = path.join(fixtureRoot, 'package.json');
  requireCondition(await realpath(toolAnchor) === toolAnchor, 'HELPER_MANIFEST_NOT_CANONICAL');

  const componentPath = path.join(appRoot, 'components/project/ProjectRepository.tsx');
  requireCondition(await realpath(componentPath) === componentPath, 'COMPONENT_PATH_NOT_CANONICAL');
  requireCondition(sha256(await readFile(componentPath)) === expectedComponentSha256, 'COMPONENT_HASH_MISMATCH');

  const browserPath = process.env.CHROME_PATH;
  requireCondition(browserPath === expectedBrowserPath, 'BROWSER_PATH_UNSUPPORTED');
  const browserStat = await lstat(browserPath);
  requireCondition(browserStat.isFile() && (browserStat.mode & 0o111) !== 0 && browserStat.uid === 0,
    'BROWSER_BINARY_NOT_ROOT_OWNED_EXECUTABLE');
  requireCondition(await realpath(browserPath) === browserPath, 'BROWSER_BINARY_NOT_CANONICAL');
  state.browserSha256 = await sha256File(browserPath);
  state.browserVersionResult = await browserVersion(browserPath, fixtureRoot, browserEnvironment());
  requireCondition(state.browserVersionResult.outcome === 'VERSION_OK', 'BROWSER_VERSION_UNSUPPORTED');

  const toolRequire = createRequire(toolAnchor);
  const viteModule = await import(pathToFileURL(toolRequire.resolve('vite')).href);
  const reactModule = await import(pathToFileURL(toolRequire.resolve('@vitejs/plugin-react')).href);
  // createRequire resolves the CJS entry (index.js). Dynamic import of that file does not
  // surface named ESM exports such as chromium; use the package's import entry instead.
  const playwrightRoot = path.dirname(toolRequire.resolve('playwright-core/package.json'));
  const playwrightEntry = path.join(playwrightRoot, 'index.mjs');
  requireCondition(await realpath(playwrightEntry) === playwrightEntry, 'TOOL_API_UNSUPPORTED');
  const playwrightModule = await import(pathToFileURL(playwrightEntry).href);
  const reactPlugin = reactModule.default;
  const chromium = playwrightModule.chromium;
  requireCondition(typeof viteModule.createServer === 'function'
    && typeof reactPlugin === 'function'
    && typeof chromium?.launchPersistentContext === 'function', 'TOOL_API_UNSUPPORTED');

  state.server = await viteModule.createServer({
    configFile: false,
    root: fixtureRoot,
    envDir: fixtureRoot,
    envPrefix: [],
    cacheDir: path.join(state.privateDir, 'vite-cache'),
    appType: 'spa',
    plugins: [
      reactPlugin(),
      {
        name: 'repository-destination-strip-vite-client',
        transformIndexHtml: {
          order: 'post',
          handler(html) {
            return html.replace(/<script\b[^>]*\bsrc=["']\/@vite\/client["'][^>]*><\/script>\s*/g, '');
          },
        },
      },
    ],
    resolve: {
      alias: [
        { find: 'react-dom/client', replacement: `${appRoot}/node_modules/react-dom/client` },
        { find: 'react-dom', replacement: `${appRoot}/node_modules/react-dom` },
        { find: 'react/jsx-runtime', replacement: `${appRoot}/node_modules/react/jsx-runtime` },
        { find: 'react/jsx-dev-runtime', replacement: `${appRoot}/node_modules/react/jsx-dev-runtime` },
        { find: 'react', replacement: `${appRoot}/node_modules/react` },
      ],
      dedupe: ['react', 'react-dom'],
    },
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, ws: false, open: false,
      fs: { strict: true, allow: [repoRoot, fixtureRoot] } },
  });
  await state.server.listen();
  // Vite may still attach a WS endpoint even with server.ws=false / hmr=false; close it
  // before the browser session so the isolation check stays at websocketCount === 0.
  if (state.server.ws && typeof state.server.ws.close === 'function') {
    await state.server.ws.close();
  }
  const address = state.server.httpServer.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const profileDir = state.browserProfileDir;
  state.context = await chromium.launchPersistentContext(profileDir, {
    executablePath: browserPath,
    env: browserEnvironment(),
    headless: true,
    chromiumSandbox: true,
    serviceWorkers: 'block',
    viewport: { width: 240, height: 640 },
  });
  const page = state.context.pages()[0];
  // playwright-core 1.63 WebSocket is observational (no close()); count only.
  page.on('websocket', () => { state.websocketCount += 1; });
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const dataTransport = ['fetch', 'xhr', 'websocket', 'eventsource'].includes(request.resourceType());
    if (url.origin !== baseUrl || request.method() !== 'GET' || dataTransport) {
      state.blockedRequests += 1;
      if (dataTransport) state.blockedDataRequests += 1;
      await route.abort();
      return;
    }
    state.localRequests += 1;
    await route.continue();
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: timeoutMs });

  const firstUrl = 'https://GitHub.com:8443/Arcanada-one/muneral';
  const secondUrl = 'https://Codeberg.org:9443/Arcanada-one/muneral/mirror';
  const rejectedUrl = 'https://synthetic-user:synthetic-pass@rejected.example/private/path?token=synthetic';
  const firstText = 'github.com:8443/Arcanada-one/muneral';
  const secondText = 'codeberg.org:9443/Arcanada-one/muneral/mirror';

  await requireVisible(page, firstText);
  const firstLink = page.getByRole('link', { name: 'Open repository' });
  assert.equal(await firstLink.getAttribute('href'), firstUrl);
  assert.equal(await firstLink.getAttribute('target'), '_blank');
  assert.equal(await firstLink.getAttribute('rel'), 'noopener noreferrer');
  const wrap = await page.locator('[data-testid="destination-frame"] p').evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const style = getComputedStyle(element);
    return { lines: range.getClientRects().length, width: element.clientWidth,
      scrollWidth: element.scrollWidth, overflowWrap: style.overflowWrap };
  });
  assert.ok(wrap.lines >= 2);
  assert.ok(wrap.width > 0 && wrap.scrollWidth <= wrap.width);
  assert.equal(wrap.overflowWrap, 'anywhere');

  await page.getByRole('button', { name: 'Second safe destination', exact: true }).click();
  await requireVisible(page, secondText);
  assert.equal(await page.getByRole('link', { name: 'Open repository' }).getAttribute('href'), secondUrl);
  assert.equal(await page.getByText(firstText, { exact: true }).count(), 0);

  await page.getByRole('button', { name: 'Rejected destination', exact: true }).click();
  await requireVisible(page, 'Repository link unavailable');
  assert.equal(await page.getByRole('alert').count(), 1);
  assert.equal(await page.getByRole('link').count(), 0);
  const rejectedBody = await page.locator('body').innerText();
  assert.equal(rejectedBody.includes(rejectedUrl), false);
  assert.equal(rejectedBody.includes('rejected.example'), false);
  assert.equal(rejectedBody.includes('private/path'), false);
  assert.equal(await page.getByText(secondText, { exact: true }).count(), 0);

  await page.getByRole('button', { name: 'Missing destination', exact: true }).click();
  await requireVisible(page, 'No repository linked');
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await page.getByRole('link').count(), 0);
  assert.equal(state.blockedRequests, 0);
  assert.equal(state.blockedDataRequests, 0);
  assert.equal(state.websocketCount, 0);
}

async function closeBrowserResources() {
  if (state.context) await state.context.close().catch(() => {});
  if (state.server) await state.server.close().catch(() => {});
  if (state.browserRuntimeDir) {
    await rm(state.browserRuntimeDir, { recursive: true, force: true }).catch(() => {});
    state.browserRuntimeDir = null;
    state.browserTempDir = null;
    state.browserProfileDir = null;
  }
}

async function main() {
  let status = 'FAIL';
  let reason = 'UNEXPECTED_FAILURE';
  try {
    await runFixture();
    status = 'PASS';
    reason = null;
  } catch (error) {
    reason = safeFailureReason(error);
  }
  await closeBrowserResources();
  if (state.outputReady) {
    try {
      await writeResult(makeResult(status, reason));
    } catch {
      reason = 'RESULT_CAPTURE_FAILED';
      status = 'FAIL';
    }
  }
  if (status === 'PASS') {
    process.stdout.write('repository destination browser fixture: PASS\n');
  } else {
    process.stderr.write(`repository destination browser fixture: ${reason}\n`);
    process.exitCode = 1;
  }
}

async function cli() {
  if (process.argv[2] === '--validate-artifacts') {
    await runValidateArtifacts();
    return;
  }
  if (process.argv[2] === '--write-runner-exit') {
    await runWriteRunnerExit(process.argv[3] ?? '');
    return;
  }
  await main();
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  cli().catch(() => {
    process.stderr.write('repository destination browser fixture: CAPTURE_OR_VALIDATION_FAILED\n');
    process.exitCode = 1;
  });
}

export const __test = Object.freeze({
  atomicPublishJson,
  boundedCollector,
  classifyVersionOutcome,
  expectedOutputRoot,
  expectedPrivateRoot,
  persistVersionChild,
  validateOutputFiles,
});
