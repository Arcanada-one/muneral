/** Every route that accepts a signed-in user is guarded and listed in the access table. */
import { readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { HUMAN_ROUTE_ACCESS } from '../src/auth/guards/human-route-access.js';
import { HumanTaskReadGuard } from '../src/auth/guards/human-task-read.guard.js';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard.js';
import { JwtOrApiKeyGuard } from '../src/auth/guards/jwt-or-api-key.guard.js';

const source = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '../src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? files(full) : full.endsWith('.controller.ts') ? [full] : [];
});

interface Route { name: string; guards: unknown[]; verb: string; route: string }

async function routes(): Promise<Route[]> {
  const found: Route[] = [];
  for (const file of files(source)) {
    const exported = await import(file) as Record<string, unknown>;
    for (const value of Object.values(exported)) {
      if (typeof value !== 'function' || Reflect.getMetadata(PATH_METADATA, value) === undefined) continue;
      for (const key of Object.getOwnPropertyNames(value.prototype)) {
        const handler = value.prototype[key] as object;
        if (key === 'constructor' || Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
        found.push({
          name: `${value.name}.${key}`,
          verb: RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number],
          route: `${Reflect.getMetadata(PATH_METADATA, value)}/${Reflect.getMetadata(PATH_METADATA, handler)}`,
          guards: [...(Reflect.getMetadata(GUARDS_METADATA, value) ?? []), ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? [])],
        });
      }
    }
  }
  return found;
}

describe('human route access table', () => {
  let human: Route[];
  beforeAll(async () => {
    human = (await routes()).filter((r) => r.guards.includes(JwtAuthGuard) || r.guards.includes(JwtOrApiKeyGuard));
  });

  it('lists exactly the routes that accept a signed-in user', () => {
    expect(human.map((r) => r.name).sort()).toEqual(Object.keys(HUMAN_ROUTE_ACCESS).sort());
  });

  it('every such route runs the workspace guard, after authentication', () => {
    const bad = human.filter((r) => {
      const at = r.guards.indexOf(HumanTaskReadGuard);
      const authenticated = Math.max(r.guards.indexOf(JwtAuthGuard), r.guards.indexOf(JwtOrApiKeyGuard));
      return at < 0 || at < authenticated;
    });
    expect(bad.map((r) => r.name)).toEqual([]);
  });

  it('declares a kind for every path parameter', () => {
    const missing = human.flatMap((r) => [...r.route.matchAll(/:(\w+)/g)]
      .filter(([, parameter]) => !HUMAN_ROUTE_ACCESS[r.name]?.params?.[parameter])
      .map(([, parameter]) => `${r.name}:${parameter}`));
    expect(missing).toEqual([]);
  });
});
