import { describe, expect, it, vi } from 'vitest';
import axios, { AxiosError, type AxiosAdapter } from 'axios';
import { getSession, signOut } from 'next-auth/react';
import { apiClient } from '@/lib/api/client';

vi.mock('next-auth/react', () => ({ getSession: vi.fn(), signOut: vi.fn() }));

function expired(): AxiosAdapter {
  return async (config) => {
    throw new AxiosError('unauthorized', 'ERR_BAD_REQUEST', config, undefined, {
      status: 401, statusText: 'Unauthorized', data: {}, headers: {}, config,
    });
  };
}

describe('Web API refresh', () => {
  it('coalesces concurrent 401s and reuses the access JWT only for the originating session', async () => {
    vi.mocked(getSession).mockResolvedValue({
      expires: '', accessToken: 'old-access', refreshToken: 'session-refresh',
    } as Awaited<ReturnType<typeof getSession>>);
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
