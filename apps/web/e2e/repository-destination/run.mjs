import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const expectedBrowserPath = '/opt/arcanada-browsers/cft-156.0.8078.4/chrome-linux64/chrome';
const expectedBrowserVersion = 'Google Chrome for Testing 156.0.8078.4';
const expectedComponentSha256 = 'a9e81561dd91c7624bd8df6a8a2bee62b4764b8b6ad7b9553fbe05b42eebbc02';
const baselineSourceCommit = '8a4ef29f34ccf57c01d7cbdf29eb1f9e40f75d2b';
const baselineSourceTree = '6f5975e24406b253e060c68bc50c9516318234f7';
const resultSchema = 'RepositoryDestinationBrowserFixture/v2';
const timeoutMs = 15000;
const maxVersionOutputBytes = 4096;
const firstUrl = 'https://GitHub.com:8443/Arcanada-one/muneral';
const secondUrl = 'https://Codeberg.org:9443/Arcanada-one/muneral/mirror';
const rejectedUrl = 'https://synthetic-user:synthetic-pass@rejected.example/private/path?token=synthetic';
const firstText = 'github.com:8443/Arcanada-one/muneral';
const secondText = 'codeberg.org:9443/Arcanada-one/muneral/mirror';

let outputDir;
let resultPath;
let outputReady = false;
let outputWritten = false;
let server;
let context;
let candidateSha;
let browserSha256;
let browserVersionResult;
let localRequests = 0;
let blockedRequests = 0;
let blockedDataRequests = 0;
let websocketCount = 0;

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

async function writeResult(value) {
  if (!outputReady) throw new Error('output unavailable');
  if (outputWritten) throw new Error('result already written');
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writeFile(resultPath, bytes, { flag: 'wx', mode: 0o600 });
  outputWritten = true;
}

async function prepareOutput() {
  const configuredRoot = process.env.REPOSITORY_DESTINATION_OUTPUT_ROOT;
  requireCondition(typeof configuredRoot === 'string' && path.isAbsolute(configuredRoot), 'OUTPUT_ROOT_INVALID');
  const canonicalRoot = await realpath(configuredRoot);
  requireCondition(canonicalRoot === path.resolve(configuredRoot), 'OUTPUT_ROOT_NOT_CANONICAL');
  outputDir = path.join(canonicalRoot, 'repository-destination-userpath-v1');
  resultPath = path.join(outputDir, 'result.json');
  try {
    await lstat(outputDir);
    fail('OUTPUT_PATH_NOT_FRESH');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(outputDir, { mode: 0o700 });
  const outputStat = await stat(outputDir);
  requireCondition((outputStat.mode & 0o077) === 0, 'OUTPUT_MODE_NOT_PRIVATE');
  outputReady = true;
  await mkdir(path.join(outputDir, 'home'), { mode: 0o700 });
  await mkdir(path.join(outputDir, 'tmp'), { mode: 0o700 });
}

function browserEnvironment() {
  const temp = path.join(outputDir, 'tmp');
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: path.join(outputDir, 'home'),
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
  };
}

function browserVersion(executable, cwd, env) {
  return new Promise(resolve => {
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let spawnFailed = false;
    let settled = false;
    let killTimer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(result);
    };
    const collectStdout = chunk => {
      const remaining = maxVersionOutputBytes - stdout.length;
      if (remaining <= 0) {
        stdoutTruncated = true;
        return;
      }
      const accepted = chunk.subarray(0, remaining);
      stdout = Buffer.concat([stdout, accepted], stdout.length + accepted.length);
      if (chunk.length > accepted.length) stdoutTruncated = true;
    };
    const collectStderr = chunk => {
      const remaining = maxVersionOutputBytes - stderrBytes;
      if (remaining <= 0) {
        stderrTruncated = true;
        return;
      }
      stderrBytes += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) stderrTruncated = true;
    };
    const child = spawn(executable, ['--version'], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, 5000);
    child.stdout.on('data', collectStdout);
    child.stderr.on('data', collectStderr);
    child.once('error', () => {
      spawnFailed = true;
      finish({ exitCode: null, signal: null, timedOut, spawnFailed,
        version: stdout.toString('utf8').trim(), stdoutTruncated, stderrTruncated });
    });
    child.once('close', (exitCode, signal) => finish({ exitCode, signal, timedOut, spawnFailed,
      version: stdout.toString('utf8').trim(), stdoutTruncated, stderrTruncated }));
  });
}

async function requireVisible(page, text) {
  const locator = page.getByText(text, { exact: true });
  await locator.waitFor({ state: 'visible', timeout: timeoutMs });
  return locator;
}

async function run() {
  await prepareOutput();

  const workspaceRoot = process.env.GITHUB_WORKSPACE;
  requireCondition(typeof workspaceRoot === 'string' && path.isAbsolute(workspaceRoot), 'WORKSPACE_ROOT_INVALID');
  const repoRoot = await realpath(workspaceRoot);
  requireCondition(repoRoot === path.resolve(workspaceRoot), 'WORKSPACE_ROOT_NOT_CANONICAL');
  const configuredCandidateSha = process.env.GITHUB_SHA;
  requireCondition(typeof configuredCandidateSha === 'string' && /^[a-f0-9]{40}$/.test(configuredCandidateSha),
    'CANDIDATE_SHA_INVALID');
  candidateSha = configuredCandidateSha;

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
  browserSha256 = await sha256File(browserPath);
  browserVersionResult = await browserVersion(browserPath, fixtureRoot, browserEnvironment());
  requireCondition(!browserVersionResult.spawnFailed && !browserVersionResult.timedOut
    && browserVersionResult.exitCode === 0 && !browserVersionResult.stdoutTruncated
    && browserVersionResult.version === expectedBrowserVersion, 'BROWSER_VERSION_UNSUPPORTED');

  const toolRequire = createRequire(toolAnchor);
  const viteModule = await import(pathToFileURL(toolRequire.resolve('vite')).href);
  const reactModule = await import(pathToFileURL(toolRequire.resolve('@vitejs/plugin-react')).href);
  const playwrightModule = await import(pathToFileURL(toolRequire.resolve('playwright-core')).href);
  const reactPlugin = reactModule.default;
  const { chromium } = playwrightModule;
  requireCondition(typeof viteModule.createServer === 'function'
    && typeof reactPlugin === 'function'
    && typeof chromium.launchPersistentContext === 'function', 'TOOL_API_UNSUPPORTED');

  server = await viteModule.createServer({
    configFile: false,
    root: fixtureRoot,
    envDir: fixtureRoot,
    envPrefix: [],
    cacheDir: path.join(outputDir, 'vite-cache'),
    appType: 'spa',
    plugins: [reactPlugin()],
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
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, open: false,
      fs: { strict: true, allow: [repoRoot, fixtureRoot] } },
  });
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const profileDir = path.join(outputDir, 'browser-profile');
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath: browserPath,
    env: browserEnvironment(),
    headless: true,
    chromiumSandbox: true,
    serviceWorkers: 'block',
    viewport: { width: 240, height: 640 },
  });
  const page = context.pages()[0];
  page.on('websocket', socket => { websocketCount += 1; socket.close(); });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const dataTransport = ['fetch', 'xhr', 'websocket', 'eventsource'].includes(request.resourceType());
    if (url.origin !== baseUrl || request.method() !== 'GET' || dataTransport) {
      blockedRequests += 1;
      if (dataTransport) blockedDataRequests += 1;
      await route.abort();
      return;
    }
    localRequests += 1;
    await route.continue();
  });
  await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: timeoutMs });

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
  assert.equal(blockedRequests, 0);
  assert.equal(blockedDataRequests, 0);
  assert.equal(websocketCount, 0);
  await writeResult({ schema: resultSchema, status: 'PASS', reason: null,
    scenarios: 5, candidateSha, baselineSourceCommit, baselineSourceTree,
    componentSha256: expectedComponentSha256,
    browserVersion: browserVersionResult.version, browserSha256,
    localGetRequests: localRequests, blockedRequests, blockedDataRequests, websocketCount });
}

try {
  await run();
  process.stdout.write('repository destination browser fixture: PASS\n');
} catch (error) {
  const reason = typeof error?.failureReason === 'string' ? error.failureReason : 'SCENARIO_OR_INPUT_CHECK_FAILED';
  try {
    await writeResult({ schema: resultSchema, status: 'FAIL', reason, scenarios: 5,
      candidateSha: candidateSha ?? null, baselineSourceCommit, baselineSourceTree,
      componentSha256: expectedComponentSha256,
      browserVersion: browserVersionResult?.version ?? null, browserSha256: browserSha256 ?? null,
      localGetRequests: localRequests, blockedRequests, blockedDataRequests, websocketCount });
  } catch {
    process.stderr.write('repository destination browser fixture: RESULT_CAPTURE_FAILED\n');
  }
  process.stderr.write(`repository destination browser fixture: ${reason}\n`);
  process.exitCode = 1;
} finally {
  if (context) await context.close().catch(() => {});
  if (server) await server.close().catch(() => {});
}
