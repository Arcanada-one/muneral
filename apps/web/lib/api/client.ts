import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { getSession, signOut } from 'next-auth/react';

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3500';

type SessionRequest = InternalAxiosRequestConfig & {
  loginSessionId?: string;
  _retry?: boolean;
  skipAuthRefresh?: boolean;
};

type Login = {
  id: string;
  refreshedAccess?: string;
  pendingRefresh?: Promise<void>;
};

let activeLogin: Login | undefined;

async function readActiveSession() {
  const previousLogin = activeLogin;
  const session = await getSession();
  const id = session?.loginSessionId;
  if (activeLogin !== previousLogin && activeLogin?.id !== id) {
    // An older session response must not overwrite a turnover already observed.
    return { session: null, login: undefined };
  }
  if (activeLogin?.id !== id) {
    activeLogin = id ? { id } : undefined;
  }
  return { session, login: activeLogin };
}

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
  if (typeof window === 'undefined') return config;
  if (config._retry && config.loginSessionId) {
    const { login } = await readActiveSession();
    if (!login?.refreshedAccess || login.id !== config.loginSessionId) {
      throw new Error('The session has changed');
    }
    config.headers.set('Authorization', `Bearer ${login.refreshedAccess}`);
  } else if (!config.headers.get('Authorization')) {
    const { session, login } = await readActiveSession();
    const access = login?.refreshedAccess ?? session?.accessToken;
    if (access) {
      config.loginSessionId = login?.id;
      config.headers.set('Authorization', `Bearer ${access}`);
    }
  }
  return config;
});

async function refreshSessionAccess(login: Login, refreshToken: string | null | undefined): Promise<void> {
  let access: string;
  try {
    if (!refreshToken) {
      throw new Error('No refresh token available');
    }
    const { data } = await axios.post<{ access_token: string }>(
      `${API_BASE}/api/v1/auth/refresh`,
      { refresh_token: refreshToken },
      { timeout: 15_000 },
    );
    if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
      throw new Error('Invalid refresh response');
    }
    access = data.access_token;
  } catch (error) {
    const current = await readActiveSession();
    if (current.login === login) {
      await signOut({ redirect: true, callbackUrl: '/login' });
    }
    throw error;
  }
  const current = await readActiveSession();
  if (current.login !== login) throw new Error('The session has changed');
  login.refreshedAccess = access;
}

// JWT refresh on 401
apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const request = error.config as SessionRequest | undefined;
    if (error.response?.status !== 401 || !request?.loginSessionId || request._retry || request.skipAuthRefresh) {
      throw error;
    }

    const { session, login } = await readActiveSession();
    if (!login || login.id !== request.loginSessionId) throw error;

    request._retry = true;
    const cached = login.refreshedAccess;
    if (cached && request.headers.get('Authorization') !== `Bearer ${cached}`) {
      return apiClient(request);
    }

    if (!login.pendingRefresh) {
      login.pendingRefresh = refreshSessionAccess(login, session?.refreshToken).finally(() => {
        login.pendingRefresh = undefined;
      });
    }
    await login.pendingRefresh;
    return apiClient(request);
  },
);

export default apiClient;
