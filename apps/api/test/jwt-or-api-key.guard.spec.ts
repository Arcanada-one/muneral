import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtOrApiKeyGuard } from '../src/auth/guards/jwt-or-api-key.guard';
import { ApiKeyGuard } from '../src/auth/guards/api-key.guard';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';

function makeContext(authorization: string | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: authorization ? { authorization } : {},
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('JwtOrApiKeyGuard', () => {
  let apiKeyGuard: { canActivate: jest.Mock };
  let jwtAuthGuard: { canActivate: jest.Mock };
  let guard: JwtOrApiKeyGuard;

  beforeEach(() => {
    apiKeyGuard = { canActivate: jest.fn().mockResolvedValue(true) };
    jwtAuthGuard = { canActivate: jest.fn().mockResolvedValue(true) };
    guard = new JwtOrApiKeyGuard(
      apiKeyGuard as unknown as ApiKeyGuard,
      jwtAuthGuard as unknown as JwtAuthGuard,
    );
  });

  it('routes mun_sk_ Bearer tokens to ApiKeyGuard', async () => {
    const ctx = makeContext('Bearer mun_sk_abc123');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(apiKeyGuard.canActivate).toHaveBeenCalledWith(ctx);
    expect(jwtAuthGuard.canActivate).not.toHaveBeenCalled();
  });

  it('routes plain JWT Bearer tokens to JwtAuthGuard', async () => {
    const ctx = makeContext('Bearer eyJhbGciOi.fake.jwt');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(jwtAuthGuard.canActivate).toHaveBeenCalledWith(ctx);
    expect(apiKeyGuard.canActivate).not.toHaveBeenCalled();
  });

  it('routes missing Authorization header to JwtAuthGuard (surfaces the standard 401)', async () => {
    const ctx = makeContext(undefined);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(jwtAuthGuard.canActivate).toHaveBeenCalledWith(ctx);
    expect(apiKeyGuard.canActivate).not.toHaveBeenCalled();
  });

  it('propagates ApiKeyGuard rejection (expired/invalid mun_sk_ key)', async () => {
    apiKeyGuard.canActivate.mockRejectedValue(
      new UnauthorizedException('Invalid or expired API key'),
    );
    const ctx = makeContext('Bearer mun_sk_expired');
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    expect(jwtAuthGuard.canActivate).not.toHaveBeenCalled();
  });

  it('propagates JwtAuthGuard rejection (expired JWT never falls back to API-key check)', async () => {
    jwtAuthGuard.canActivate.mockRejectedValue(new UnauthorizedException('jwt expired'));
    const ctx = makeContext('Bearer eyJhbGciOi.expired.jwt');
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    expect(apiKeyGuard.canActivate).not.toHaveBeenCalled();
  });
});
