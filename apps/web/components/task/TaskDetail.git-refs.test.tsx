import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TaskDetail } from './TaskDetail';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ default: api }));
vi.mock('./TaskChecklist', () => ({ TaskChecklist: () => null }));
vi.mock('./TaskDependencies', () => ({ TaskDependencies: () => null }));

const task = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Task with source-controlled references',
  status: 'todo' as const,
  priority: 'medium' as const,
  projectId: '22222222-2222-4222-8222-222222222222',
  actorType: 'human' as const,
  createdAt: '2026-10-24T08:00:00.000Z',
  updatedAt: '2026-10-24T08:00:00.000Z',
};
const otherTask = {
  ...task,
  id: '66666666-6666-4666-8666-666666666666',
  title: 'Another task',
};
const gitRefs = [
  {
    id: '33333333-3333-4333-8333-333333333333',
    taskId: task.id,
    type: 'repo',
    url: 'https://github.com/example/project',
    ref: 'repository',
    createdAt: '2026-10-24T08:30:00.000Z',
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    taskId: task.id,
    type: 'branch',
    url: 'https://github.com/example/project/tree/feature',
    ref: 'feature',
    createdAt: '2026-10-24T08:31:00.000Z',
  },
  {
    id: '55555555-5555-4555-8555-555555555555',
    taskId: task.id,
    type: 'commit',
    url: 'https://github.com/example/project/commit/abc123',
    ref: 'abc123',
    createdAt: '2026-10-24T08:32:00.000Z',
  },
];

let client: QueryClient;

beforeEach(() => {
  api.get.mockReset().mockImplementation(async (url: string) => {
    const gitRefsMatch = url.match(/^\/projects\/tasks\/([^/]+)\/git-refs$/);
    if (gitRefsMatch?.[1] === task.id) return { data: gitRefs };
    if (gitRefsMatch?.[1] === otherTask.id) return { data: [] };
    const activityMatch = url.match(/^\/tasks\/([^/]+)\/activity\?page=1&limit=20$/);
    if (activityMatch) {
      return { data: { data: [], total: 0, page: 1, limit: 20 } };
    }
    throw new Error(`Unexpected GET ${url}`);
  });
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});

afterEach(() => {
  cleanup();
  client.clear();
});

describe('TaskDetail Git references', () => {
  it('loads and displays the task references returned by the existing API route', async () => {
    render(
      <QueryClientProvider client={client}>
        <TaskDetail task={task} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'Git References' })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith(`/projects/tasks/${task.id}/git-refs`);
    expect(await screen.findByRole('link', { name: /repository/i })).toHaveAttribute(
      'href',
      gitRefs[0].url,
    );
    expect(await screen.findByRole('link', { name: /feature/i })).toHaveAttribute(
      'href',
      gitRefs[1].url,
    );
    expect(await screen.findByRole('link', { name: /abc123/i })).toHaveAttribute(
      'href',
      gitRefs[2].url,
    );
  });

  it('shows explicit loading, empty, and error states without exposing server details', async () => {
    let resolveRefs!: (value: { data: typeof gitRefs }) => void;
    api.get.mockImplementation((url: string) => {
      if (url === `/projects/tasks/${task.id}/git-refs`) {
        return new Promise((resolve) => { resolveRefs = resolve; });
      }
      if (url.startsWith('/tasks/')) {
        return Promise.resolve({ data: { data: [], total: 0, page: 1, limit: 20 } });
      }
      return Promise.reject(new Error('unexpected request'));
    });
    const view = render(
      <QueryClientProvider client={client}>
        <TaskDetail task={task} />
      </QueryClientProvider>,
    );

    expect(screen.getByText('Loading Git references…')).toBeInTheDocument();
    await act(async () => resolveRefs({ data: [] }));
    expect(await screen.findByText('No Git references.')).toBeInTheDocument();

    view.unmount();
    const errorTask = { ...task, id: '77777777-7777-4777-8777-777777777777' };
    const errorClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api.get.mockImplementation((url: string) => {
      if (url.endsWith('/git-refs')) return Promise.reject(new Error('sensitive server response detail'));
      if (url.startsWith('/tasks/')) {
        return Promise.resolve({ data: { data: [], total: 0, page: 1, limit: 20 } });
      }
      return Promise.reject(new Error('unexpected request'));
    });
    render(
      <QueryClientProvider client={errorClient}>
        <TaskDetail task={errorTask} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Git references are unavailable.');
    expect(screen.queryByText('sensitive server response detail')).not.toBeInTheDocument();
    errorClient.clear();
  });

  it('rejects malformed and cross-task responses before rendering references', async () => {
    const malformed = { ...gitRefs[0], type: 'tag' };
    api.get.mockImplementation((url: string) => {
      if (url.endsWith('/git-refs')) return Promise.resolve({ data: [malformed] });
      if (url.startsWith('/tasks/')) {
        return Promise.resolve({ data: { data: [], total: 0, page: 1, limit: 20 } });
      }
      return Promise.reject(new Error('unexpected request'));
    });
    const view = render(
      <QueryClientProvider client={client}>
        <TaskDetail task={task} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Git references are unavailable.');
    expect(screen.queryByText('repository')).not.toBeInTheDocument();

    const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    api.get.mockImplementation((url: string) => {
      if (url.endsWith('/git-refs')) {
        return Promise.resolve({ data: [{ ...gitRefs[0], taskId: otherTask.id }] });
      }
      if (url.startsWith('/tasks/')) {
        return Promise.resolve({ data: { data: [], total: 0, page: 1, limit: 20 } });
      }
      return Promise.reject(new Error('unexpected request'));
    });
    view.rerender(
      <QueryClientProvider client={nextClient}>
        <TaskDetail task={task} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Git references are unavailable.');
    expect(screen.queryByText('repository')).not.toBeInTheDocument();
    nextClient.clear();
  });

  it('does not show stale task references while the new task request is pending or after it resolves', async () => {
    let resolveTaskRefs!: (value: { data: typeof gitRefs }) => void;
    let resolveOtherRefs!: (value: { data: typeof gitRefs }) => void;
    api.get.mockImplementation((url: string) => {
      if (url === `/projects/tasks/${task.id}/git-refs`) {
        return new Promise((resolve) => { resolveTaskRefs = resolve; });
      }
      if (url === `/projects/tasks/${otherTask.id}/git-refs`) {
        return new Promise((resolve) => { resolveOtherRefs = resolve; });
      }
      if (url.startsWith('/tasks/')) {
        return Promise.resolve({ data: { data: [], total: 0, page: 1, limit: 20 } });
      }
      return Promise.reject(new Error('unexpected request'));
    });
    const view = render(
      <QueryClientProvider client={client}>
        <TaskDetail task={task} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Loading Git references…')).toBeInTheDocument();

    view.rerender(
      <QueryClientProvider client={client}>
        <TaskDetail task={otherTask} />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('link', { name: /repository/i })).not.toBeInTheDocument();
    expect(screen.getByText('Loading Git references…')).toBeInTheDocument();

    await act(async () => resolveTaskRefs({ data: gitRefs }));
    expect(screen.queryByRole('link', { name: /repository/i })).not.toBeInTheDocument();
    await act(async () => resolveOtherRefs({ data: [{ ...gitRefs[0], id: '88888888-8888-4888-8888-888888888888', taskId: otherTask.id, ref: 'other-task-ref' }] }));
    expect(await screen.findByRole('link', { name: /other-task-ref/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /repository/i })).not.toBeInTheDocument();
  });

  it('does not create external links from unsafe stored URLs', async () => {
    const unsafeRef = {
      ...gitRefs[0],
      url: 'https://user:password@example.test/repository?token=secret',
      ref: 'untrusted ref label',
    };
    api.get.mockImplementation((url: string) => {
      if (url.endsWith('/git-refs')) return Promise.resolve({ data: [unsafeRef] });
      if (url.startsWith('/tasks/')) {
        return Promise.resolve({ data: { data: [], total: 0, page: 1, limit: 20 } });
      }
      return Promise.reject(new Error('unexpected request'));
    });
    render(
      <QueryClientProvider client={client}>
        <TaskDetail task={task} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Reference link unavailable');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText(/password|token=secret/i)).not.toBeInTheDocument();
  });

  it('renders stored labels as text rather than interpreting markup', async () => {
    const untrustedLabel = '<img src=x onerror=alert(1)>';
    api.get.mockImplementation((url: string) => {
      if (url.endsWith('/git-refs')) {
        return Promise.resolve({ data: [{ ...gitRefs[0], ref: untrustedLabel }] });
      }
      if (url.startsWith('/tasks/')) {
        return Promise.resolve({ data: { data: [], total: 0, page: 1, limit: 20 } });
      }
      return Promise.reject(new Error('unexpected request'));
    });
    render(
      <QueryClientProvider client={client}>
        <TaskDetail task={task} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('link', { name: untrustedLabel })).toHaveAttribute(
      'href',
      gitRefs[0].url,
    );
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
