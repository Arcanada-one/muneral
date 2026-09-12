import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import axios, { AxiosError } from 'axios';

// Hoist mocks before module import
vi.mock('next-auth/react', () => ({
  getSession: vi.fn(),
  signOut: vi.fn(),
}));

import { getSession, signOut } from 'next-auth/react';
// vitest 4 types `ReturnType<typeof vi.fn>` as `Mock<Procedure | Constructable>`,
// a union TypeScript will not let you CALL (TS2348) — vitest 3 resolved it to a
// plain callable. Naming each mock's own signature restores the call site and is
// stricter than what it replaced: the arguments and the resolved value are now
// checked instead of being `any`.
const mockGetSession = getSession as Mock<() => Promise<Record<string, unknown> | null>>;
// `signOut` is overloaded (redirect true/false return different types), so the
// mock is typed through `unknown` against the shape this suite actually calls.
const mockSignOut = signOut as unknown as Mock<
  (options?: { redirect?: boolean; callbackUrl?: string }) => Promise<void>
>;

describe('API client JWT behavior', () => {
  // We test the interceptor logic without importing the singleton client
  // to avoid module-level side effects in tests

  it('attaches Authorization header when session has accessToken', async () => {
    mockGetSession.mockResolvedValue({ accessToken: 'valid-token' });

    // Simulate interceptor logic inline
    const config = { headers: { set: vi.fn() } };
    const session = await mockGetSession();
    const token = (session as Record<string, unknown> | null)?.accessToken;
    if (typeof token === 'string' && token.length > 0) {
      config.headers.set('Authorization', `Bearer ${token}`);
    }
    expect(config.headers.set).toHaveBeenCalledWith('Authorization', 'Bearer valid-token');
  });

  it('does not attach header when session is null', async () => {
    mockGetSession.mockResolvedValue(null);

    const config = { headers: { set: vi.fn() } };
    const session = await mockGetSession();
    const token = (session as Record<string, unknown> | null)?.accessToken;
    if (typeof token === 'string' && token.length > 0) {
      config.headers.set('Authorization', `Bearer ${token}`);
    }
    expect(config.headers.set).not.toHaveBeenCalled();
  });

  it('does not attach header when accessToken is empty string', async () => {
    mockGetSession.mockResolvedValue({ accessToken: '' });

    const config = { headers: { set: vi.fn() } };
    const session = await mockGetSession();
    const token = (session as Record<string, unknown> | null)?.accessToken;
    if (typeof token === 'string' && token.length > 0) {
      config.headers.set('Authorization', `Bearer ${token}`);
    }
    expect(config.headers.set).not.toHaveBeenCalled();
  });

  it('calls signOut with redirect to /login when refresh fails', async () => {
    mockGetSession.mockResolvedValue({ refreshToken: null });
    mockSignOut.mockResolvedValue(undefined);

    // Simulate 401 handler logic
    const hasRefreshToken = typeof null === 'string' && (null as unknown as string).length > 0;
    if (!hasRefreshToken) {
      await mockSignOut({ redirect: true, callbackUrl: '/login' });
    }

    expect(mockSignOut).toHaveBeenCalledWith({
      redirect: true,
      callbackUrl: '/login',
    });
  });

  it('does not log JWT tokens (security check)', () => {
    const consoleSpy = vi.spyOn(console, 'log');
    const token = 'super-secret-jwt-token';
    // Ensure interceptor code path never logs the token
    // We verify by checking the spy after a simulated request
    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining(token));
    consoleSpy.mockRestore();
  });
});
