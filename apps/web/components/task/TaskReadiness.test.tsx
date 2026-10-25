import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import apiClient from '@/lib/api/client';
import type { Task } from '@/lib/api/tasks';
import { TaskDetail } from './TaskDetail';
import { TaskReadiness } from './TaskReadiness';

vi.mock('./TaskChecklist', () => ({ TaskChecklist: () => null }));
vi.mock('./TaskDependencies', () => ({ TaskDependencies: () => null }));
vi.mock('./AuditLog', () => ({ AuditLog: () => null }));
vi.mock('./TaskGitRefs', () => ({ TaskGitRefs: () => null }));

const taskId = '11111111-1111-4111-8111-111111111111';
const otherTaskId = '22222222-2222-4222-8222-222222222222';
const edgeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const queryClients: QueryClient[] = [];
const task: Task = {
  id: taskId,
  title: 'Readiness task',
  status: 'todo',
  priority: 'medium',
  projectId: '33333333-3333-4333-8333-333333333333',
  actorType: 'human',
  createdAt: '2026-10-24T00:00:00.000Z',
  updatedAt: '2026-10-24T00:00:00.000Z',
};

function renderReadiness(id = taskId) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClients.push(queryClient);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TaskReadiness taskId={id} />
    </QueryClientProvider>,
  );
  return { ...view, rerenderTask: (nextId: string) => view.rerender(
    <QueryClientProvider client={queryClient}>
      <TaskReadiness taskId={nextId} />
    </QueryClientProvider>,
  ) };
}

function readiness(overrides: Record<string, unknown> = {}) {
  return { taskId, dependencyCount: 0, blockedBy: [], ready: true, ...overrides };
}

function blocker(overrides: Record<string, unknown> = {}) {
  return {
    id: edgeId,
    type: 'depends_on',
    direction: 'outgoing',
    fromTaskId: taskId,
    toTaskId: otherTaskId,
    otherTaskId,
    otherTaskTitle: 'Release prerequisite',
    otherTaskStatus: 'in_progress',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  queryClients.splice(0).forEach((queryClient) => queryClient.clear());
  vi.restoreAllMocks();
});

describe('TaskDetail dependency readiness summary', () => {
  it('distinguishes no dependency edges from satisfied nonzero dependency edges', async () => {
    const get = vi.spyOn(apiClient, 'get');
    get.mockResolvedValueOnce({ data: readiness() } as never);
    const empty = renderReadiness();
    expect(await screen.findByText('Ready: no dependency links.')).toBeInTheDocument();
    expect(screen.getByText('Ready (dependencies)')).toBeInTheDocument();
    empty.unmount();

    get.mockResolvedValueOnce({ data: readiness({ dependencyCount: 3 }) } as never);
    renderReadiness();
    expect(await screen.findByText('Ready: no blocking dependencies among 3 dependency links.')).toBeInTheDocument();
  });

  it('loads the server readiness summary from task detail', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness({ dependencyCount: 2 }),
    } as never);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClients.push(queryClient);
    render(
      <QueryClientProvider client={queryClient}>
        <TaskDetail task={task} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Ready: no blocking dependencies among 2 dependency links.')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(`/tasks/${taskId}/readiness`);
  });

  it('shows only server-returned blockers and their counterpart status', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness({ ready: false, dependencyCount: 2, blockedBy: [blocker()] }),
    } as never);
    renderReadiness();

    expect(await screen.findByText('1 of 2 dependency links are blocking this task.')).toBeInTheDocument();
    expect(screen.getByText('Release prerequisite')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
  });

  it('keeps readiness unknown while loading or when the request fails', async () => {
    let rejectRequest: ((reason: Error) => void) | undefined;
    const get = vi.spyOn(apiClient, 'get').mockReturnValueOnce(
      new Promise((_, reject) => { rejectRequest = reject; }) as never,
    );
    const view = renderReadiness();
    expect(screen.getByText('Dependency readiness is unknown while it loads.')).toBeInTheDocument();
    expect(screen.queryByText('Ready (dependencies)')).not.toBeInTheDocument();

    await act(async () => rejectRequest?.(new Error('synthetic read failure')));
    expect(await screen.findByText('Dependency readiness is unavailable.')).toBeInTheDocument();
    expect(screen.queryByText('Ready (dependencies)')).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(`/tasks/${taskId}/readiness`);
    view.unmount();
  });

  it('lets the user retry an unavailable readiness read and uses the server result', async () => {
    let resolveRetry: ((value: unknown) => void) | undefined;
    const get = vi.spyOn(apiClient, 'get')
      .mockRejectedValueOnce(new Error('synthetic transient failure'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }) as never);
    renderReadiness();

    expect(await screen.findByText('Dependency readiness is unavailable.')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Retry dependency readiness' });
    fireEvent.click(retry);
    expect(await screen.findByText('Dependency readiness is unknown while it loads.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry dependency readiness' })).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(2);

    await act(async () => resolveRetry?.({ data: readiness({ dependencyCount: 2 }) }));
    expect(await screen.findByText('Ready: no blocking dependencies among 2 dependency links.')).toBeInTheDocument();
    expect(screen.queryByText('Dependency readiness is unavailable.')).not.toBeInTheDocument();
    expect(get.mock.calls.map(([url]) => url)).toEqual([
      `/tasks/${taskId}/readiness`,
      `/tasks/${taskId}/readiness`,
    ]);
  });

  it('does not show a prior task result when its readiness retry settles after a task switch', async () => {
    let taskCalls = 0;
    let resolveRetry: ((value: unknown) => void) | undefined;
    const get = vi.spyOn(apiClient, 'get').mockImplementation((url) => {
      if (url === `/tasks/${taskId}/readiness`) {
        taskCalls += 1;
        if (taskCalls === 1) return Promise.reject(new Error('synthetic transient failure')) as never;
        return new Promise((resolve) => { resolveRetry = resolve; }) as never;
      }
      if (url === `/tasks/${otherTaskId}/readiness`) {
        return Promise.resolve({ data: readiness({ taskId: otherTaskId, dependencyCount: 0 }) }) as never;
      }
      throw new Error(`unexpected request ${url}`);
    });
    const view = renderReadiness();

    expect(await screen.findByText('Dependency readiness is unavailable.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry dependency readiness' }));
    expect(await screen.findByText('Dependency readiness is unknown while it loads.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry dependency readiness' })).not.toBeInTheDocument();

    view.rerenderTask(otherTaskId);
    expect(await screen.findByText('Ready: no dependency links.')).toBeInTheDocument();
    await act(async () => resolveRetry?.({
      data: readiness({ ready: false, dependencyCount: 1, blockedBy: [blocker()] }),
    }));

    expect(screen.getByText('Ready: no dependency links.')).toBeInTheDocument();
    expect(screen.queryByText('Release prerequisite')).not.toBeInTheDocument();
    expect(get.mock.calls.map(([url]) => url)).toEqual([
      `/tasks/${taskId}/readiness`,
      `/tasks/${taskId}/readiness`,
      `/tasks/${otherTaskId}/readiness`,
    ]);
  });

  it.each([
    ['mismatched task response', readiness({ taskId: otherTaskId })],
    ['missing readiness field', { taskId, dependencyCount: 0, blockedBy: [] }],
    ['mismatched blocker counterpart', readiness({
      ready: false, dependencyCount: 1, blockedBy: [blocker({ otherTaskId: taskId })],
    })],
  ])('does not render readiness for a %s', async (_label, data) => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ data } as never);
    renderReadiness();

    expect(await screen.findByText('Dependency readiness is unavailable.')).toBeInTheDocument();
    expect(screen.queryByText('Ready (dependencies)')).not.toBeInTheDocument();
    expect(screen.queryByText(/no blocking dependencies/)).not.toBeInTheDocument();
  });

  it('rejects a ready response that contains blockers instead of inferring around it', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness({ dependencyCount: 1, blockedBy: [blocker()] }),
    } as never);
    renderReadiness();

    expect(await screen.findByText('Dependency readiness is unavailable.')).toBeInTheDocument();
    expect(screen.queryByText('Ready (dependencies)')).not.toBeInTheDocument();
  });

  it('isolates the query by task when the detail route changes during a pending read', async () => {
    let resolveOld: ((value: unknown) => void) | undefined;
    const get = vi.spyOn(apiClient, 'get').mockImplementation((url) => {
      if (url === `/tasks/${taskId}/readiness`) {
        return new Promise((resolve) => { resolveOld = resolve; }) as never;
      }
      if (url === `/tasks/${otherTaskId}/readiness`) {
        return Promise.resolve({ data: readiness({ taskId: otherTaskId, dependencyCount: 0 }) }) as never;
      }
      throw new Error(`unexpected request ${url}`);
    });
    const view = renderReadiness();
    expect(screen.getByText('Dependency readiness is unknown while it loads.')).toBeInTheDocument();

    view.rerenderTask(otherTaskId);
    expect(await screen.findByText('Ready: no dependency links.')).toBeInTheDocument();
    await act(async () => resolveOld?.({ data: readiness({ taskId, ready: false, dependencyCount: 1, blockedBy: [blocker()] }) }));
    await waitFor(() => expect(screen.getByText('Ready: no dependency links.')).toBeInTheDocument());
    expect(screen.queryByText('Release prerequisite')).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(`/tasks/${taskId}/readiness`);
    expect(get).toHaveBeenCalledWith(`/tasks/${otherTaskId}/readiness`);
  });
});
