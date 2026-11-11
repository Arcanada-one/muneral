// MUN-0084 drift guard (PR-A, profile-gated). app.muneral.com is proxied by nginx to 127.0.0.1:3501;
// for weeks nothing listened there and the edge answered 502 while every API check stayed green.
// The claims below live outside TypeScript and a type-check cannot see them, so they are asserted
// against the files:
//   1. the compose stack defines muneral-web and publishes it on loopback 3501 ONLY;
//   2. muneral-web sits under the `web` profile, so the broker's default build/up (no service
//      argument, no --profile) neither builds nor starts it - merging changes nothing on production;
//   3. muneral-api (the fleet task system) is untouched by the web bring-up;
//   4. muneral-web has no env_file (the API .env holds database and signing secrets);
//   5. the web image build receives the public API origin and starts next on 3501 as non-root.
// There is deliberately NO assertion about a CI probe step: PR-A does not change any workflow.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as url from 'node:url';

const repoRoot = join(dirname(url.fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(repoRoot, ...p), 'utf8');

const compose = read('docker-compose.prod.yml');
const dockerfile = read('apps', 'web', 'Dockerfile');

/** One service block: from its key to the next two-space-indented key or comment line. */
const serviceBlock = (name: string): string => {
  const start = compose.indexOf(`\n  ${name}:`);
  expect(start).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}(#|[a-z])/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};

const webService = serviceBlock('muneral-web');
const apiService = serviceBlock('muneral-api');

/** Service keys declared under `services:` (two-space indented, uncommented). */
const declaredServices = [...compose.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map((m) => m[1]);

describe('muneral-web deploy descriptors (MUN-0084 PR-A)', () => {
  it('publishes the web on loopback 3501 only', () => {
    expect(webService).toMatch(/"127\.0\.0\.1:3501:3501"/);
    expect(webService).not.toMatch(/"(0\.0\.0\.0:)?3501:3501"/);
  });

  it('is under the web profile, so default build/up neither builds nor starts it', () => {
    expect(webService).toMatch(/^ {4}profiles:\s*\[\s*web\s*\]\s*$/m);
    // Without a profile the service would join the default set; muneral-api is the only one that does.
    const unprofiled = declaredServices.filter((s) => !/^ {4}profiles:/m.test(serviceBlock(s)));
    expect(unprofiled).toEqual(['muneral-api']);
  });

  it('leaves muneral-api unchanged: no profile, same build, port, env_file and healthcheck', () => {
    expect(apiService).not.toMatch(/profiles:/);
    expect(apiService).toMatch(/image:\s*muneral-api:latest/);
    expect(apiService).toMatch(/dockerfile:\s*apps\/api\/Dockerfile/);
    expect(apiService).toMatch(/MUNERAL_BUILD_SHA:\s*\$\{BUILD_SHA:-\}/);
    expect(apiService).toMatch(/"127\.0\.0\.1:3500:3500"/);
    expect(apiService).toMatch(/env_file:\s*\.env/);
    expect(apiService).toMatch(/restart:\s*unless-stopped/);
    expect(apiService).toMatch(/healthcheck:[\s\S]*http:\/\/127\.0\.0\.1:3500\/health/);
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
});
