import { Controller, Get } from '@nestjs/common';

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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../package.json') as { version?: string };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
  } catch {
    // Fall through to the sentinel below.
  }
  // Deliberately not a plausible-looking version: an unresolvable manifest must
  // be obvious in the response, not mistaken for a real build.
  return '0.0.0-unknown';
}

const VERSION = resolveVersion();

/** Simple health check endpoint for Docker/load balancer probes. */
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: string; version: string } {
    return { status: 'ok', version: VERSION };
  }
}
