import { afterEach, describe, expect, it, vi } from 'vitest';
import axios, { AxiosError, type AxiosAdapter } from 'axios';
import { getSession, signOut } from 'next-auth/react';
import { apiClient } from '@/lib/api/client';

vi.mock('next-auth/react', () => ({ getSession: vi.fn(), signOut: vi.fn() }));

function session(loginSessionId: string) {
  return { expires: '', loginSessionId, accessToken: 'old-access', refreshToken: 'session-refresh' };
}

const acceptRefreshed: AxiosAdapter = async (config) => {
  if (config.headers.get('Authorization') === 'Bearer old-access') return expired()(config);
  return { status: 200, statusText: 'OK', data: {}, headers: {}, config };
};

function expired(): AxiosAdapter {
  return async (config) => {
    throw new AxiosError('unauthorized', 'ERR_BAD_REQUEST', config, undefined, {
      status: 401, statusText: 'Unauthorized', data: {}, headers: {}, config,
    });
  };
}

describe('Web API refresh', () => {
  afterEach(() => vi.restoreAllMocks());

  it('coalesces concurrent 401s and reuses the access JWT only for the originating session', async () => {
    vi.mocked(getSession).mockResolvedValue(session('steady-login'));
    const refresh = vi.spyOn(axios, 'post').mockResolvedValue({ data: { access_token: 'new-access' } });
    try {
      const requests: unknown[] = [];
      const adapter: AxiosAdapter = async (config) => {
        const auth = config.headers.get('Authorization');
        requests.push(auth);
        if (auth === 'Bearer old-access') return expired()(config);
        return { status: 200, statusText: 'OK', data: {}, headers: {}, config };
      };
      await Promise.all([apiClient.get('/one', { adapter }), apiClient.get('/two', { adapter })]);
      await apiClient.get('/three', { adapter });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledWith(expect.stringMatching(/\/api\/v1\/auth\/refresh$/),
        { refresh_token: 'session-refresh' }, expect.anything());
      expect(requests.filter((auth) => auth === 'Bearer new-access')).toHaveLength(3);
      vi.mocked(getSession).mockResolvedValue(null);
      await apiClient.get('/four', { adapter });
      expect(requests.at(-1)).toBeUndefined();
      expect(signOut).not.toHaveBeenCalled();
    } finally {
      refresh.mockRestore();
    }
  });

  it.each(['success', 'failure'])('isolates a late refresh %s after a login change', async (outcome) => {
    const active = vi.mocked(getSession);
    active.mockResolvedValue(session('old-login'));
    const oldRefresh = Promise.withResolvers<{ data: { access_token: string } }>();
    const started = Promise.withResolvers<void>();
    const post = vi.spyOn(axios, 'post').mockImplementationOnce(() => {
      started.resolve();
      return oldRefresh.promise;
    }).mockResolvedValue({ data: { access_token: 'new-login-access' } });
    const oldAdapter = vi.fn(expired());
    const oldRequest = apiClient.get('/old-session', { adapter: oldAdapter });
    const rejection = expect(oldRequest).rejects.toThrow(
      outcome === 'success' ? 'The session has changed' : 'Refresh failed',
    );
    await started.promise;

    // Same API credentials, but a new Auth.js login and a separate refresh.
    active.mockResolvedValue(session('new-login'));
    const next = await apiClient.get('/new-session', { adapter: acceptRefreshed });
    expect(next.config.headers.get('Authorization')).toBe('Bearer new-login-access');
    expect(post).toHaveBeenCalledTimes(2);
    if (outcome === 'success') oldRefresh.resolve({ data: { access_token: 'old-login-access' } });
    else oldRefresh.reject(new Error('Refresh failed'));

    await rejection;
    expect(oldAdapter).toHaveBeenCalledTimes(1);
    expect(signOut).not.toHaveBeenCalled();
    const latest = await apiClient.get('/follow-up', { adapter: acceptRefreshed });
    expect(latest.config.headers.get('Authorization')).toBe('Bearer new-login-access');
  });

  it('rechecks the active login before even a cached-token retry reaches the adapter', async () => {
    const original = session('cached-original');
    const active = vi.mocked(getSession);
    active.mockResolvedValue(original);
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { access_token: 'cached-access' } });
    const started = Promise.withResolvers<void>();
    const send401 = Promise.withResolvers<void>();
    const adapter: AxiosAdapter = vi.fn(async (config) => {
      started.resolve();
      await send401.promise;
      return expired()(config);
    });

    const first = apiClient.get('/late-401', { adapter });
    const rejection = expect(first).rejects.toThrow('The session has changed');
    await started.promise;
    await apiClient.get('/populate-cache', { adapter: acceptRefreshed });
    active.mockResolvedValueOnce(original).mockResolvedValue(session('cached-replacement'));
    send401.resolve();
    await rejection;
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('preserves an explicit bearer header and returns its own 401', async () => {
    const refresh = vi.spyOn(axios, 'post');
    try {
      const adapter = vi.fn(expired());
      await expect(apiClient.get('/explicit', {
        adapter, headers: { Authorization: 'Bearer explicit' },
      })).rejects.toMatchObject({ response: { status: 401 } });
      expect(adapter).toHaveBeenCalledTimes(1);
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      refresh.mockRestore();
    }
  });
});
