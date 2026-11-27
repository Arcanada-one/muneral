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
  renewal?: Promise<string | undefined>;
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

// Attach the access token to every request when the caller did not already set Authorization
// (agent-scoped canaries and explicit Bearer headers must not be overwritten).
apiClient.interceptors.request.use(async (config: SessionRequest) => {
  if (typeof window === 'undefined') return config;
  if (config._retry && config.loginSessionId) {
    const { session, login } = await readActiveSession();
    if (!session?.accessToken || login?.id !== config.loginSessionId) {
      throw new Error('The session has changed');
    }
    config.headers.set('Authorization', `Bearer ${session.accessToken}`);
  } else if (!config.headers.get('Authorization')) {
    const { session, login } = await readActiveSession();
    if (session?.accessToken) {
      config.loginSessionId = login?.id;
      config.headers.set('Authorization', `Bearer ${session.accessToken}`);
    }
  }
  return config;
});

/**
 * After a 401: ask the server session, which refreshes on the server when the token is due.
 * Returns the current access token, or signs out when the server says the login is over.
 */
async function currentAccess(login: Login): Promise<string | undefined> {
  const current = await readActiveSession();
  if (current.login !== login) throw new Error('The session has changed');
  if (current.session?.error === 'SessionExpired') {
    await signOut({ redirect: true, callbackUrl: '/login' });
    return undefined;
  }
  return current.session?.accessToken;
}

// One retry on 401, only when the server session now holds a different access token.
apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const request = error.config as SessionRequest | undefined;
    if (error.response?.status !== 401 || !request?.loginSessionId || request._retry || request.skipAuthRefresh) {
      throw error;
    }

    const { login } = await readActiveSession();
    if (!login || login.id !== request.loginSessionId) throw error;

    request._retry = true;
    login.renewal ??= currentAccess(login).finally(() => {
      login.renewal = undefined;
    });
    const access = await login.renewal;
    // The same token would be refused again; signing out here could loop.
    if (!access || request.headers.get('Authorization') === `Bearer ${access}`) throw error;
    return apiClient(request);
  },
);

export default apiClient;
