// MUN-0040: /health is the only way to tell which build is live, so its
// version must be the package manifest's version, not a hand-copied literal
// that can silently lag a release behind.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HealthController } from '../src/health.controller';

const pkg = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
) as { version: string };

describe('HealthController', () => {
  it('reports the version from apps/api/package.json', () => {
    expect(new HealthController().check()).toEqual({ status: 'ok', version: pkg.version });
  });

  it('does not report the sentinel when the manifest resolves', () => {
    expect(new HealthController().check().version).not.toBe('0.0.0-unknown');
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
