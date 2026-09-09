// MUN-0040: the HTTP surface must keep writes agent-authenticated and must
// derive the acting principal from the API key alone — an importer that could
// name its own actor would make the activity log worthless as provenance.

import { GUARDS_METADATA, PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { BadRequestException, RequestMethod } from '@nestjs/common';
import { ApiKeyGuard } from '../src/auth/guards/api-key.guard';
import { JwtOrApiKeyGuard } from '../src/auth/guards/jwt-or-api-key.guard';
import { MigrationController } from '../src/migration/migration.controller';

type Handler = (...args: never[]) => unknown;

function guardsOn(method: keyof MigrationController): unknown[] {
  return (
    (Reflect.getMetadata(
      GUARDS_METADATA,
      MigrationController.prototype[method] as Handler,
    ) as unknown[]) ?? []
  );
}

function routeOf(method: keyof MigrationController): { path: string; verb: number } {
  const handler = MigrationController.prototype[method] as Handler;
  return {
    path: Reflect.getMetadata(PATH_METADATA, handler) as string,
    verb: Reflect.getMetadata(METHOD_METADATA, handler) as number,
  };
}

describe('MigrationController', () => {
  const service = {
    createBatch: jest.fn(),
    getBatch: jest.fn(),
    commitBatch: jest.fn(),
    createWorkItem: jest.fn(),
    getWorkItemByLegacy: jest.fn(),
    searchByLegacyId: jest.fn(),
    transition: jest.fn(),
    decide: jest.fn(),
    getReverseMapping: jest.fn(),
  };
  const controller = new MigrationController(service as never);
  const actor = { type: 'agent' as const, id: 'agent-1', name: 'producer0' };
  const req = { actor } as never;

  beforeEach(() => jest.clearAllMocks());

  it('is mounted under the migration prefix', () => {
    expect(Reflect.getMetadata(PATH_METADATA, MigrationController)).toBe('migration');
  });

  it.each<[keyof MigrationController]>([
    ['createBatch'],
    ['commitBatch'],
    ['createWorkItem'],
    ['transition'],
    ['decide'],
  ])('guards the write path %s with the agent API key', (method) => {
    expect(guardsOn(method)).toEqual([ApiKeyGuard]);
  });

  it.each<[keyof MigrationController]>([
    ['getBatch'],
    ['search'],
    ['getByLegacy'],
    ['mappings'],
  ])('lets a human JWT or an agent key read %s', (method) => {
    expect(guardsOn(method)).toEqual([JwtOrApiKeyGuard]);
  });

  it('exposes the documented routes', () => {
    expect(routeOf('createBatch')).toEqual({ path: 'batches', verb: RequestMethod.POST });
    expect(routeOf('commitBatch')).toEqual({
      path: 'batches/:batchId/commit',
      verb: RequestMethod.POST,
    });
    expect(routeOf('createWorkItem')).toEqual({ path: 'work-items', verb: RequestMethod.POST });
    expect(routeOf('search')).toEqual({ path: 'work-items/search', verb: RequestMethod.GET });
    expect(routeOf('getByLegacy')).toEqual({
      path: 'work-items/by-legacy/:sourceNamespace/:legacyId',
      verb: RequestMethod.GET,
    });
    expect(routeOf('transition')).toEqual({
      path: 'work-items/:taskId/transitions',
      verb: RequestMethod.POST,
    });
    expect(routeOf('decide')).toEqual({
      path: 'identities/:identityId/decisions',
      verb: RequestMethod.POST,
    });
  });

  it('answers 201 on a created batch and 200 on a replayed one', async () => {
    const res = { status: jest.fn() };
    service.createBatch.mockResolvedValueOnce({ created: true, batch: { id: 'b' } });
    await expect(controller.createBatch({} as never, res as never)).resolves.toEqual({ id: 'b' });
    expect(res.status).toHaveBeenCalledWith(201);

    service.createBatch.mockResolvedValueOnce({ created: false, batch: { id: 'b' } });
    await controller.createBatch({} as never, res as never);
    expect(res.status).toHaveBeenLastCalledWith(200);
  });

  it('answers 201 on a fresh import and 200 on its replay', async () => {
    const res = { status: jest.fn() };
    service.createWorkItem.mockResolvedValueOnce({ replayed: false, body: { ok: 1 } });
    await expect(
      controller.createWorkItem({} as never, req, res as never),
    ).resolves.toEqual({ ok: 1 });
    expect(res.status).toHaveBeenCalledWith(201);

    service.createWorkItem.mockResolvedValueOnce({ replayed: true, body: { ok: 1 } });
    await controller.createWorkItem({} as never, req, res as never);
    expect(res.status).toHaveBeenLastCalledWith(200);
  });

  it('derives the acting principal from the request actor, never from the body', async () => {
    const dto = { expectedRevision: 0, toStatus: 'done', idempotencyKey: 'k', basis: 'b' };
    service.transition.mockResolvedValue({ replayed: false, body: { revision: 1 } });
    await expect(controller.transition('task-1', dto as never, req)).resolves.toEqual({
      revision: 1,
    });
    expect(service.transition).toHaveBeenCalledWith('task-1', dto, actor);

    service.decide.mockResolvedValue({ identity: {} });
    await controller.decide('identity-1', {} as never, req);
    expect(service.decide).toHaveBeenCalledWith('identity-1', {}, actor);
  });

  it('passes an absent legacyId query through as an empty search, not undefined', async () => {
    service.searchByLegacyId.mockResolvedValue({ total: 0 });
    await controller.search(undefined as never);
    expect(service.searchByLegacyId).toHaveBeenCalledWith('');
  });

  it('does not re-decode route params Express already decoded', async () => {
    // A second decode turns a literal '%' in a legacy id into a URIError (an
    // untyped 500) and 'foo%2520bar' into the wrong namespace (a spurious
    // 404) — on the readback path, where a wrong answer costs the most.
    service.getWorkItemByLegacy.mockResolvedValue({});
    await controller.getByLegacy('datarim/nested', 'DISCOUNT-50%');
    expect(service.getWorkItemByLegacy).toHaveBeenCalledWith('datarim/nested', 'DISCOUNT-50%');

    await controller.getByLegacy('foo%20bar', 'ARAS-0001');
    expect(service.getWorkItemByLegacy).toHaveBeenLastCalledWith('foo%20bar', 'ARAS-0001');
  });

  it('rejects a non-string legacyId query instead of handing it to Prisma', () => {
    // The query parser is `extended`, so `?legacyId[]=a&legacyId[]=b` arrives
    // as an array and would otherwise surface as an untyped 500.
    expect(() => controller.search(['a', 'b'])).toThrow(BadRequestException);
    expect(() => controller.search({ x: '1' })).toThrow(BadRequestException);
  });
});
