import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import { getSession, signOut } from 'next-auth/react';

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3500';

export const apiClient = axios.create({
  baseURL: `${API_BASE}/api/v1`,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 15_000,
});

// Attach JWT to every request
apiClient.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  if (typeof window !== 'undefined') {
    const session = await getSession();
    const token = (session as Record<string, unknown> | null)?.accessToken;
    if (typeof token === 'string' && token.length > 0) {
      config.headers.set('Authorization', `Bearer ${token}`);
    }
  }
  return config;
});

let isRefreshing = false;
let failedQueue: Array<{
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}> = [];

function processQueue(error: unknown, token: string | null = null) {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
}

// JWT refresh on 401
apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & {
      _retry?: boolean;
    };

    if (error.response?.status === 401 && !originalRequest._retry) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then((token) => {
          if (typeof token === 'string') {
            originalRequest.headers.set('Authorization', `Bearer ${token}`);
          }
          return apiClient(originalRequest);
        });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const session = await getSession();
        const refreshToken = (session as Record<string, unknown> | null)?.refreshToken;

        if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
          throw new Error('No refresh token available');
        }

        const res = await axios.post<{ access_token: string }>(
          `${API_BASE}/api/v1/auth/refresh`,
          { refresh_token: refreshToken },
        );

        const newToken = res.data.access_token;
        processQueue(null, newToken);
        originalRequest.headers.set('Authorization', `Bearer ${newToken}`);
        return apiClient(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError, null);
        await signOut({ redirect: true, callbackUrl: '/login' });
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  },
);

export default apiClient;
