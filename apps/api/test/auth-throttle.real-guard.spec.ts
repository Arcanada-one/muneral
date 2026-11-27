/**
 * The auth routes must enforce their own limit (5 requests per minute) through the real
 * ThrottlerGuard and the ThrottlerModule configuration of AppModule. Jest maps
 * @nestjs/throttler to a test double, so the sources are compiled with tsc and exercised
 * by a plain node process (test/support/auth-throttle-probe.mjs).
 */
import { afterAll, describe, expect, it } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// jest runs with apps/api as its root directory (see the jest block in package.json)
const apiRoot = process.cwd();
// inside apps/api so the compiled files resolve node_modules and the ESM package type
const outDir = mkdtempSync(path.join(apiRoot, '.throttle-probe-'));

describe('auth throttling with the real ThrottlerGuard', () => {
  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  it('limits an auth route to 5 requests per minute and leaves other routes on the global limit', () => {
    const tsc = createRequire(path.join(apiRoot, 'package.json')).resolve('typescript/bin/tsc');
    execFileSync(
      process.execPath,
      [tsc, '-p', 'tsconfig.json', '--outDir', outDir, '--incremental', 'false',
        '--declaration', 'false', '--sourceMap', 'false'],
      { cwd: apiRoot, stdio: 'pipe' },
    );

    const output = execFileSync(
      process.execPath,
      [path.join(apiRoot, 'test/support/auth-throttle-probe.mjs'), outDir],
      { cwd: apiRoot, encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_OPTIONS: '' } },
    );
    const observed = JSON.parse(output.trim().split('\n').pop() as string);

    expect(observed.auth).toEqual([200, 200, 200, 200, 200, 429, 429]);
    expect(observed.control).toEqual(Array(10).fill(200));
  }, 180_000);
});
