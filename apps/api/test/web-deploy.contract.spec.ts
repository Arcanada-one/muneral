// MUN-0084 drift guard (PR-B, activated). app.muneral.com is proxied by nginx to 127.0.0.1:3501;
// for weeks nothing listened there and the edge answered 502 while every API check stayed green.
// The claims below live outside TypeScript and a type-check cannot see them, so they are asserted
// against the files:
//   1. the compose stack defines muneral-web and publishes it on loopback 3501 ONLY;
//   2. no service sits under a profile, so the broker's default build/up (no service argument, no
//      --profile) builds and starts muneral-api AND muneral-web;
//   3. muneral-api (the fleet task system) is untouched by the web bring-up;
//   4. muneral-web has no env_file (the API .env holds database and signing secrets) and receives
//      exactly the listed names, none of them in a required-variable form that could block the API;
//   5. the web image build receives the public API origin and starts next on 3501 as non-root.
// There is deliberately NO assertion about a CI probe step: this change does not touch any workflow.

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

describe('muneral-web deploy descriptors (MUN-0084 PR-B)', () => {
  it('publishes the web on loopback 3501 only', () => {
    expect(webService).toMatch(/"127\.0\.0\.1:3501:3501"/);
    expect(webService).not.toMatch(/"(0\.0\.0\.0:)?3501:3501"/);
  });

  it('is in the default set, so the broker default build/up builds and starts it', () => {
    expect(webService).not.toMatch(/^ {4}profiles:/m);
    const unprofiled = declaredServices.filter((s) => !/^ {4}profiles:/m.test(serviceBlock(s)));
    expect(unprofiled).toEqual(['muneral-api', 'muneral-web']);
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

  it('receives exactly the listed environment names, each optional so the API is never blocked', () => {
    const block = webService.match(/^ {4}environment:\n((?: {6}\S.*\n)+)/m);
    expect(block).not.toBeNull();
    const entries = block![1].trimEnd().split('\n').map((l) => l.trim());
    expect(entries).toEqual([
      'NEXTAUTH_SECRET: ${NEXTAUTH_SECRET:-}',
      'GITHUB_CLIENT_ID: ${GITHUB_CLIENT_ID:-}',
      'GITHUB_CLIENT_SECRET: ${GITHUB_CLIENT_SECRET:-}',
      'AUTH_TRUST_HOST: "true"',
    ]);
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
    const baseImage = 'node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5';
    expect(dockerfile).toContain(`FROM ${baseImage} AS builder`);
    expect(dockerfile).toContain(`FROM ${baseImage} AS production`);
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toMatch(/CMD \["node_modules\/\.bin\/next", "start", "-p", "3501"\]/);
  });

  it('does not depend on the checkout umask: every production-stage COPY sets ownership to node', () => {
    const production = dockerfile.slice(dockerfile.indexOf('AS production'));
    const copies = production.split('\n').filter((l) => /^COPY\b/.test(l));
    expect(copies.length).toBeGreaterThan(0);
    for (const line of copies) {
      expect(line).toMatch(/--chown=node:node\b|--chmod=/);
    }
  });
});
