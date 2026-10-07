import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../src/auth/guards/jwt-or-api-key.guard.js';
import { ApiKeyGuard } from '../src/auth/guards/api-key.guard.js';
import { TaskReadApiKeyHeader } from '../src/auth/task-read-api-key-header.js';

class TaskReadFixture {
  @TaskReadApiKeyHeader()
  read() {}
}
function unmarkedHandler() {}
// ESM has no injected globals, so `jest` must be imported for the RUNTIME.
// Its type, though, comes from @types/jest (already in tsconfig `types`),
// which is what the 339 existing jest.fn() call sites are written against —
// @jest/globals ships a stricter generic whose bare jest.fn() infers `never`
// and would red 416 lines that are not otherwise wrong. Value from one,
// type from the other.
import { jest as _jestRuntime } from '@jest/globals';
const jest = _jestRuntime as unknown as typeof globalThis.jest;

function makeContext(authHeader?: string, marked = false, rawHeaders?: string[]): ExecutionContext {
  return {
    getHandler: () => marked ? TaskReadFixture.prototype.read : unmarkedHandler,
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'GET',
        rawHeaders: rawHeaders ?? (authHeader ? ['Authorization', authHeader] : []),
        headers: authHeader ? { authorization: authHeader } : {},
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('JwtOrApiKeyGuard', () => {
  let apiKeyGuard: { canActivate: jest.Mock };
  let guard: JwtOrApiKeyGuard;

  beforeEach(() => {
    apiKeyGuard = { canActivate: jest.fn() };
    guard = new JwtOrApiKeyGuard(apiKeyGuard as unknown as ApiKeyGuard);
  });

  it('delegates to ApiKeyGuard when Authorization is a mun_sk_ bearer token', async () => {
    apiKeyGuard.canActivate.mockResolvedValue(true);
    const ctx = makeContext('Bearer mun_sk_abc123');

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(apiKeyGuard.canActivate).toHaveBeenCalledWith(ctx);
  });

  it('propagates ApiKeyGuard rejection for an invalid mun_sk_ token', async () => {
    apiKeyGuard.canActivate.mockRejectedValue(
      new UnauthorizedException('Invalid or expired API key'),
    );
    const ctx = makeContext('Bearer mun_sk_bad');

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('falls back to JWT passport strategy when no mun_sk_ bearer is present', () => {
    const ctx = makeContext('Bearer some.jwt.token');
    const superCanActivate = jest
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate')
      .mockReturnValue(true);

    const result = guard.canActivate(ctx);

    expect(superCanActivate).toHaveBeenCalledWith(ctx);
    expect(result).toBe(true);
    expect(apiKeyGuard.canActivate).not.toHaveBeenCalled();
    superCanActivate.mockRestore();
  });

  it('falls back to JWT passport strategy when Authorization header is absent', () => {
    const ctx = makeContext(undefined);
    const superCanActivate = jest
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate')
      .mockReturnValue(true);

    guard.canActivate(ctx);

    expect(superCanActivate).toHaveBeenCalledWith(ctx);
    superCanActivate.mockRestore();
  });
  it.each([false, true])('preserves a single JWT on a task handler marked=%s', (marked) => {
    const ctx = makeContext('Bearer some.jwt.token', marked);
    const passport = jest.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate')
      .mockReturnValue(true);
    try {
      expect(guard.canActivate(ctx)).toBe(true);
      expect(passport).toHaveBeenCalledWith(ctx);
      expect(apiKeyGuard.canActivate).not.toHaveBeenCalled();
    } finally { passport.mockRestore(); }
  });

  it('refuses repeated JWT Authorization before Passport on the marked task GET', () => {
    const ctx = makeContext('Bearer some.jwt.token', true,
      ['Authorization', 'Bearer some.jwt.token', 'authorization', 'Bearer second.jwt.token']);
    const passport = jest.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate')
      .mockReturnValue(true);
    try {
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
      expect(passport).not.toHaveBeenCalled();
      expect(apiKeyGuard.canActivate).not.toHaveBeenCalled();
    } finally { passport.mockRestore(); }
  });

  it('preserves existing JWT dispatch on an unmarked handler with repeated Authorization', () => {
    const ctx = makeContext('Bearer some.jwt.token', false,
      ['Authorization', 'Bearer some.jwt.token', 'authorization', 'Bearer second.jwt.token']);
    const passport = jest.spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate')
      .mockReturnValue(true);
    try {
      expect(guard.canActivate(ctx)).toBe(true);
      expect(passport).toHaveBeenCalledWith(ctx);
    } finally { passport.mockRestore(); }
  });

});
