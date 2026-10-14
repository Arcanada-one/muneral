import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createServer, type Server } from 'node:http';
import type { ReactNode } from 'react';

const session = vi.hoisted(() => ({ accessToken: '' }));
vi.mock('next-auth/react', () => ({
  getSession: vi.fn(async () => ({ accessToken: session.accessToken })),
  signOut: vi.fn(),
}));

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const CREATED_AT = '2026-10-14T00:00:00.000Z';

const workspace = {
  id: WORKSPACE_ID,
  slug: 'membership-workspace',
  name: 'Membership workspace',
  createdAt: CREATED_AT,
};
const project = {
  id: PROJECT_ID,
  workspaceId: WORKSPACE_ID,
  slug: 'membership-project',
  name: 'Membership project',
  createdAt: CREATED_AT,
};
const task = {
  id: TASK_ID,
  projectId: PROJECT_ID,
  title: 'Membership task',
  status: 'todo',
  priority: 'medium',
  actorType: 'human',
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

describe('PR246 web membership read adapters', () => {
  let server: Server;
  let baseUrl: string;
  let apiClient: (typeof import('./client'))['default'];
  let useWorkspaceMembers: (typeof import('./workspaces'))['useWorkspaceMembers'];
  let useTasks: (typeof import('./tasks'))['useTasks'];
  let taskDetailReadPort: (typeof import('./task-detail-read'))['taskDetailReadPort'];
  let previousBaseUrl: string | undefined;
  const requests: Array<{ method: string; path: string; authenticated: boolean }> = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      response.setHeader('access-control-allow-origin', 'http://localhost:3000');
      response.setHeader('access-control-allow-headers', 'authorization, content-type');
      response.setHeader('access-control-allow-methods', 'GET, OPTIONS');
      if (request.method === 'OPTIONS') {
        response.statusCode = 204;
        response.end();
        return;
      }
      requests.push({
        method: request.method ?? 'GET',
        path: `${url.pathname}${url.search}`,
        authenticated: request.headers.authorization === 'Bearer synthetic-session-token',
      });
      response.setHeader('content-type', 'application/json');
      if (request.headers.authorization !== 'Bearer synthetic-session-token') {
        response.statusCode = 401;
        response.end(JSON.stringify({ message: 'Unauthorized' }));
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/workspaces') {
        response.end(JSON.stringify([workspace]));
      } else if (request.method === 'GET' && url.pathname === `/api/v1/workspaces/${WORKSPACE_ID}/members`) {
        response.end(JSON.stringify([{
          workspaceId: WORKSPACE_ID,
          userId: OWNER_ID,
          role: 'owner',
          user: { name: 'Synthetic owner' },
        }]));
      } else if (request.method === 'GET' && url.pathname === '/api/v1/tasks') {
        response.end(JSON.stringify({ items: [task], total: 1, limit: 50, offset: 0 }));
      } else if (request.method === 'GET' && url.pathname === `/api/v1/projects/workspace/${WORKSPACE_ID}`) {
        response.end(JSON.stringify([project]));
      } else if (request.method === 'GET' && url.pathname === `/api/v1/tasks/${TASK_ID}`) {
        response.end(JSON.stringify({ ...task, revision: 7 }));
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ message: 'Not found' }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('web test server did not bind a TCP port');
    baseUrl = `http://127.0.0.1:${address.port}/api/v1`;

    session.accessToken = 'synthetic-session-token';
    apiClient = (await import('./client')).default;
    previousBaseUrl = apiClient.defaults.baseURL;
    apiClient.defaults.baseURL = baseUrl;
    ({ useWorkspaceMembers } = await import('./workspaces'));
    ({ useTasks } = await import('./tasks'));
    ({ taskDetailReadPort } = await import('./task-detail-read'));
  }, 15_000);

  beforeEach(() => {
    requests.length = 0;
  });

  afterAll(async () => {
    session.accessToken = '';
    if (apiClient) apiClient.defaults.baseURL = previousBaseUrl;
    await new Promise<void>((resolve, reject) => {
      if (!server?.listening) return resolve();
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  function wrapper(query: QueryClient) {
    function QueryWrapper({ children }: { children: ReactNode }) {
      return (
      <QueryClientProvider client={query}>{children}</QueryClientProvider>
      );
    }
    QueryWrapper.displayName = 'Pr246QueryWrapper';
    return QueryWrapper;
  }

  it('resolves a workspace slug before reading its members and preserves the owner role', async () => {
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, unmount } = renderHook(
      () => useWorkspaceMembers('membership-workspace'),
      { wrapper: wrapper(query) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{
      id: OWNER_ID,
      userId: OWNER_ID,
      userName: 'Synthetic owner',
      role: 'owner',
    }]);
    expect(requests.map(({ method, path, authenticated }) => [method, path, authenticated])).toEqual([
      ['GET', '/api/v1/workspaces', true],
      ['GET', `/api/v1/workspaces/${WORKSPACE_ID}/members`, true],
    ]);
    unmount();
    query.clear();
  });

  it('binds the task query to the requested project and valid pagination', async () => {
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, unmount } = renderHook(() => useTasks(PROJECT_ID), { wrapper: wrapper(query) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.data.map(({ id }) => id)).toEqual([TASK_ID]);
    expect(requests).toEqual([{
      method: 'GET',
      path: `/api/v1/tasks?projectId=${PROJECT_ID}&limit=50&offset=0`,
      authenticated: true,
    }]);
    unmount();
    query.clear();
  });

  it('loads task detail only after the workspace and project bind to the selected task', async () => {
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const port = taskDetailReadPort(query);
    const loaded = await port.load({
      workspaceSlug: 'membership-workspace',
      projectSlug: 'membership-project',
      taskId: TASK_ID,
    }, new AbortController().signal);
    expect(loaded.id).toBe(TASK_ID);
    expect(loaded.projectId).toBe(PROJECT_ID);
    expect(loaded.revision).toBe(7);
    expect(requests.map(({ method, path, authenticated }) => [method, path, authenticated])).toEqual([
      ['GET', '/api/v1/workspaces', true],
      ['GET', `/api/v1/projects/workspace/${WORKSPACE_ID}`, true],
      ['GET', `/api/v1/tasks/${TASK_ID}`, true],
    ]);
    query.clear();
  });
});
