import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../src/auth/guards/jwt-or-api-key.guard.js';
import { ApiKeyGuard } from '../src/auth/guards/api-key.guard.js';
// vitest exposes describe/it/expect as globals (vitest.config.ts `globals: true`);
// `vi` is the one name that must be imported, exactly as `jest` had to be.
import { vi, type Mock } from 'vitest';

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
  let apiKeyGuard: { canActivate: Mock };
  let guard: JwtOrApiKeyGuard;

  beforeEach(() => {
    apiKeyGuard = { canActivate: vi.fn() };
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
    const superCanActivate = vi
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
    const superCanActivate = vi
      .spyOn(Object.getPrototypeOf(Object.getPrototypeOf(guard)), 'canActivate')
      .mockReturnValue(true);

    guard.canActivate(ctx);

    expect(superCanActivate).toHaveBeenCalledWith(ctx);
    superCanActivate.mockRestore();
  });
});
