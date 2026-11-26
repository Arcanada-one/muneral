import type { NextAuthConfig } from 'next-auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { capture, post } = vi.hoisted(() => ({ capture: vi.fn(), post: vi.fn() }));
vi.mock('next-auth', () => ({ default: capture.mockReturnValue({}) }));
vi.mock('@/lib/api/client', () => ({ apiClient: { post } }));

import '@/lib/auth/nextauth';

const config = capture.mock.calls[0][0] as NextAuthConfig;

describe('Web authentication callbacks', () => {
  const issued = { access_token: 'muneral-access', refresh_token: 'muneral-refresh' };

  beforeEach(() => {
    post.mockReset().mockResolvedValue({ data: issued });
  });

  it('exchanges only the provider credential and binds the tokens to a unique login', async () => {
    const signIn = () => config.callbacks!.jwt!({
      token: {},
      user: { id: 'untrusted-profile-id', email: 'fixture@example.test' },
      account: {
        provider: 'github',
        type: 'oauth',
        providerAccountId: 'provider-id',
        access_token: 'synthetic-oauth-value',
      },
    });
    const token = await signIn();
    expect(post).toHaveBeenCalledWith('/auth/github', { access_token: 'synthetic-oauth-value' });
    expect(token).toEqual({
      accessToken: issued.access_token,
      refreshToken: issued.refresh_token,
      loginSessionId: expect.any(String),
    });
    const secondLogin = await signIn();
    expect(secondLogin?.loginSessionId).not.toBe(token?.loginSessionId);
    if (!token) throw new Error('JWT callback returned no token');
    await expect(config.callbacks!.jwt!({ token, user: {} })).resolves.toEqual(token);
  });

  it('rejects a GitHub sign-in without a provider credential', async () => {
    await expect(config.callbacks!.jwt!({
      token: {},
      user: { id: 'profile-id' },
      account: { provider: 'github', type: 'oauth', providerAccountId: 'provider-id' },
    })).rejects.toThrow('GitHub sign-in did not return an access token');
    expect(post).not.toHaveBeenCalled();
  });

  it('carries the tokens of a credentials login and binds them to a login id', async () => {
    const user = { id: 'profile-id', accessToken: issued.access_token, refreshToken: issued.refresh_token };
    const token = await config.callbacks!.jwt!({
      token: {},
      user,
      account: { provider: 'credentials-fixture', type: 'credentials', providerAccountId: 'profile-id' },
    });
    expect(token).toEqual({
      accessToken: issued.access_token,
      refreshToken: issued.refresh_token,
      loginSessionId: expect.any(String),
    });
    expect(post).not.toHaveBeenCalled();
  });

  it('does not log or rethrow the provider credential when the exchange fails', async () => {
    post.mockReset().mockRejectedValue(new Error('request body: synthetic-oauth-value'));
    await expect(config.callbacks!.jwt!({
      token: {},
      user: { id: 'profile-id' },
      account: { provider: 'github', type: 'oauth', providerAccountId: 'provider-id', access_token: 'synthetic-oauth-value' },
    })).rejects.toThrow(/^GitHub sign-in could not be completed$/);
  });

  it('exposes the login id on the session', async () => {
    const result = await config.callbacks!.session!({
      session: { expires: '' },
      token: { accessToken: 'a', refreshToken: 'r', loginSessionId: 'login-1' },
    } as never);
    expect(result).toMatchObject({ accessToken: 'a', refreshToken: 'r', loginSessionId: 'login-1' });
  });
});
