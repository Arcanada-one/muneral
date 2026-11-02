import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  link, lstat, mkdir, open, readFile, readdir, realpath, unlink, writeFile,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildFailureSummary, noBrowserCapture, publishFailureSummary,
  readCompletedBrowserCapture, validateFailureSummaryFiles,
} from './failure-summary.mjs';

const EXPECTED_BROWSER_PATH = '/opt/arcanada-browsers/cft-156.0.8078.4/chrome-linux64/chrome';
const EXPECTED_BROWSER_VERSION = 'Google Chrome for Testing 156.0.8078.4';
// Derived from Chrome for Testing 156.0.8078.4 linux64 official archive:
// https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.4/linux64/chrome-linux64.zip
// Archive SHA-256: 43fd31766c7533a02dda2ded5ad50c2f861cd5400be7509c0abad71129f79d79.
const EXPECTED_BROWSER_SHA256 = '377a9fc07b495c3b8d0ab8ec1fdfd153641759f9756fea34d8dfce4de82f5025';
const EXPECTED_COMPONENT_SHA256 = '36da1780353fe7c2fc33ef8d813853201848dbeb79f2d06765417939e751bb23';
const RESULT_SCHEMA = 'ActivityVisibleCountBrowser/v1';
const PRIVATE_PROCESS_SCHEMA = 'ActivityVisibleCountProcess/v1';
const FIXTURE_TIMEOUT_MS = 180_000;
const STEP_TIMEOUT_MS = 15_000;
const CHILD_TIMEOUT_MS = 15_000;
const CAPTURE_LIMIT_BYTES = 64 * 1024;
const RESULT_LIMIT_BYTES = 16 * 1024;
const SCENARIOS = Object.freeze([
  'defaultPageCount', 'filterIntersection', 'filterEmpty', 'clearRecovery',
  'paginationTotals', 'exactUtc', 'taskChangeReset', 'emptyPage',
]);
const VERDICTS = new Set(['PASS', 'FAIL', 'NOT_MEASURED']);
const BROWSER_VERSION_OUTCOMES = new Set([
  'NOT_STARTED', 'VERSION_OK', 'VERSION_FAILED', 'VERSION_TIMEOUT',
  'VERSION_SPAWN_FAILED', 'VERSION_MISMATCH',
]);
const FAILURE_REASONS = new Set([
  'RUN_BINDING_INVALID', 'OUTPUT_PREPARATION_FAILED', 'WORKSPACE_UNAVAILABLE',
  'CANDIDATE_HEAD_UNAVAILABLE', 'CANDIDATE_HEAD_MISMATCH', 'COMPONENT_SOURCE_UNAVAILABLE',
  'COMPONENT_HASH_MISMATCH', 'NODE_WEBSOCKET_UNSUPPORTED', 'BROWSER_PATH_UNSUPPORTED',
  'BROWSER_BINARY_UNAVAILABLE', 'BROWSER_BINARY_HASH_MISMATCH', 'BROWSER_VERSION_FAILED', 'BROWSER_VERSION_TIMEOUT',
  'BROWSER_VERSION_SPAWN_FAILED', 'BROWSER_VERSION_MISMATCH', 'TOOL_MODULE_LOAD_FAILED',
  'SERVER_CREATE_FAILED', 'SERVER_LISTEN_FAILED', 'SERVER_ADDRESS_UNAVAILABLE',
  'CDP_ENDPOINT_UNAVAILABLE', 'CDP_CONNECT_FAILED', 'CDP_COMMAND_FAILED',
  'BROWSER_SPAWN_FAILED', 'BROWSER_PROCESS_EXITED', 'NETWORK_BOUNDARY_VIOLATION',
  'SCENARIO_DEFAULT_PAGE_COUNT_FAILED', 'SCENARIO_FILTER_INTERSECTION_FAILED',
  'SCENARIO_FILTER_EMPTY_FAILED', 'SCENARIO_CLEAR_RECOVERY_FAILED',
  'SCENARIO_PAGINATION_TOTALS_FAILED', 'SCENARIO_EXACT_UTC_FAILED',
  'SCENARIO_TASK_CHANGE_RESET_FAILED', 'SCENARIO_EMPTY_PAGE_FAILED',
  'ADAPTER_CONTRACT_FAILED', 'RESULT_CAPTURE_FAILED', 'FIXTURE_TIMEOUT',
  'UNEXPECTED_FAILURE',
]);

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validateResultRecord(value, binding = {}) {
  const topKeys = [
    'schema', 'status', 'reason', 'candidateSha', 'runId', 'runAttempt',
    'componentSha256', 'browserVersionOutcome', 'browserVersion', 'browserSha256',
    'scenarioVerdicts', 'counts',
  ];
  const countKeys = [
    'localAssetRequests', 'blockedNetworkRequests', 'networkViolations', 'websocketAttempts',
    'syntheticGetAttempts', 'syntheticGetSuccesses', 'rejectedAdapterCalls', 'mutationAttempts',
  ];
  if (!exactKeys(value, topKeys) || value.schema !== RESULT_SCHEMA) return false;
  if (value.status !== 'PASS' && value.status !== 'FAIL') return false;
  if (value.status === 'PASS' && value.reason !== null) return false;
  if (value.status === 'FAIL' && !FAILURE_REASONS.has(value.reason)) return false;
  if (!/^[a-f0-9]{40}$/.test(value.candidateSha)) return false;
  if (binding.candidateSha !== undefined && value.candidateSha !== binding.candidateSha) return false;
  if (!/^[0-9]+$/.test(value.runId) || !/^[1-9][0-9]*$/.test(String(value.runAttempt))) return false;
  if (binding.runId !== undefined && value.runId !== binding.runId) return false;
  if (binding.runAttempt !== undefined && value.runAttempt !== binding.runAttempt) return false;
  if (value.componentSha256 !== EXPECTED_COMPONENT_SHA256) return false;
  if (!BROWSER_VERSION_OUTCOMES.has(value.browserVersionOutcome)) return false;
  if (value.browserVersionOutcome === 'VERSION_OK') {
    if (value.browserVersion !== EXPECTED_BROWSER_VERSION || value.browserSha256 !== EXPECTED_BROWSER_SHA256) return false;
  } else if (value.browserVersion !== null || (value.browserSha256 !== null && value.browserSha256 !== EXPECTED_BROWSER_SHA256)) {
    return false;
  }
  if (!exactKeys(value.scenarioVerdicts, SCENARIOS)) return false;
  if (!Object.values(value.scenarioVerdicts).every((verdict) => VERDICTS.has(verdict))) return false;
  if (value.status === 'PASS' && !Object.values(value.scenarioVerdicts).every((verdict) => verdict === 'PASS')) return false;
  if (!exactKeys(value.counts, countKeys) || !Object.values(value.counts).every(validCounter)) return false;
  if (value.status === 'PASS' && (
    value.counts.blockedNetworkRequests !== 0 || value.counts.networkViolations !== 0 ||
    value.counts.websocketAttempts !== 0 || value.counts.rejectedAdapterCalls !== 0 ||
    value.counts.mutationAttempts !== 0 || value.browserVersionOutcome !== 'VERSION_OK' ||
    value.counts.localAssetRequests === 0 || value.counts.syntheticGetSuccesses === 0 ||
    value.counts.syntheticGetAttempts !== value.counts.syntheticGetSuccesses
  )) return false;
  return true;
}

export function isAllowedFixtureRequest(requestUrl, method, expectedOrigin, appRoot, repoRoot) {
  if (method !== 'GET' || typeof requestUrl !== 'string') return false;
  let parsed;
  try { parsed = new URL(requestUrl); } catch { return false; }
  if (parsed.origin !== expectedOrigin || parsed.username || parsed.password || parsed.hash) return false;
  let pathname;
  try { pathname = decodeURIComponent(parsed.pathname); } catch { return false; }
  if (pathname.split('/').some((segment) => segment === '.' || segment === '..')) return false;
  if (pathname === '/' || pathname === '/index.html' || pathname === '/main.tsx') return true;
  if (
    pathname.startsWith('/@vite/') || pathname.startsWith('/@id/') ||
    pathname.startsWith('/@react-refresh') || pathname.startsWith('/node_modules/.vite/')
  ) return true;
  const appPrefix = `/@fs${path.resolve(appRoot)}/`;
  const typesPrefix = `/@fs${path.resolve(repoRoot, 'packages/types/src')}/`;
  return pathname.startsWith(appPrefix) || pathname.startsWith(typesPrefix);
}

export function browserArguments(profilePath) {
  return [
    '--headless=new',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profilePath}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-extensions',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  ];
}

export async function atomicPublishJson(directory, value) {
  const destination = path.join(directory, 'result.json');
  const temporary = path.join(directory, `.result-${randomUUID()}.tmp`);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, destination);
    await unlink(temporary);
    const directoryHandle = await open(directory, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return destination;
}

function utcNow() {
  return new Date().toISOString();
}

function fail(reason) {
  const error = new Error('activity count fixture failed');
  error.failureReason = FAILURE_REASONS.has(reason) ? reason : 'UNEXPECTED_FAILURE';
  return error;
}

function privateEnvironment(privateRoot) {
  const temporary = path.join(privateRoot, 'tmp');
  return {
    PATH: '/usr/bin:/bin',
    HOME: path.join(privateRoot, 'home'),
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
  };
}

function createCollector(maxBytes = CAPTURE_LIMIT_BYTES) {
  const chunks = [];
  const hash = createHash('sha256');
  let capturedBytes = 0;
  let observedBytes = 0;
  let finished;
  return {
    add(chunk) {
      const buffer = Buffer.from(chunk);
      hash.update(buffer);
      observedBytes += buffer.length;
      const remaining = maxBytes - capturedBytes;
      if (remaining > 0) {
        const kept = buffer.subarray(0, remaining);
        chunks.push(kept);
        capturedBytes += kept.length;
      }
    },
    finish() {
      if (finished) return finished;
      finished = {
        bytes: Buffer.concat(chunks),
        capturedBytes,
        observedBytes,
        truncated: observedBytes > capturedBytes,
        sha256: hash.digest('hex'),
      };
      return finished;
    },
  };
}

async function writePrivateChildCapture(privateRoot, label, record, stdout, stderr) {
  await writeFile(path.join(privateRoot, `${label}.stdout.raw`), stdout.bytes, { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(privateRoot, `${label}.stderr.raw`), stderr.bytes, { flag: 'wx', mode: 0o600 });
  const privateRecord = {
    schema: PRIVATE_PROCESS_SCHEMA,
    label,
    argv: record.argv,
    cwd: record.cwd,
    pid: record.pid,
    processGroup: record.processGroup,
    startedAtUtc: record.startedAtUtc,
    endedAtUtc: record.endedAtUtc,
    exitCode: record.exitCode,
    signal: record.signal,
    timedOut: record.timedOut,
    spawnFailed: record.spawnFailed,
    stdout: {
      file: `${label}.stdout.raw`, capturedBytes: stdout.capturedBytes,
      observedBytes: stdout.observedBytes, truncated: stdout.truncated, sha256: stdout.sha256,
    },
    stderr: {
      file: `${label}.stderr.raw`, capturedBytes: stderr.capturedBytes,
      observedBytes: stderr.observedBytes, truncated: stderr.truncated, sha256: stderr.sha256,
    },
  };
  await writeFile(path.join(privateRoot, `${label}.process.json`), `${JSON.stringify(privateRecord, null, 2)}\n`, {
    flag: 'wx', mode: 0o600,
  });
  return privateRecord;
}

function spawnCaptured(executable, argv, { cwd, env, label, privateRoot, timeoutMs = CHILD_TIMEOUT_MS, detached = true }) {
  const startedAtUtc = utcNow();
  const stdout = createCollector();
  const stderr = createCollector();
  let child;
  let timer;
  let killTimer;
  let settled = false;
  let timedOut = false;
  let spawnFailed = false;
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  const record = {
    argv: [executable, ...argv], cwd, pid: null, processGroup: null,
    startedAtUtc, endedAtUtc: null, exitCode: null, signal: null,
    timedOut: false, spawnFailed: false,
  };
  const finish = async (exitCode, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    record.endedAtUtc = utcNow();
    record.exitCode = Number.isInteger(exitCode) ? exitCode : null;
    record.signal = signal ?? null;
    record.timedOut = timedOut;
    record.spawnFailed = spawnFailed;
    const stdoutResult = stdout.finish();
    const stderrResult = stderr.finish();
    try {
      await writePrivateChildCapture(privateRoot, label, record, stdoutResult, stderrResult);
    } catch {
      record.captureFailed = true;
    }
    resolveCompletion(record);
  };
  try {
    child = spawn(executable, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached });
  } catch {
    spawnFailed = true;
    void finish(null, null);
    return { child: null, record, completion, terminate: async () => {} };
  }
  record.pid = Number.isInteger(child.pid) ? child.pid : null;
  record.processGroup = record.pid;
  child.stdout.on('data', (chunk) => stdout.add(chunk));
  child.stderr.on('data', (chunk) => stderr.add(chunk));
  child.once('error', () => {
    spawnFailed = true;
    void finish(null, null);
  });
  child.once('close', (exitCode, signal) => { void finish(exitCode, signal); });
  timer = setTimeout(() => {
    timedOut = true;
    if (record.pid !== null) {
      try { process.kill(-record.pid, 'SIGTERM'); } catch {}
      killTimer = setTimeout(() => {
        try { process.kill(-record.pid, 'SIGKILL'); } catch {}
      }, 5_000);
    }
  }, timeoutMs);
  return {
    child,
    record,
    completion,
    async terminate() {
      if (settled || record.pid === null) return completion;
      try { process.kill(-record.pid, 'SIGTERM'); } catch {}
      await Promise.race([completion, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      if (!settled) {
        try { process.kill(-record.pid, 'SIGKILL'); } catch {}
        await completion;
      }
      return completion;
    },
  };
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', () => reject(fail('BROWSER_BINARY_UNAVAILABLE')));
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(fail('CDP_CONNECT_FAILED')), { once: true });
    });
    this.socket.addEventListener('message', (event) => this.onMessage(event));
    this.socket.addEventListener('close', () => this.onClose());
    this.socket.addEventListener('error', () => this.onClose());
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(handler);
    return () => this.handlers.get(method)?.delete(handler);
  }

  onMessage(event) {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { this.onClose(); return; }
    if (Number.isInteger(message.id)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(fail('CDP_COMMAND_FAILED'));
      else pending.resolve(message.result ?? {});
      return;
    }
    const handlers = this.handlers.get(message.method);
    if (!handlers) return;
    const payload = { params: message.params ?? {}, sessionId: message.sessionId };
    for (const handler of handlers) {
      Promise.resolve().then(() => handler(payload)).catch(() => {});
    }
  }

  onClose() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(fail('CDP_COMMAND_FAILED'));
    }
    this.pending.clear();
  }

  async send(method, params = {}, sessionId) {
    await this.ready;
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw fail('CDP_COMMAND_FAILED');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(fail('CDP_COMMAND_FAILED'));
      }, STEP_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      try { this.socket.send(JSON.stringify(message)); } catch { this.pending.delete(id); clearTimeout(timer); reject(fail('CDP_COMMAND_FAILED')); }
    });
  }

  async waitFor(method, sessionId, timeoutMs = STEP_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let timer;
      const off = this.on(method, (event) => {
        if (sessionId && event.sessionId !== sessionId) return;
        clearTimeout(timer);
        off();
        resolve(event.params);
      });
      timer = setTimeout(() => {
        off();
        reject(fail('CDP_COMMAND_FAILED'));
      }, timeoutMs);
    });
  }

  close() {
    this.onClose();
    try { this.socket.close(); } catch {}
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDevToolsEndpoint(profilePath, browser, timeoutMs = STEP_TIMEOUT_MS) {
  const activePortPath = path.join(profilePath, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (browser.record.endedAtUtc !== null || browser.record.spawnFailed) throw fail('BROWSER_PROCESS_EXITED');
    try {
      const text = await readFile(activePortPath, 'utf8');
      const [portText, endpoint] = text.trim().split('\n');
      const port = Number(portText);
      if (Number.isSafeInteger(port) && port > 0 && port <= 65535 && /^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(endpoint ?? '')) {
        return `ws://127.0.0.1:${port}${endpoint}`;
      }
    } catch {}
    await delay(50);
  }
  throw fail('CDP_ENDPOINT_UNAVAILABLE');
}

async function runtimeValue(cdp, sessionId, expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  }, sessionId);
  if (response.exceptionDetails || !response.result) throw fail('CDP_COMMAND_FAILED');
  return response.result.value;
}

async function waitForBodyText(cdp, sessionId, expectedText, timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await runtimeValue(cdp, sessionId, 'document.body?.innerText ?? ""');
    if (typeof text === 'string' && text.includes(expectedText)) return;
    await delay(100);
  }
  throw fail('CDP_COMMAND_FAILED');
}

async function bodyIncludes(cdp, sessionId, expectedText) {
  const text = await runtimeValue(cdp, sessionId, 'document.body?.innerText ?? ""');
  return typeof text === 'string' && text.includes(expectedText);
}

async function selectValue(cdp, sessionId, labelText, value) {
  const expression = `(() => {
    const label = [...document.querySelectorAll('label')].find((node) => node.textContent.trim() === ${JSON.stringify(labelText)});
    const select = label ? document.getElementById(label.htmlFor) : null;
    if (!(select instanceof HTMLSelectElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (!setter) return false;
    setter.call(select, ${JSON.stringify(value)});
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return select.value === ${JSON.stringify(value)};
  })()`;
  if (await runtimeValue(cdp, sessionId, expression) !== true) throw fail('CDP_COMMAND_FAILED');
}

async function selectedValue(cdp, sessionId, labelText) {
  const expression = `(() => {
    const label = [...document.querySelectorAll('label')].find((node) => node.textContent.trim() === ${JSON.stringify(labelText)});
    const select = label ? document.getElementById(label.htmlFor) : null;
    return select instanceof HTMLSelectElement ? select.value : null;
  })()`;
  return runtimeValue(cdp, sessionId, expression);
}

async function clickButton(cdp, sessionId, accessibleName) {
  const expression = `(() => {
    const button = document.querySelector('button[aria-label=' + JSON.stringify(${JSON.stringify(accessibleName)}) + ']');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return null;
    const rect = button.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`;
  const point = await runtimeValue(cdp, sessionId, expression);
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw fail('CDP_COMMAND_FAILED');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 }, sessionId);
}

async function clickExactUtcCheckbox(cdp, sessionId) {
  const point = await runtimeValue(cdp, sessionId, `(() => {
    const checkbox = document.querySelector('input[type="checkbox"]');
    if (!(checkbox instanceof HTMLInputElement) || checkbox.disabled) return null;
    const rect = checkbox.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  })()`);
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw fail('CDP_COMMAND_FAILED');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 }, sessionId);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 }, sessionId);
}

async function checkEmptyState(cdp, sessionId, message) {
  await waitForBodyText(cdp, sessionId, message);
  return bodyIncludes(cdp, sessionId, 'No activity on this page.');
}

function browserBinaryIsAccepted(browserStat, browserPath, canonicalPath) {
  return browserPath === EXPECTED_BROWSER_PATH && canonicalPath === EXPECTED_BROWSER_PATH &&
    browserStat.isFile() && !browserStat.isSymbolicLink() && browserStat.uid === 0 &&
    (browserStat.mode & 0o111) !== 0 && (browserStat.mode & 0o022) === 0;
}

function expectedRoots(runnerTemp, runId, runAttempt, candidateSha) {
  return {
    artifact: path.join(runnerTemp, 'activity-visible-count-artifacts', runId, String(runAttempt), candidateSha),
    private: path.join(runnerTemp, 'activity-visible-count-private', runId, String(runAttempt), candidateSha),
  };
}

async function privateDirectory(pathname) {
  const info = await lstat(pathname);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw fail('OUTPUT_PREPARATION_FAILED');
  return realpath(pathname);
}

async function prepareOutput(state) {
  const runId = process.env.GITHUB_RUN_ID;
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  const candidateSha = process.env.ACTIVITY_COUNT_CANDIDATE_SHA;
  const runnerTemp = process.env.RUNNER_TEMP;
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!/^[0-9]+$/.test(runId ?? '') || !/^[1-9][0-9]*$/.test(String(process.env.GITHUB_RUN_ATTEMPT ?? '')) ||
      !/^[a-f0-9]{40}$/.test(candidateSha ?? '') || !path.isAbsolute(runnerTemp ?? '') || !path.isAbsolute(workspace ?? '')) {
    throw fail('RUN_BINDING_INVALID');
  }
  const roots = expectedRoots(path.resolve(runnerTemp), runId, runAttempt, candidateSha);
  if (process.env.ACTIVITY_COUNT_OUTPUT_ROOT !== roots.artifact || process.env.ACTIVITY_COUNT_PRIVATE_ROOT !== roots.private) {
    throw fail('RUN_BINDING_INVALID');
  }
  const workspaceReal = await realpath(workspace).catch(() => { throw fail('WORKSPACE_UNAVAILABLE'); });
  if (workspaceReal !== path.resolve(workspace)) throw fail('WORKSPACE_UNAVAILABLE');
  const artifactReal = await privateDirectory(roots.artifact);
  const privateReal = await privateDirectory(roots.private);
  if (artifactReal !== roots.artifact || privateReal !== roots.private ||
      artifactReal === privateReal || artifactReal.startsWith(`${privateReal}${path.sep}`) ||
      privateReal.startsWith(`${artifactReal}${path.sep}`)) throw fail('OUTPUT_PREPARATION_FAILED');
  const existing = await readdir(artifactReal);
  if (existing.length !== 0) throw fail('OUTPUT_PREPARATION_FAILED');
  state.artifactRoot = artifactReal;
  state.privateRoot = privateReal;
  state.candidateSha = candidateSha;
  state.runId = runId;
  state.runAttempt = runAttempt;
  state.repoRoot = workspaceReal;
  state.appRoot = path.join(workspaceReal, 'apps/web');
  state.fixtureRoot = path.join(state.appRoot, 'e2e/activity-visible-count');
  state.outputReady = true;
  await mkdir(path.join(privateReal, 'home'), { mode: 0o700 });
  await mkdir(path.join(privateReal, 'tmp'), { mode: 0o700 });
  await mkdir(path.join(privateReal, 'browser-profile'), { mode: 0o700 });
  await mkdir(path.join(privateReal, 'vite-cache'), { mode: 0o700 });
}

async function verifyCandidateSource(state) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: state.repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (!/^[a-f0-9]{40}$/.test(head)) throw fail('CANDIDATE_HEAD_UNAVAILABLE');
  if (head !== state.candidateSha) throw fail('CANDIDATE_HEAD_MISMATCH');
  const componentPath = path.join(state.appRoot, 'components/task/AuditLog.tsx');
  const componentBytes = await readFile(componentPath).catch(() => { throw fail('COMPONENT_SOURCE_UNAVAILABLE'); });
  if (createHash('sha256').update(componentBytes).digest('hex') !== EXPECTED_COMPONENT_SHA256) throw fail('COMPONENT_HASH_MISMATCH');
}

async function verifyBrowser(state, dependencies = {}) {
  if (typeof WebSocket !== 'function') throw fail('NODE_WEBSOCKET_UNSUPPORTED');
  const browserPath = dependencies.browserPath ?? process.env.CHROME_PATH;
  if (browserPath !== EXPECTED_BROWSER_PATH) throw fail('BROWSER_PATH_UNSUPPORTED');
  const inspectPath = dependencies.lstatPath ?? lstat;
  const resolvePath = dependencies.realpathPath ?? realpath;
  const readDigest = dependencies.readDigest ?? sha256File;
  const launchVersion = dependencies.launchVersion ?? spawnCaptured;
  const readVersionOutput = dependencies.readVersionOutput ?? (async (privateRoot) =>
    readFile(path.join(privateRoot, 'browser-version.stdout.raw'), 'utf8').catch(() => '')
  );
  const browserInfo = await inspectPath(browserPath).catch(() => { throw fail('BROWSER_BINARY_UNAVAILABLE'); });
  const canonicalPath = await resolvePath(browserPath).catch(() => { throw fail('BROWSER_BINARY_UNAVAILABLE'); });
  if (!browserBinaryIsAccepted(browserInfo, browserPath, canonicalPath)) throw fail('BROWSER_BINARY_UNAVAILABLE');
  const measuredDigest = await readDigest(browserPath);
  if (measuredDigest !== EXPECTED_BROWSER_SHA256) throw fail('BROWSER_BINARY_HASH_MISMATCH');
  state.browserSha256 = measuredDigest;
  const versionCapture = launchVersion(browserPath, ['--version'], {
    cwd: state.privateRoot, env: privateEnvironment(state.privateRoot),
    label: 'browser-version', privateRoot: state.privateRoot, timeoutMs: 5_000,
  });
  state.versionCapture = await versionCapture.completion;
  if (state.versionCapture.captureFailed) throw fail('RESULT_CAPTURE_FAILED');
  if (state.versionCapture.spawnFailed) {
    state.browserVersionOutcome = 'VERSION_SPAWN_FAILED';
    throw fail('BROWSER_VERSION_SPAWN_FAILED');
  }
  if (state.versionCapture.timedOut) {
    state.browserVersionOutcome = 'VERSION_TIMEOUT';
    throw fail('BROWSER_VERSION_TIMEOUT');
  }
  const versionOutput = await readVersionOutput(state.privateRoot);
  if (state.versionCapture.exitCode !== 0) {
    state.browserVersionOutcome = 'VERSION_FAILED';
    throw fail('BROWSER_VERSION_FAILED');
  }
  if (versionOutput.trim() !== EXPECTED_BROWSER_VERSION) {
    state.browserVersionOutcome = 'VERSION_MISMATCH';
    throw fail('BROWSER_VERSION_MISMATCH');
  }
  state.browserVersionOutcome = 'VERSION_OK';
  state.browserVersion = EXPECTED_BROWSER_VERSION;
  state.browserVerified = true;
}

async function launchBrowserAfterVerification(state, launchBrowser, verify = verifyBrowser) {
  if (state.browserVerified !== true) await verify(state);
  if (state.browserVerified !== true) throw fail('BROWSER_BINARY_UNAVAILABLE');
  return launchBrowser();
}

async function createViteServer(state) {
  state.phase = 'TOOL_MODULE_LOAD_FAILED';
  const appAnchor = path.join(state.appRoot, 'package.json');
  const appRequire = createRequire(appAnchor);
  const vitePath = appRequire.resolve('vite');
  const reactPluginPath = appRequire.resolve('@vitejs/plugin-react');
  const viteModule = await import(pathToFileURL(vitePath).href);
  const reactModule = await import(pathToFileURL(reactPluginPath).href);
  if (typeof viteModule.createServer !== 'function' || typeof reactModule.default !== 'function') {
    throw fail('TOOL_MODULE_LOAD_FAILED');
  }
  const apiClientBase = path.resolve(state.appRoot, 'lib/api/client');
  const apiAdapterPath = path.join(state.fixtureRoot, 'synthetic-api-client.mjs');
  const exactHttpBoundary = {
    name: 'activity-count-exact-http-client-boundary',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || source !== './client') return null;
      const importerPath = importer.split('?')[0];
      if (path.resolve(path.dirname(importerPath), source) === apiClientBase) return apiAdapterPath;
      return null;
    },
  };
  const typesSource = path.join(state.repoRoot, 'packages/types/src/index.ts');
  state.phase = 'SERVER_CREATE_FAILED';
  state.server = await viteModule.createServer({
    configFile: false,
    root: state.fixtureRoot,
    envDir: state.fixtureRoot,
    envPrefix: [],
    logLevel: 'silent',
    cacheDir: path.join(state.privateRoot, 'vite-cache'),
    appType: 'spa',
    plugins: [reactModule.default(), exactHttpBoundary],
    resolve: {
      alias: [
        { find: '@muneral/types', replacement: typesSource },
        { find: '@', replacement: state.appRoot },
      ],
      dedupe: ['react', 'react-dom'],
    },
    server: {
      host: '127.0.0.1', port: 0, strictPort: false, hmr: false, open: false,
      fs: { strict: true, allow: [state.repoRoot] },
    },
  });
}

async function attachPage(state, browser) {
  const endpoint = await waitForDevToolsEndpoint(path.join(state.privateRoot, 'browser-profile'), browser);
  state.cdp = new CdpClient(endpoint);
  await state.cdp.ready.catch(() => { throw fail('CDP_CONNECT_FAILED'); });
  const target = await state.cdp.send('Target.createTarget', { url: 'about:blank' });
  if (typeof target.targetId !== 'string') throw fail('CDP_COMMAND_FAILED');
  const attached = await state.cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  if (typeof attached.sessionId !== 'string') throw fail('CDP_COMMAND_FAILED');
  state.pageSessionId = attached.sessionId;
  const baseUrl = `http://127.0.0.1:${state.server.httpServer.address().port}`;
  state.baseOrigin = new URL(baseUrl).origin;
  state.cdp.on('Fetch.requestPaused', async ({ params, sessionId }) => {
    const allowed = isAllowedFixtureRequest(params.request?.url, params.request?.method, state.baseOrigin, state.appRoot, state.repoRoot);
    if (!allowed) {
      state.counts.blockedNetworkRequests += 1;
      state.counts.networkViolations += 1;
    } else {
      state.counts.localAssetRequests += 1;
    }
    try {
      if (allowed) await state.cdp.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId);
      else await state.cdp.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }, sessionId);
    } catch {
      state.cdpFailure = true;
    }
  });
  state.cdp.on('Network.webSocketCreated', () => {
    state.counts.websocketAttempts += 1;
    state.counts.networkViolations += 1;
  });
  await state.cdp.send('Page.enable', {}, state.pageSessionId);
  await state.cdp.send('Runtime.enable', {}, state.pageSessionId);
  await state.cdp.send('Network.enable', {}, state.pageSessionId);
  await state.cdp.send('Network.setBlockedURLs', { urls: ['ws://*', 'wss://*'] }, state.pageSessionId);
  await state.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, state.pageSessionId);
  const loaded = state.cdp.waitFor('Page.loadEventFired', state.pageSessionId);
  await state.cdp.send('Page.navigate', { url: baseUrl }, state.pageSessionId);
  await loaded;
  await waitForBodyText(state.cdp, state.pageSessionId, 'Activity Log');
}

async function runScenarios(state) {
  const cdp = state.cdp;
  const session = state.pageSessionId;
  state.phase = 'SCENARIO_DEFAULT_PAGE_COUNT_FAILED';
  await waitForBodyText(cdp, session, 'Showing 20 of 20 loaded activity entries on this page.');
  assert.equal(await bodyIncludes(cdp, session, 'Showing 1–20 of 27'), true);
  state.scenarioVerdicts.defaultPageCount = 'PASS';
  const requestsAfterInitialRead = Number((await runtimeValue(cdp, session, 'window.__activityCountFixtureStats().successfulGets')));

  state.phase = 'SCENARIO_FILTER_INTERSECTION_FAILED';
  await selectValue(cdp, session, 'Activity filter', 'status_changes');
  await selectValue(cdp, session, 'Actor filter', 'agents');
  await waitForBodyText(cdp, session, 'Showing 8 of 20 loaded activity entries on this page.');
  assert.equal(await runtimeValue(cdp, session, 'window.__activityCountFixtureStats().successfulGets'), requestsAfterInitialRead);
  state.scenarioVerdicts.filterIntersection = 'PASS';

  state.phase = 'SCENARIO_FILTER_EMPTY_FAILED';
  await selectValue(cdp, session, 'Actor filter', 'humans');
  await waitForBodyText(cdp, session, 'Showing 0 of 20 loaded activity entries on this page.');
  assert.equal(await bodyIncludes(cdp, session, 'No matching activity on this page.'), true);
  assert.equal(await bodyIncludes(cdp, session, 'Showing 1–20 of 27'), true);
  state.scenarioVerdicts.filterEmpty = 'PASS';

  state.phase = 'SCENARIO_CLEAR_RECOVERY_FAILED';
  await selectValue(cdp, session, 'Activity filter', 'all');
  await selectValue(cdp, session, 'Actor filter', 'all');
  await waitForBodyText(cdp, session, 'Showing 20 of 20 loaded activity entries on this page.');
  assert.equal(await bodyIncludes(cdp, session, 'No matching activity on this page.'), false);
  assert.equal(await runtimeValue(cdp, session, 'window.__activityCountFixtureStats().successfulGets'), requestsAfterInitialRead);
  state.scenarioVerdicts.clearRecovery = 'PASS';

  state.phase = 'SCENARIO_PAGINATION_TOTALS_FAILED';
  await clickButton(cdp, session, 'Next activity page');
  await waitForBodyText(cdp, session, 'Showing 7 of 7 loaded activity entries on this page.');
  assert.equal(await bodyIncludes(cdp, session, 'Showing 21–27 of 27'), true);
  assert.equal(await bodyIncludes(cdp, session, 'Page 2 of 2'), true);
  assert.equal(await runtimeValue(cdp, session, 'document.querySelectorAll("ul li").length'), 7);
  await clickButton(cdp, session, 'Previous activity page');
  await waitForBodyText(cdp, session, 'Showing 20 of 20 loaded activity entries on this page.');
  assert.equal(await bodyIncludes(cdp, session, 'Showing 1–20 of 27'), true);
  state.scenarioVerdicts.paginationTotals = 'PASS';

  state.phase = 'SCENARIO_EXACT_UTC_FAILED';
  await clickExactUtcCheckbox(cdp, session);
  await waitForBodyText(cdp, session, '2026-10-24T01:02:03.456Z');
  state.scenarioVerdicts.exactUtc = 'PASS';

  state.phase = 'SCENARIO_TASK_CHANGE_RESET_FAILED';
  await selectValue(cdp, session, 'Activity filter', 'status_changes');
  await selectValue(cdp, session, 'Actor filter', 'agents');
  await clickButton(cdp, session, 'Next activity page');
  await waitForBodyText(cdp, session, 'Showing 3 of 7 loaded activity entries on this page.');
  await clickButton(cdp, session, 'Switch to empty task');
  await waitForBodyText(cdp, session, 'Page 1 of 1');
  assert.equal(await selectedValue(cdp, session, 'Activity filter'), 'all');
  assert.equal(await selectedValue(cdp, session, 'Actor filter'), 'all');
  assert.equal(await runtimeValue(cdp, session, 'document.querySelector("button[aria-label=\\"Previous activity page\\"]").disabled'), true);
  state.scenarioVerdicts.taskChangeReset = 'PASS';

  state.phase = 'SCENARIO_EMPTY_PAGE_FAILED';
  assert.equal(await checkEmptyState(cdp, session, 'Showing 0 of 0 loaded activity entries on this page.'), true);
  assert.equal(await bodyIncludes(cdp, session, 'Showing 0–0 of 0'), true);
  state.scenarioVerdicts.emptyPage = 'PASS';
  await clickButton(cdp, session, 'Switch to populated task');
  await waitForBodyText(cdp, session, 'Showing 20 of 20 loaded activity entries on this page.');
}

async function collectAdapterStats(state) {
  const stats = await runtimeValue(state.cdp, state.pageSessionId, 'window.__activityCountFixtureStats()');
  if (!isPlainRecord(stats) || !Array.isArray(stats.requests) ||
      !['getAttempts', 'successfulGets', 'rejectedCalls', 'mutationAttempts', 'requests'].every((key) => Object.hasOwn(stats, key)) ||
      ![stats.getAttempts, stats.successfulGets, stats.rejectedCalls, stats.mutationAttempts].every(validCounter)) {
    throw fail('ADAPTER_CONTRACT_FAILED');
  }
  const allowedTaskIds = new Set([
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ]);
  if (stats.requests.some((request) => !exactKeys(request, ['taskId', 'page']) ||
      !allowedTaskIds.has(request.taskId) || ![1, 2].includes(request.page))) {
    throw fail('ADAPTER_CONTRACT_FAILED');
  }
  if (stats.rejectedCalls !== 0 || stats.mutationAttempts !== 0 || stats.successfulGets !== stats.requests.length) {
    throw fail('ADAPTER_CONTRACT_FAILED');
  }
  state.counts.syntheticGetAttempts = stats.getAttempts;
  state.counts.syntheticGetSuccesses = stats.successfulGets;
  state.counts.rejectedAdapterCalls = stats.rejectedCalls;
  state.counts.mutationAttempts = stats.mutationAttempts;
}

async function cleanup(state) {
  if (state.cdp) state.cdp.close();
  if (state.browser) {
    state.browserShutdownRequested = state.browser.record.endedAtUtc === null;
    await state.browser.terminate();
  }
  if (state.server) {
    await Promise.race([
      state.server.close().catch(() => {}),
      delay(5_000),
    ]);
  }
}

function createInitialState() {
  return {
    phase: 'UNEXPECTED_FAILURE', outputReady: false, artifactRoot: null, privateRoot: null,
    repoRoot: null, appRoot: null, fixtureRoot: null, server: null, cdp: null,
    browser: null, pageSessionId: null, browserSha256: null, browserVersion: null,
    browserVersionOutcome: 'NOT_STARTED', versionCapture: null, candidateSha: null,
    runId: null, runAttempt: null, scenarioVerdicts: Object.fromEntries(SCENARIOS.map((key) => [key, 'NOT_MEASURED'])),
    counts: {
      localAssetRequests: 0, blockedNetworkRequests: 0, networkViolations: 0, websocketAttempts: 0,
      syntheticGetAttempts: 0, syntheticGetSuccesses: 0, rejectedAdapterCalls: 0, mutationAttempts: 0,
    },
    failureReason: null, cdpFailure: false, browserShutdownRequested: false,
  };
}

function createResult(state) {
  const allScenariosPassed = Object.values(state.scenarioVerdicts).every((value) => value === 'PASS');
  let reason = state.failureReason;
  if (!reason && state.cdpFailure) reason = 'CDP_COMMAND_FAILED';
  if (!reason && state.counts.networkViolations !== 0) reason = 'NETWORK_BOUNDARY_VIOLATION';
  const status = !reason && allScenariosPassed ? 'PASS' : 'FAIL';
  if (status === 'FAIL' && !reason) reason = 'UNEXPECTED_FAILURE';
  return {
    schema: RESULT_SCHEMA,
    status,
    reason: status === 'PASS' ? null : reason,
    candidateSha: state.candidateSha,
    runId: state.runId,
    runAttempt: state.runAttempt,
    componentSha256: EXPECTED_COMPONENT_SHA256,
    browserVersionOutcome: state.browserVersionOutcome,
    browserVersion: state.browserVersion,
    browserSha256: state.browserSha256,
    scenarioVerdicts: state.scenarioVerdicts,
    counts: state.counts,
  };
}

async function writeResult(state, result = createResult(state)) {
  if (!state.outputReady) return false;
  if (!validateResultRecord(result, {
    candidateSha: state.candidateSha, runId: state.runId, runAttempt: state.runAttempt,
  })) throw fail('RESULT_CAPTURE_FAILED');
  const outputEntries = await readdir(state.artifactRoot);
  if (outputEntries.length !== 0) throw fail('RESULT_CAPTURE_FAILED');
  await atomicPublishJson(state.artifactRoot, result);
  return result.status === 'PASS';
}

async function writeFailureSummary(state, result) {
  if (!state.outputReady || result.status !== 'FAIL') throw fail('RESULT_CAPTURE_FAILED');
  const binding = { runId: state.runId, runAttempt: state.runAttempt, candidateSha: state.candidateSha };
  const capture = state.browser
    ? await readCompletedBrowserCapture(
      state.privateRoot,
      await state.browser.completion,
      {
        expectedArgv: [EXPECTED_BROWSER_PATH, ...browserArguments(path.join(state.privateRoot, 'browser-profile'))],
        expectedCwd: state.privateRoot,
      },
    )
    : noBrowserCapture();
  capture.process.cleanupRequested = state.browserShutdownRequested;
  const summary = buildFailureSummary({
    binding,
    phase: state.phase,
    reason: result.reason,
    process: capture.process,
    diagnostics: capture.diagnostics,
    allowedReasons: FAILURE_REASONS,
  });
  return publishFailureSummary(state.artifactRoot, summary, {
    binding, allowedReasons: FAILURE_REASONS, expectedResult: result,
  });
}

async function runFixture() {
  const state = createInitialState();
  try {
    state.phase = 'OUTPUT_PREPARATION_FAILED';
    await prepareOutput(state);
    state.phase = 'CANDIDATE_HEAD_UNAVAILABLE';
    await verifyCandidateSource(state);
    state.phase = 'BROWSER_VERSION_FAILED';
    await verifyBrowser(state);
    state.phase = 'TOOL_MODULE_LOAD_FAILED';
    await createViteServer(state);
    state.phase = 'SERVER_LISTEN_FAILED';
    await state.server.listen();
    const address = state.server.httpServer.address();
    if (!address || typeof address !== 'object' || !Number.isInteger(address.port) || address.port < 1) {
      throw fail('SERVER_ADDRESS_UNAVAILABLE');
    }
    state.phase = 'BROWSER_SPAWN_FAILED';
    state.browser = await launchBrowserAfterVerification(state, () => {
      return spawnCaptured(EXPECTED_BROWSER_PATH, browserArguments(path.join(state.privateRoot, 'browser-profile')), {
        cwd: state.privateRoot,
        env: privateEnvironment(state.privateRoot),
        label: 'browser',
        privateRoot: state.privateRoot,
        timeoutMs: FIXTURE_TIMEOUT_MS,
      });
    });
    if (state.browser.record.pid === null) throw fail('BROWSER_SPAWN_FAILED');
    state.phase = 'CDP_ENDPOINT_UNAVAILABLE';
    await attachPage(state, state.browser);
    await runScenarios(state);
    state.phase = 'ADAPTER_CONTRACT_FAILED';
    await collectAdapterStats(state);
  } catch (error) {
    state.failureReason = FAILURE_REASONS.has(error?.failureReason)
      ? error.failureReason
      : (FAILURE_REASONS.has(state.phase) ? state.phase : 'UNEXPECTED_FAILURE');
  } finally {
    await cleanup(state);
  }
  if (state.browser) {
    const browserRecord = await state.browser.completion;
    if (browserRecord.captureFailed && !state.failureReason) state.failureReason = 'RESULT_CAPTURE_FAILED';
    if (browserRecord.timedOut && !state.failureReason) state.failureReason = 'FIXTURE_TIMEOUT';
    if (browserRecord.exitCode !== 0 && !state.browserShutdownRequested && !state.failureReason) {
      state.failureReason = 'BROWSER_PROCESS_EXITED';
    }
  }
  try {
    const result = createResult(state);
    const passed = await writeResult(state, result);
    if (!passed && state.outputReady) {
      try {
        await writeFailureSummary(state, result);
      } catch {
        process.stderr.write('activity visible count browser fixture: FAILURE_SUMMARY_CAPTURE_FAILED\n');
        process.exitCode = 1;
      }
    }
    process.stdout.write(passed
      ? 'activity visible count browser fixture: PASS\n'
      : `activity visible count browser fixture: ${state.failureReason ?? 'FAIL'}\n`);
    if (passed) process.exitCode = 0;
    else process.exitCode = 1;
  } catch {
    process.stderr.write('activity visible count browser fixture: RESULT_CAPTURE_FAILED\n');
    process.exitCode = 1;
  }
}

async function validateOutput() {
  const runId = process.env.GITHUB_RUN_ID;
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  const candidateSha = process.env.ACTIVITY_COUNT_CANDIDATE_SHA;
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!/^[0-9]+$/.test(runId ?? '') || !/^[1-9][0-9]*$/.test(String(process.env.GITHUB_RUN_ATTEMPT ?? '')) ||
      !/^[a-f0-9]{40}$/.test(candidateSha ?? '') || !path.isAbsolute(runnerTemp ?? '')) {
    throw fail('RUN_BINDING_INVALID');
  }
  const expected = expectedRoots(path.resolve(runnerTemp), runId, runAttempt, candidateSha).artifact;
  if (process.env.ACTIVITY_COUNT_OUTPUT_ROOT !== expected) throw fail('RUN_BINDING_INVALID');
  const canonical = await realpath(expected);
  const dirStat = await lstat(canonical);
  if (canonical !== expected || !dirStat.isDirectory() || dirStat.isSymbolicLink() || (dirStat.mode & 0o077) !== 0) {
    throw fail('OUTPUT_PREPARATION_FAILED');
  }
  const entries = (await readdir(canonical)).sort();
  if (!entries.includes('result.json') || entries.some((entry) => !['result.json', 'failure-summary.json'].includes(entry)) ||
      entries.length > 2) throw fail('RESULT_CAPTURE_FAILED');
  const resultPath = path.join(canonical, 'result.json');
  const fileStat = await lstat(resultPath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > RESULT_LIMIT_BYTES || (fileStat.mode & 0o077) !== 0) {
    throw fail('RESULT_CAPTURE_FAILED');
  }
  let value;
  try { value = JSON.parse(await readFile(resultPath, 'utf8')); } catch { throw fail('RESULT_CAPTURE_FAILED'); }
  if (!validateResultRecord(value, { candidateSha, runId, runAttempt })) throw fail('RESULT_CAPTURE_FAILED');
  if ((value.status === 'PASS' && entries.length !== 1) ||
      (entries.includes('failure-summary.json') && value.status !== 'FAIL')) throw fail('RESULT_CAPTURE_FAILED');
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `failure_summary_required=${value.status === 'FAIL'}\n`, { flag: 'a', mode: 0o600 });
  }
  process.stdout.write('activity visible count result: VALID\n');
}

async function validateFailureSummaryOutput() {
  const runId = process.env.GITHUB_RUN_ID;
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  const candidateSha = process.env.ACTIVITY_COUNT_CANDIDATE_SHA;
  const runnerTemp = process.env.RUNNER_TEMP;
  const workspace = process.env.GITHUB_WORKSPACE;
  if (!/^[0-9]+$/.test(runId ?? '') || !/^[1-9][0-9]*$/.test(String(process.env.GITHUB_RUN_ATTEMPT ?? '')) ||
      !/^[a-f0-9]{40}$/.test(candidateSha ?? '') || !path.isAbsolute(runnerTemp ?? '') || !path.isAbsolute(workspace ?? '')) {
    throw fail('RUN_BINDING_INVALID');
  }
  const expectedRoot = expectedRoots(path.resolve(runnerTemp), runId, runAttempt, candidateSha).artifact;
  if (process.env.ACTIVITY_COUNT_OUTPUT_ROOT !== expectedRoot) throw fail('RUN_BINDING_INVALID');
  const workspaceReal = await realpath(workspace).catch(() => { throw fail('WORKSPACE_UNAVAILABLE'); });
  if (workspaceReal !== path.resolve(workspace)) throw fail('WORKSPACE_UNAVAILABLE');
  const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: workspaceReal, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (currentHead !== candidateSha) throw fail('CANDIDATE_HEAD_MISMATCH');
  const componentBytes = await readFile(path.join(workspaceReal, 'apps/web/components/task/AuditLog.tsx'))
    .catch(() => { throw fail('COMPONENT_SOURCE_UNAVAILABLE'); });
  if (createHash('sha256').update(componentBytes).digest('hex') !== EXPECTED_COMPONENT_SHA256) {
    throw fail('COMPONENT_HASH_MISMATCH');
  }
  const resultPath = path.join(expectedRoot, 'result.json');
  const resultInfo = await lstat(resultPath);
  if (!resultInfo.isFile() || resultInfo.isSymbolicLink() || resultInfo.size > RESULT_LIMIT_BYTES ||
      (resultInfo.mode & 0o077) !== 0) throw fail('RESULT_CAPTURE_FAILED');
  let result;
  try { result = JSON.parse(await readFile(resultPath, 'utf8')); } catch { throw fail('RESULT_CAPTURE_FAILED'); }
  const binding = { candidateSha, runId, runAttempt };
  if (!validateResultRecord(result, binding) || result.status !== 'FAIL') throw fail('RESULT_CAPTURE_FAILED');
  await validateFailureSummaryFiles({
    artifactRoot: expectedRoot,
    binding,
    allowedReasons: FAILURE_REASONS,
    expectedResult: result,
  });
  process.stdout.write('activity visible count failure summary: VALID\n');
}

async function main() {
  if (process.argv[2] === '--validate-output') {
    await validateOutput().catch(() => {
      process.stderr.write('activity visible count result: INVALID\n');
      process.exitCode = 1;
    });
    return;
  }
  if (process.argv[2] === '--validate-failure-summary') {
    await validateFailureSummaryOutput().catch(() => {
      process.stderr.write('activity visible count failure summary: INVALID\n');
      process.exitCode = 1;
    });
    return;
  }
  await runFixture();
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write('activity visible count browser fixture: UNEXPECTED_FAILURE\n');
    process.exitCode = 1;
  });
}

export const __test = Object.freeze({
  EXPECTED_BROWSER_PATH,
  EXPECTED_BROWSER_VERSION,
  EXPECTED_BROWSER_SHA256,
  EXPECTED_COMPONENT_SHA256,
  RESULT_SCHEMA,
  FAILURE_REASONS: Object.freeze([...FAILURE_REASONS]),
  SCENARIOS,
  atomicPublishJson,
  browserArguments,
  isAllowedFixtureRequest,
  browserBinaryIsAccepted,
  verifyBrowser,
  launchBrowserAfterVerification,
  spawnCaptured,
  validateResultRecord,
  validateFailureSummaryOutput,
});
