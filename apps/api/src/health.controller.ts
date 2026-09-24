import { readFileSync } from 'node:fs';
import { Controller, Get } from '@nestjs/common';
import { buildInfo, type BuildInfo } from './build-info.js';

/**
 * The reported version is read from apps/api/package.json rather than repeated
 * as a literal here. A hand-maintained copy silently drifts: before MUN-0040
 * the constant still said 0.1.0 and /health was the only way to tell which
 * build was actually deployed, so a wrong constant is a wrong answer to the
 * one question this endpoint exists to answer.
 *
 * Path note: this file compiles to dist/health.controller.js and the Docker
 * production image keeps package.json as apps/api/package.json alongside
 * dist/, so '../package.json' resolves in both the repo and the image.
 */
function resolveVersion(): string {
  try {
    // ESM has no `require`. Reading the manifest from disk rather than importing
    // it keeps the compiled layout out of the type graph: an `import ... with
    // {type:'json'}` would resolve relative to dist/ and change what this reports.
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
  } catch {
    // Fall through to the sentinel below.
  }
  // Deliberately not a plausible-looking version: an unresolvable manifest must
  // be obvious in the response, not mistaken for a real build.
  return '0.0.0-unknown';
}

const VERSION = resolveVersion();

/**
 * Simple health check endpoint for Docker/load balancer probes.
 *
 * `version` answers "which release is this" and `build` answers "which commit is this". They are
 * two different questions and the first cannot stand in for the second: the manifest version has
 * been 0.4.6 since 6c9b48e, so it is the same string for every commit after it (A2-251 §5.5). See
 * build-info.ts for why `build.sha: null` is not_measured rather than a failure of the service.
 *
 * `status` deliberately stays 'ok' when the commit is unknown: an unidentifiable build is a gap in
 * what the deploy proved, not a sick service, and teaching one alarm to mean two things makes both
 * unreadable.
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: string; version: string; build: BuildInfo } {
    return { status: 'ok', version: VERSION, build: buildInfo() };
  }
}
