// A2-255 drift guard. Two claims about the deployment live outside TypeScript, and both are load
// bearing in a way a type-check cannot see:
//
//   1. The code binds loopback by default; the IMAGE is what sets HOST=0.0.0.0. Delete that ENV and
//      the container binds its own loopback: the in-container healthcheck
//      (`wget http://localhost:3500/health`) still passes, while nothing outside the container can
//      reach the API through the published port. Healthy and serving nobody — a false green, which
//      is worse than a red.
//   2. /health can only name its commit if the build receives it. Delete the build arg from
//      docker-compose.prod.yml, or the ARG/ENV pair from the Dockerfile, and /health silently falls
//      back to `sha: null` — the endpoint keeps answering, and stops identifying anything.
//
// So the pairing is asserted against the files themselves, the same way A2-220 pinned Argana's image
// inputs to its Dockerfile COPY lines. A test that reads the deployment descriptors is the only
// verifier these two edges have.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as url from 'node:url';

const thisDir = dirname(url.fileURLToPath(import.meta.url));
const repoRoot = join(thisDir, '..', '..', '..');

const dockerfile = readFileSync(join(repoRoot, 'apps', 'api', 'Dockerfile'), 'utf8');
const compose = readFileSync(join(repoRoot, 'docker-compose.prod.yml'), 'utf8');

/** The Dockerfile's production stage — the ENVs of the builder stage never reach a container. */
const productionStage = (() => {
  const marker = dockerfile.indexOf('FROM node:24.21.0-alpine AS production');
  expect(marker).toBeGreaterThan(-1);
  return dockerfile.slice(marker);
})();

describe('the image serves on every interface, and the code does not', () => {
  it('sets HOST=0.0.0.0 in the production stage', () => {
    expect(productionStage).toMatch(/^ENV HOST=0\.0\.0\.0$/m);
  });

  it('calls listen with a host — a one-argument listen() is the defect this removed', () => {
    // Comments are stripped before matching: main.ts QUOTES the old one-argument call while
    // explaining why it is gone, and a guard that reads prose as code fails on its own explanation.
    const main = readFileSync(join(repoRoot, 'apps', 'api', 'src', 'main.ts'), 'utf8');
    const code = main
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/app\.listen\(\s*port\s*\)/);
    expect(code).toMatch(/app\.listen\(port,\s*host\)/);
  });
});

describe('the build receives the commit it is built from', () => {
  it('declares the ARG and promotes it to ENV in the production stage', () => {
    expect(productionStage).toMatch(/^ARG MUNERAL_BUILD_SHA=$/m);
    expect(productionStage).toMatch(/^ENV MUNERAL_BUILD_SHA=\$MUNERAL_BUILD_SHA$/m);
  });

  it('is fed from the deploy broker BUILD_SHA by docker-compose.prod.yml', () => {
    // `${BUILD_SHA:-}` and not `${BUILD_SHA}`: compose would warn and substitute empty anyway, and
    // the empty case is a designed outcome here (build.sha: null with a reason), not an accident.
    expect(compose).toMatch(/MUNERAL_BUILD_SHA:\s*\$\{BUILD_SHA:-\}/);
    const args = compose.indexOf('args:');
    const buildBlock = compose.indexOf('build:');
    expect(buildBlock).toBeGreaterThan(-1);
    expect(args).toBeGreaterThan(buildBlock);
  });

  it('keeps the published port on loopback, so the wildcard bind inside is not an exposure', () => {
    expect(compose).toMatch(/"127\.0\.0\.1:3500:3500"/);
  });
});
