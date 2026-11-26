import { createHash, createHmac } from 'node:crypto';
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

  it('forwards intact signed Telegram widget data and returns the API tokens', async () => {
    const botToken = 'synthetic-widget-test';
    const auth_date = Math.floor(Date.now() / 1000);
    const hash = createHmac('sha256', createHash('sha256').update(botToken).digest())
      .update(`auth_date=${auth_date}\nfirst_name=Widget\nid=1234`)
      .digest('hex');
    const data = { id: 1234, first_name: 'Widget', auth_date, hash };
    const authorize = config.providers[1]?.options?.authorize;
    if (typeof authorize !== 'function') throw new Error('Telegram credentials callback is missing');
    const request = new Request('https://example.test/login');
    const identity = await authorize({ telegramData: JSON.stringify(data) }, request);
    expect(post).toHaveBeenCalledWith('/auth/telegram', data);
    expect(identity).toMatchObject({
      id: '1234',
      accessToken: issued.access_token,
      refreshToken: issued.refresh_token,
    });
    await expect(config.callbacks!.jwt!({
      token: {},
      user: identity,
      account: { provider: 'telegram', type: 'credentials', providerAccountId: '1234' },
    })).resolves.toMatchObject({
      loginSessionId: expect.any(String),
      accessToken: issued.access_token,
      refreshToken: issued.refresh_token,
    });
    post.mockReset().mockRejectedValue(new Error('API verification refused the payload'));
    await expect(authorize({
      telegramData: JSON.stringify({ ...data, id: 4321 }),
    }, request)).resolves.toBeNull();
    expect(post).toHaveBeenCalledWith('/auth/telegram', { ...data, id: 4321 });
  });
});
