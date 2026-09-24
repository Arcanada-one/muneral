// MUN-0040: /health is the only way to tell which build is live, so its
// version must be the package manifest's version, not a hand-copied literal
// that can silently lag a release behind.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HealthController } from '../src/health.controller.js';
import * as url from 'node:url';
import * as path from 'node:path';

// ESM has no __dirname, and declaring that NAME would mark the module CommonJS.
const thisDir = path.dirname(url.fileURLToPath(import.meta.url));

const pkg = JSON.parse(
  readFileSync(join(thisDir, '..', 'package.json'), 'utf8'),
) as { version: string };

describe('HealthController', () => {
  it('reports the version from apps/api/package.json', () => {
    expect(new HealthController().check().version).toBe(pkg.version);
  });

  it('does not report the sentinel when the manifest resolves', () => {
    expect(new HealthController().check().version).not.toBe('0.0.0-unknown');
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  // A2-255: the release and the commit are two answers, and the second is the one that identifies
  // a build. This manifest version has been 0.4.6 since 6c9b48e — the same for every commit after
  // it — so `version` alone cannot tell two deploys apart (A2-251 §5.5).
  it('carries a build object alongside the version', () => {
    const body = new HealthController().check();
    expect(Object.keys(body).sort()).toEqual(['build', 'status', 'version']);
    expect(body.build).toHaveProperty('sha');
    expect(body.build).toHaveProperty('source');
  });

  it('keeps status ok when the commit is unknown — a nameless build is not a sick service', () => {
    const before = process.env.MUNERAL_BUILD_SHA;
    delete process.env.MUNERAL_BUILD_SHA;
    try {
      const body = new HealthController().check();
      expect(body.status).toBe('ok');
      expect(body.build.sha).toBeNull();
      expect(body.build.problem).toBeDefined();
    } finally {
      if (before === undefined) delete process.env.MUNERAL_BUILD_SHA;
      else process.env.MUNERAL_BUILD_SHA = before;
    }
  });

  it('reports the commit the image was built from when it has one', () => {
    const before = process.env.MUNERAL_BUILD_SHA;
    process.env.MUNERAL_BUILD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    try {
      expect(new HealthController().check().build).toEqual({
        sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
        source: 'MUNERAL_BUILD_SHA',
      });
    } finally {
      if (before === undefined) delete process.env.MUNERAL_BUILD_SHA;
      else process.env.MUNERAL_BUILD_SHA = before;
    }
  });
});
