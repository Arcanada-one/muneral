// @vitest-environment node
// The headers the running server sends. Header rules in next.config.ts replace what a route
// handler sets, so a test of the handler alone cannot see them. This starts the built application
// (`next start`); CI builds before it runs this suite. Without a build the tests are skipped, except
// in CI, where a missing build is a failure.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const WEB = resolve(__dirname, '..');
const built = existsSync(resolve(WEB, '.next', 'BUILD_ID'));
const required = process.env.CI === 'true';

const freePort = () =>
  new Promise<number>((done, fail) => {
    const probe = createServer().on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });

describe.skipIf(!built && !required)('headers sent by the running server', () => {
  let server: ChildProcess;
  let origin: string;
  let output = '';

  beforeAll(async () => {
    expect(built, 'build the web application before this suite').toBe(true);
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    // Sign-in is off: the logout route then needs no Auth server. Only these variables are passed.
    server = spawn(resolve(WEB, 'node_modules/.bin/next'), ['start', '-H', '127.0.0.1', '-p', String(port)], {
      cwd: WEB,
      env: {
        PATH: process.env.PATH, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
        NEXTAUTH_SECRET: 'synthetic-cookie-secret-for-this-test-only', AUTH_TRUST_HOST: 'true',
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout!.on('data', (chunk) => { output += String(chunk); });
    server.stderr!.on('data', (chunk) => { output += String(chunk); });
    const deadline = Date.now() + 45_000;
    for (;;) {
      if (server.exitCode !== null) throw new Error(`next start exited:\n${output}`);
      if (await fetch(`${origin}/login`).then(() => true, () => false)) return;
      if (Date.now() > deadline) throw new Error(`next start did not answer:\n${output}`);
      await new Promise((wake) => setTimeout(wake, 250));
    }
  }, 60_000);

  afterAll(() => {
    // The whole process group, so that no server is left behind.
    if (server?.pid && server.exitCode === null) process.kill(-server.pid, 'SIGTERM');
  });

  it('sends the logout redirect with no referrer at all', async () => {
    const response = await fetch(`${origin}/api/logout`, { method: 'POST', headers: { origin }, redirect: 'manual' });
    expect(response.status, output).toBe(303);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toContain('no-store');
    // The other protective headers still apply to it.
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('keeps the general referrer policy on pages', async () => {
    const response = await fetch(`${origin}/login`);
    expect(response.status).toBe(200);
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });
});
