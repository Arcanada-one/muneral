import { Controller, Get } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { buildInfo, type BuildInfo } from './build-info.js';

export interface ServedRoute {
  method: string;
  path: string;
}

/**
 * The routes the running process serves, read from the HTTP router itself (A2-330).
 *
 * The post-deploy canary (scripts/canary/canary_probe.py) needs to know whether a route is present
 * in the RESIDENT version. A status code cannot say it: 401 comes from a guard, 404 may be a handler
 * saying "no such task" or the router saying "no such route", and 405 means the path matched but
 * the verb did not. The router's own table can: it is what Express consults for every request, so
 * a route removed from a controller, or a verb rewritten on one, is absent from it.
 *
 * Read on every request, not cached at boot: the answer is about this process now. It names paths
 * and verbs only — the same information the public repository carries — and no handler, guard or
 * parameter value.
 */
export function servedRoutes(instance: unknown): ServedRoute[] | null {
  // Express 5 exposes the application router as `app.router`; Express 4 as `app._router`.
  const app = instance as { router?: unknown; _router?: unknown };
  const router = (app.router ?? app._router) as { stack?: unknown } | undefined;
  if (!router || !Array.isArray(router.stack)) return null;
  const out: ServedRoute[] = [];
  for (const layer of router.stack as Array<{ route?: { path?: unknown; methods?: unknown } }>) {
    const route = layer?.route;
    if (!route || typeof route.path !== 'string' || !route.methods || typeof route.methods !== 'object') {
      continue;
    }
    for (const [method, on] of Object.entries(route.methods as Record<string, unknown>)) {
      if (on === true && method !== '_all') out.push({ method: method.toUpperCase(), path: route.path });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

@Controller('health/routes')
export class RouteTableController {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  @Get()
  routes(): { schema: string; routes: ServedRoute[] | null; build: BuildInfo } {
    const instance: unknown = this.adapterHost.httpAdapter?.getInstance();
    return { schema: 'MuneralRouteTable/v1', routes: servedRoutes(instance), build: buildInfo() };
  }
}
