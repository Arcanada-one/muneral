// MUN-0084 drift guard. app.muneral.com is proxied by nginx to 127.0.0.1:3501; for weeks nothing
// listened there and the edge answered 502 while every API check stayed green. Four claims live
// outside TypeScript and a type-check cannot see them, so they are asserted against the files:
//   1. the compose stack defines muneral-web and publishes it on loopback 3501 ONLY;
//   2. muneral-web has no env_file (the API .env holds database and signing secrets);
//   3. the web image build receives the public API origin, and the production stage starts next on 3501;
//   4. the existing deploy job probes the web over HTTP, so a deploy that does not serve it fails.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as url from 'node:url';

const repoRoot = join(dirname(url.fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(repoRoot, ...p), 'utf8');

const compose = read('docker-compose.prod.yml');
const dockerfile = read('apps', 'web', 'Dockerfile');
const ci = read('.github', 'workflows', 'ci.yml');

/** The muneral-web service block: from its key to the next top-level service or comment line. */
const webService = (() => {
  const start = compose.indexOf('\n  muneral-web:');
  expect(start).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}(#|[a-z])/);
  return next === -1 ? rest : rest.slice(0, next + 1);
})();

describe('muneral-web deploy descriptors (MUN-0084)', () => {
  it('publishes the web on loopback 3501 only', () => {
    expect(webService).toMatch(/"127\.0\.0\.1:3501:3501"/);
    expect(webService).not.toMatch(/"(0\.0\.0\.0:)?3501:3501"/);
  });

  it('does not hand the API env_file (database / signing secrets) to the web container', () => {
    expect(webService).not.toMatch(/env_file/);
  });

  it('has a restart policy and an HTTP healthcheck on the served port', () => {
    expect(webService).toMatch(/restart:\s*unless-stopped/);
    expect(webService).toMatch(/healthcheck:[\s\S]*http:\/\/127\.0\.0\.1:3501\//);
  });

  it('builds from the web Dockerfile with the public API origin (client appends /api/v1 itself)', () => {
    expect(webService).toMatch(/dockerfile:\s*apps\/web\/Dockerfile/);
    expect(webService).toMatch(/NEXT_PUBLIC_API_URL:\s*https:\/\/api\.muneral\.com\s*$/m);
    expect(dockerfile).toMatch(/^ARG NEXT_PUBLIC_API_URL=https:\/\/api\.muneral\.com$/m);
  });

  it('pins the base image by digest and starts next on 3501 as a non-root user', () => {
    expect(dockerfile).toMatch(/FROM node:26\.13\.0-alpine@sha256:[0-9a-f]{64} AS production/);
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toMatch(/CMD \["node_modules\/\.bin\/next", "start", "-p", "3501"\]/);
  });

  it('is probed over HTTP by the existing deploy job, behind the preflight gate', () => {
    const start = ci.indexOf('- name: Wait for web healthy');
    expect(start).toBeGreaterThan(-1);
    const after = ci.slice(start);
    const end = after.slice(1).search(/\n {6}- name:/);
    const block = end === -1 ? after : after.slice(0, end + 1);
    expect(block).toContain("if: steps.preflight.outputs.status != 'fail'");
    expect(block).toContain('http://127.0.0.1:3501/login');
    expect(block).toMatch(/exit 1/);
  });
});
