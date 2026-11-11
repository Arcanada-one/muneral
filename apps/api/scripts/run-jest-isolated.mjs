import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertEnoughTestFiles, mergeJestReports, parseListTests } from './jest-list-tests.mjs';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jestCli = path.join(apiRoot, 'node_modules/jest/bin/jest.js');
const separatorIndex = process.argv.indexOf('--', 2);
const rawArgs = separatorIndex === -1
  ? process.argv.slice(2)
  : process.argv.slice(separatorIndex + 1);

// Runner-only flag (not passed to jest): `--min-test-files N` makes the command line itself
// assert how many test files it discovered. Zero files is ALWAYS an error (min is at least 1).
let minTestFiles = 1;
const requestedArgs = [];
for (let i = 0; i < rawArgs.length; i += 1) {
  const arg = rawArgs[i];
  if (arg === '--min-test-files') {
    minTestFiles = Number(rawArgs[i + 1]);
    i += 1;
  } else if (arg.startsWith('--min-test-files=')) {
    minTestFiles = Number(arg.slice('--min-test-files='.length));
  } else {
    requestedArgs.push(arg);
  }
}
if (!Number.isInteger(minTestFiles) || minTestFiles < 1) {
  console.error('run-jest-isolated: --min-test-files must be an integer >= 1');
  process.exit(2);
}

// Split the requested args into discovery args and per-file execution args.
// --outputFile is handled here: each per-file run writes its own report and the runner merges
// them (a shared --outputFile would be overwritten by every file, leaving only the last one).
const executionArgs = [];
let skipRequestedTestPaths = false;
let outputFile = null;
for (let i = 0; i < requestedArgs.length; i += 1) {
  const arg = requestedArgs[i];
  if (arg === '--runTestsByPath') {
    skipRequestedTestPaths = true;
    continue;
  }
  if (arg.startsWith('--runTestsByPath=')) continue;
  if (skipRequestedTestPaths && !arg.startsWith('-')) continue;
  skipRequestedTestPaths = false;
  if (arg === '--outputFile') {
    outputFile = requestedArgs[i + 1];
    i += 1;
    continue;
  }
  if (arg.startsWith('--outputFile=')) {
    outputFile = arg.slice('--outputFile='.length);
    continue;
  }
  executionArgs.push(arg);
}
const wantsJson = executionArgs.includes('--json');
// Discovery sees every requested arg except --outputFile (it must not write the report).
const discoveryArgs = requestedArgs.filter((arg, i) => {
  if (arg === '--outputFile' || arg.startsWith('--outputFile=')) return false;
  return requestedArgs[i - 1] !== '--outputFile';
});

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

const discovery = await run(['--listTests', '--runInBand', ...discoveryArgs], { captureStdout: true });
if (discovery.code !== 0) process.exit(discovery.code ?? 1);

let testFiles;
try {
  testFiles = parseListTests(discovery.stdout);
  assertEnoughTestFiles(testFiles, minTestFiles);
} catch (error) {
  console.error(`run-jest-isolated: ${error.message}`);
  process.exit(1);
}
console.error(`run-jest-isolated: ${testFiles.length} test files discovered (minimum ${minTestFiles})`);

let failed = false;
const reportDir = outputFile && wantsJson ? mkdtempSync(path.join(tmpdir(), 'jest-isolated-')) : null;
const reports = [];

for (const [index, testFile] of testFiles.entries()) {
  const fileArgs = ['--runInBand', '--runTestsByPath', testFile, ...executionArgs];
  const reportPath = reportDir ? path.join(reportDir, `${index}.json`) : null;
  if (reportPath) fileArgs.push('--outputFile', reportPath);
  const result = await run(fileArgs);
  if (result.code !== 0) failed = true;
  if (result.signal) failed = true;
  if (reportPath) {
    if (existsSync(reportPath)) reports.push(JSON.parse(readFileSync(reportPath, 'utf8')));
    else failed = true; // jest crashed before writing its report
  }
}

if (outputFile && wantsJson) {
  const target = path.resolve(apiRoot, outputFile);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(mergeJestReports(reports))}\n`);
}

if (failed) process.exitCode = 1;
