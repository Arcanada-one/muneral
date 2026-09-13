import * as fs from 'node:fs';
import * as path from 'node:path';
import { compileAssembly } from '../../src/assembly/index.js';
import type { AssemblyRequestV0 } from '../../src/assembly/index.js';
import * as url from 'node:url';
// ESM has no injected globals, so `jest` must be imported for the RUNTIME.
// Its type, though, comes from @types/jest (already in tsconfig `types`),
// which is what the 339 existing jest.fn() call sites are written against —
// @jest/globals ships a stricter generic whose bare jest.fn() infers `never`
// and would red 416 lines that are not otherwise wrong. Value from one,
// type from the other.
import { jest as _jestRuntime } from '@jest/globals';
const jest = _jestRuntime as unknown as typeof globalThis.jest;
import { createRequire } from 'node:module';

// ESM has no `require`; these call sites load lazily inside test bodies
// (mostly behind a postgres-availability check), so the bridge is kept
// rather than hoisting them to static imports that would always execute.
const nodeRequire = createRequire(import.meta.url);

// ESM has no __dirname, and declaring that NAME would mark the module CommonJS.
const thisDir = path.dirname(url.fileURLToPath(import.meta.url));

/* eslint-disable @typescript-eslint/no-explicit-any */

const fixture = JSON.parse(
  fs.readFileSync(path.join(thisDir, 'fixtures', 'positive', 'minimal-request.json'), 'utf8'),
) as { input: AssemblyRequestV0 };

function installRuntimeSentinels() {
  const nodeFs = nodeRequire('node:fs');
  const http = nodeRequire('node:http');
  const childProcess = nodeRequire('node:child_process');
  const crypto = nodeRequire('node:crypto');
  const sentinels = [
    jest.spyOn(nodeFs, 'readFileSync').mockImplementation(() => Buffer.from('sentinel')),
    jest.spyOn(http, 'request').mockImplementation(() => ({ end: jest.fn() })),
    jest.spyOn(childProcess, 'spawn').mockImplementation(() => ({ on: jest.fn() })),
    jest.spyOn(crypto, 'randomBytes').mockImplementation(() => Buffer.alloc(1)),
    jest.spyOn(globalThis, 'setTimeout').mockImplementation((() => 1) as any),
    jest.spyOn(globalThis, 'setInterval').mockImplementation((() => 1) as any),
    jest.spyOn(Date, 'now').mockImplementation(() => 0),
    jest.spyOn(process, 'chdir').mockImplementation(() => undefined),
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response()),
  ];
  return sentinels;
}

describe('compiler runtime purity sentinels', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['success', () => fixture.input],
    ['refusal', () => ({ ...fixture.input, attemptBudget: 0 } as AssemblyRequestV0)],
  ])('touches no filesystem, network, subprocess, timer, randomness, process, clock, or invocation surface on %s', (_label, input) => {
    const sentinels = installRuntimeSentinels();
    for (const sentinel of sentinels) {
      sentinel.mockImplementation(() => undefined as never);
      (sentinel as unknown as (...args: unknown[]) => unknown)();
      expect(sentinel).toHaveBeenCalledTimes(1); // detector negative control
      sentinel.mockClear();
    }

    const originalEnvDescriptor = Object.getOwnPropertyDescriptor(process, 'env');
    const originalEnv = process.env;
    let envReads = 0;
    Object.defineProperty(process, 'env', {
      configurable: true,
      get() { envReads++; return originalEnv; },
      set(value) { Object.assign(originalEnv, value); },
    });
    try {
      void process.env; // detector negative control
      expect(envReads).toBe(1);
      envReads = 0;
      compileAssembly(input());
      expect(envReads).toBe(0);
      for (const sentinel of sentinels) expect(sentinel).not.toHaveBeenCalled();
    } finally {
      if (originalEnvDescriptor) Object.defineProperty(process, 'env', originalEnvDescriptor);
    }
  });
});

function prohibitedDependencyHits(source: string): string[] {
  const rules = [
    /node:fs|from ['"]fs['"]/, /node:http|node:https|node:net/, /node:child_process/,
    /@prisma|PrismaClient|\.query\s*\(/, /process\.env/, /\.invoke\s*\(/,
    /setTimeout\s*\(|setInterval\s*\(/, /randomBytes\s*\(|randomUUID\s*\(/,
  ];
  return rules.filter((rule) => rule.test(source)).map(String);
}

describe('database, configuration, and invocation dependency detector', () => {
  it('finds each forbidden negative control', () => {
    for (const snippet of [
      "import 'node:fs'", "import '@prisma/client'", 'process.env.SECRET',
      'database.query(value)', 'provider.invoke(value)', 'setTimeout(work, 1)',
      'randomUUID()',
    ]) {
      expect(prohibitedDependencyHits(snippet)).not.toEqual([]);
    }
  });

  it('finds no forbidden dependency in the shipped compiler graph', () => {
    for (const file of [
      'assembly.compiler.ts', 'assembly.validator.ts', 'assembly.canonical.ts',
      'assembly.errors.ts', 'assembly.types.ts', 'credential-policy-v0.generated.ts',
    ]) {
      const source = fs.readFileSync(path.join(thisDir, '..', '..', 'src', 'assembly', file), 'utf8');
      expect(prohibitedDependencyHits(source)).toEqual([]);
    }
  });
});
