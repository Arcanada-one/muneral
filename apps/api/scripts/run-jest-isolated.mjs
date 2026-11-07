import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jestCli = path.join(apiRoot, 'node_modules/jest/bin/jest.js');
const separatorIndex = process.argv.indexOf('--', 2);
const requestedArgs = separatorIndex === -1
  ? process.argv.slice(2)
  : process.argv.slice(separatorIndex + 1);
const executionArgs = [];
let skipRequestedTestPaths = false;
for (const arg of requestedArgs) {
  if (arg === '--runTestsByPath') {
    skipRequestedTestPaths = true;
    continue;
  }
  if (arg.startsWith('--runTestsByPath=')) continue;
  if (skipRequestedTestPaths && !arg.startsWith('-')) continue;
  skipRequestedTestPaths = false;
  executionArgs.push(arg);
}

function run(args, { captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [jestCli, ...args], {
      cwd: apiRoot,
      stdio: captureStdout ? ['ignore', 'pipe', 'inherit'] : 'inherit',
      env: process.env,
    });
    let stdout = '';
    if (captureStdout) child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout }));
  });
}

const discovery = await run(['--listTests', '--runInBand', ...requestedArgs], { captureStdout: true });
if (discovery.code !== 0) process.exit(discovery.code ?? 1);

const testFiles = discovery.stdout.split(/\r?\n/).filter(Boolean);
let failed = false;

for (const testFile of testFiles) {
  const result = await run(['--runInBand', '--runTestsByPath', testFile, ...executionArgs]);
  if (result.code !== 0) failed = true;
  if (result.signal) failed = true;
}

if (failed) process.exitCode = 1;
