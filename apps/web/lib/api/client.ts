import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { getSession, signOut } from 'next-auth/react';

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3500';

type SessionRequest = InternalAxiosRequestConfig & {
  sessionAccessToken?: string;
  _retry?: boolean;
  skipAuthRefresh?: boolean;
};

let refreshedAccess: { sessionToken: string; token: string } | undefined;
const pendingRefresh = new Map<string, Promise<string>>();

export const apiClient = axios.create({
  baseURL: `${API_BASE}/api/v1`,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 15_000,
});

// Attach JWT to every request when the caller did not already set Authorization
// (agent-scoped canaries and explicit Bearer headers must not be overwritten).
apiClient.interceptors.request.use(async (config: SessionRequest) => {
  if (typeof window !== 'undefined' && !config.headers.get('Authorization')) {
    const session = await getSession();
    const token = (session as Record<string, unknown> | null)?.accessToken;
    if (typeof token === 'string' && token.length > 0) {
      config.sessionAccessToken = token;
      const access = refreshedAccess?.sessionToken === token ? refreshedAccess.token : token;
      config.headers.set('Authorization', `Bearer ${access}`);
    }
  }
  return config;
});

async function refreshSessionAccess(sessionToken: string): Promise<string> {
  const session = await getSession() as Record<string, unknown> | null;
  if (session?.accessToken !== sessionToken) {
    throw new Error('The session has changed');
  }
  try {
    if (typeof session.refreshToken !== 'string' || session.refreshToken.length === 0) {
      throw new Error('No refresh token available');
    }
    const { data } = await axios.post<{ access_token: string }>(
      `${API_BASE}/api/v1/auth/refresh`,
      { refresh_token: session.refreshToken },
      { timeout: 15_000 },
    );
    if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
      throw new Error('Invalid refresh response');
    }
    refreshedAccess = { sessionToken, token: data.access_token };
    return data.access_token;
  } catch (error) {
    await signOut({ redirect: true, callbackUrl: '/login' });
    throw error;
  }
}

// JWT refresh on 401
apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const request = error.config as SessionRequest | undefined;
    const sessionToken = request?.sessionAccessToken;
    if (error.response?.status !== 401 || !request || !sessionToken || request._retry || request.skipAuthRefresh) {
      throw error;
    }

    request._retry = true;
    const cached = refreshedAccess?.sessionToken === sessionToken ? refreshedAccess.token : undefined;
    if (cached && request.headers.get('Authorization') !== `Bearer ${cached}`) {
      request.headers.set('Authorization', `Bearer ${cached}`);
      return apiClient(request);
    }

    let refresh = pendingRefresh.get(sessionToken);
    if (!refresh) {
      refresh = refreshSessionAccess(sessionToken).finally(() => pendingRefresh.delete(sessionToken));
      pendingRefresh.set(sessionToken, refresh);
    }
    request.headers.set('Authorization', `Bearer ${await refresh}`);
    return apiClient(request);
  },
);

export default apiClient;
