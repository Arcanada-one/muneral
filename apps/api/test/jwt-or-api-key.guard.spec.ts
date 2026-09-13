import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../src/auth/guards/jwt-or-api-key.guard.js';
import { ApiKeyGuard } from '../src/auth/guards/api-key.guard.js';
// ESM has no injected globals, so `jest` must be imported for the RUNTIME.
// Its type, though, comes from @types/jest (already in tsconfig `types`),
// which is what the 339 existing jest.fn() call sites are written against —
// @jest/globals ships a stricter generic whose bare jest.fn() infers `never`
// and would red 416 lines that are not otherwise wrong. Value from one,
// type from the other.
import { jest as _jestRuntime } from '@jest/globals';
const jest = _jestRuntime as unknown as typeof globalThis.jest;

function makeContext(authHeader?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
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
});
