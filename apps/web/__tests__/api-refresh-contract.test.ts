import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios, { AxiosError, type AxiosAdapter } from 'axios';
import { getSession, signOut } from 'next-auth/react';
import { apiClient } from '@/lib/api/client';

vi.mock('next-auth/react', () => ({ getSession: vi.fn(), signOut: vi.fn() }));

const SOON = '2099-01-01T00:00:00.000Z';
function session(loginSessionId: string, accessToken = 'old-access') {
  return { expires: SOON, loginSessionId, accessToken };
}

function expired(): AxiosAdapter {
  return async (config) => {
    throw new AxiosError('unauthorized', 'ERR_BAD_REQUEST', config, undefined, {
      status: 401, statusText: 'Unauthorized', data: {}, headers: {}, config,
    });
  };
}

/** Refuses `old-access` and accepts anything else, recording what it saw. */
function api(seen: unknown[] = []): AxiosAdapter {
  return async (config) => {
    const authorization = config.headers.get('Authorization');
    seen.push(authorization);
    if (authorization === 'Bearer old-access') return expired()(config);
    return { status: 200, statusText: 'OK', data: {}, headers: {}, config };
  };
}

describe('Web API after a 401: the server refreshes, the browser only asks', () => {
  const post = vi.fn();
  beforeEach(() => {
    vi.mocked(getSession).mockReset();
    vi.mocked(signOut).mockReset();
    post.mockReset();
    vi.spyOn(axios, 'post').mockImplementation(post);
  });
  afterEach(() => {
    expect(post).not.toHaveBeenCalled(); // The browser never calls a refresh endpoint.
    vi.restoreAllMocks();
  });

  it('retries concurrent 401s once each with the token the server session now holds', async () => {
    let refreshedOnServer = false;
    vi.mocked(getSession).mockImplementation(async () =>
      session('steady-login', refreshedOnServer ? 'new-access' : 'old-access'));
    const seen: unknown[] = [];
    const adapter: AxiosAdapter = async (config) => {
      if (config.headers.get('Authorization') === 'Bearer old-access') refreshedOnServer = true;
      return api(seen)(config);
    };
    await Promise.all([apiClient.get('/one', { adapter }), apiClient.get('/two', { adapter })]);
    expect(seen.filter((value) => value === 'Bearer new-access')).toHaveLength(2);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('does not retry or sign out when the session still holds the refused token', async () => {
    vi.mocked(getSession).mockResolvedValue(session('same-token-login'));
    const adapter = vi.fn(expired());
    await expect(apiClient.get('/refused', { adapter })).rejects.toMatchObject({ response: { status: 401 } });
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('signs out when the server says the login is over', async () => {
    vi.mocked(getSession)
      .mockResolvedValueOnce(session('ended-login'))
      .mockResolvedValue({ expires: SOON, loginSessionId: 'ended-login', error: 'SessionExpired' });
    const adapter = vi.fn(expired());
    await expect(apiClient.get('/ended', { adapter })).rejects.toMatchObject({ response: { status: 401 } });
    expect(signOut).toHaveBeenCalledWith({ redirect: true, callbackUrl: '/login' });
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it('stays signed in while the server cannot reach Auth', async () => {
    vi.mocked(getSession)
      .mockResolvedValueOnce(session('offline-login'))
      .mockResolvedValue({ expires: SOON, loginSessionId: 'offline-login', error: 'TemporarilyUnavailable' });
    const adapter = vi.fn(expired());
    await expect(apiClient.get('/offline', { adapter })).rejects.toMatchObject({ response: { status: 401 } });
    expect(signOut).not.toHaveBeenCalled();
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it('never sends a request of one login with the token of another', async () => {
    vi.mocked(getSession).mockResolvedValue(session('first-login'));
    const send401 = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const adapter = vi.fn<AxiosAdapter>(async (config) => {
      started.resolve();
      await send401.promise;
      return expired()(config);
    });
    const first = apiClient.get('/late-401', { adapter });
    const rejection = expect(first).rejects.toMatchObject({ response: { status: 401 } });
    await started.promise;
    vi.mocked(getSession).mockResolvedValue(session('second-login', 'second-access'));
    send401.resolve();
    await rejection;
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('stops the retry when the login changes during the renewal', async () => {
    vi.mocked(getSession)
      .mockResolvedValueOnce(session('renew-login'))   // request
      .mockResolvedValueOnce(session('renew-login'))   // 401 handler
      .mockResolvedValue(session('other-login', 'other-access')); // renewal
    const adapter = vi.fn(expired());
    await expect(apiClient.get('/renew', { adapter })).rejects.toThrow('The session has changed');
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(signOut).not.toHaveBeenCalled();
  });

  // Reads: 1 the request, 2 the 401 handler, 3 the renewal, 4 the retry as it is sent.
  it.each([
    ['another login holds the session', session('other-login', 'other-access')],
    ['the session no longer holds a token', { expires: SOON, loginSessionId: 'retry-login', error: 'TemporarilyUnavailable' }],
  ] as const)('does not send the retry when, by the time it is sent, %s', async (_label, atRetry) => {
    vi.mocked(getSession)
      .mockResolvedValueOnce(session('retry-login'))
      .mockResolvedValueOnce(session('retry-login'))
      .mockResolvedValueOnce(session('retry-login', 'renewed-access'))
      .mockResolvedValue(atRetry);
    const sent: unknown[] = [];
    await expect(apiClient.get('/retry-check', { adapter: api(sent) }))
      .rejects.toThrow('The session has changed');
    expect(sent).toEqual(['Bearer old-access']);
    expect(getSession).toHaveBeenCalledTimes(4);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('preserves an explicit bearer header and returns its own 401', async () => {
    vi.mocked(getSession).mockResolvedValue(session('explicit-login'));
    const adapter = vi.fn(expired());
    await expect(apiClient.get('/explicit', {
      adapter, headers: { Authorization: 'Bearer explicit' },
    })).rejects.toMatchObject({ response: { status: 401 } });
    expect(adapter).toHaveBeenCalledTimes(1);
  });
});
