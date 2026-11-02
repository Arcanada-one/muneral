import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import apiClient from '@/lib/api/client';
import { TaskReadiness } from './TaskReadiness';

const taskId = '11111111-1111-4111-8111-111111111111';
const otherTaskId = '22222222-2222-4222-8222-222222222222';
const firstBlockerTaskId = '33333333-3333-4333-8333-333333333333';
const secondBlockerTaskId = '44444444-4444-4444-8444-444444444444';
const queryClients: QueryClient[] = [];

function readiness(
  id = taskId,
  blockedBy: Array<Record<string, unknown>> = [],
  dependencyCount = blockedBy.length,
) {
  return {
    taskId: id,
    dependencyCount,
    ready: blockedBy.length === 0,
    blockedBy,
  };
}

function blocker(
  id: string,
  sourceTaskId: string,
  otherId: string,
  title: string,
  withheld = false,
) {
  return {
    id,
    type: 'depends_on',
    direction: 'outgoing',
    fromTaskId: sourceTaskId,
    toTaskId: otherId,
    otherTaskId: otherId,
    otherTaskTitle: title,
    ...(withheld ? { otherTaskTitleWithheld: true } : {}),
    otherTaskStatus: 'in_progress',
  };
}

function renderReadiness(id = taskId) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClients.push(queryClient);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TaskReadiness taskId={id} />
    </QueryClientProvider>,
  );

  return {
    ...view,
    queryClient,
    rerenderTask: (nextId: string) => view.rerender(
      <QueryClientProvider client={queryClient}>
        <TaskReadiness taskId={nextId} />
      </QueryClientProvider>,
    ),
  };
}

function findParagraph(text: string) {
  return screen.findByText((_, element) => element?.tagName === 'P' && element.textContent === text);
}

afterEach(() => {
  cleanup();
  queryClients.splice(0).forEach((queryClient) => queryClient.clear());
  vi.restoreAllMocks();
});

describe('TaskReadiness blocker disclosure', () => {
  it('collapses only blocker rows, preserves their order and summary, and performs no extra request', async () => {
    const rows = [
      blocker('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', taskId, firstBlockerTaskId, 'First blocker', true),
      blocker('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', taskId, secondBlockerTaskId, 'Second blocker'),
    ];
    const get = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness(taskId, rows, 3),
    } as never);
    const mutations = [
      vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('unexpected mutation')),
      vi.spyOn(apiClient, 'put').mockRejectedValue(new Error('unexpected mutation')),
      vi.spyOn(apiClient, 'patch').mockRejectedValue(new Error('unexpected mutation')),
      vi.spyOn(apiClient, 'delete').mockRejectedValue(new Error('unexpected mutation')),
    ];
    renderReadiness();

    expect(await findParagraph('2 of 3 dependency links are blocking this task.')).toBeInTheDocument();
    const hideButton = screen.getByRole('button', { name: 'Hide blocking tasks' });
    expect(hideButton).toHaveAttribute('aria-expanded', 'true');
    const listId = hideButton.getAttribute('aria-controls');
    expect(listId).toBeTruthy();
    const blockerList = document.getElementById(listId as string);
    expect(blockerList).toBeInTheDocument();
    expect(blockerList).toBeVisible();
    expect(within(blockerList as HTMLElement).getAllByText('In Progress', { exact: true })).toHaveLength(2);
    expect(within(blockerList as HTMLElement).getAllByRole('listitem')).toHaveLength(2);
    expect(within(blockerList as HTMLElement).getByText(firstBlockerTaskId)).toBeVisible();
    expect(within(blockerList as HTMLElement).queryByText('First blocker')).not.toBeInTheDocument();
    expect(within(blockerList as HTMLElement).getAllByText('In Progress')).toHaveLength(2);
    const rowOrder = () => within(blockerList as HTMLElement).getAllByRole('listitem').map((item) =>
      within(item).getByRole('button').getAttribute('aria-label'));
    expect(rowOrder()).toEqual([
      `Copy blocker task ID ${firstBlockerTaskId}`,
      `Copy blocker task ID ${secondBlockerTaskId}`,
    ]);

    fireEvent.click(hideButton);
    const showButton = screen.getByRole('button', { name: 'Show blocking tasks' });
    expect(showButton).toHaveAttribute('aria-expanded', 'false');
    expect(showButton).toHaveAttribute('aria-controls', listId);
    expect(blockerList).not.toBeVisible();
    expect(screen.getByText((_, element) => element?.tagName === 'P' && element.textContent === '2 of 3 dependency links are blocking this task.')).toBeInTheDocument();
    expect(within(blockerList as HTMLElement).getAllByText('In Progress', { exact: true })).toHaveLength(2);

    fireEvent.click(showButton);
    expect(screen.getByRole('button', { name: 'Hide blocking tasks' })).toHaveAttribute('aria-expanded', 'true');
    expect(blockerList).toBeVisible();
    expect(rowOrder()).toEqual([
      `Copy blocker task ID ${firstBlockerTaskId}`,
      `Copy blocker task ID ${secondBlockerTaskId}`,
    ]);
    expect(within(blockerList as HTMLElement).getByText('Second blocker')).toBeVisible();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(`/tasks/${taskId}/readiness`);
    mutations.forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
  });

  it('preserves the same-task selection across empty and nonempty blocker data refreshes', async () => {
    const rows = [blocker('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', taskId, firstBlockerTaskId, 'First blocker')];
    const get = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ data: readiness(taskId, rows) } as never);
    const view = renderReadiness();
    expect(await screen.findByRole('button', { name: 'Hide blocking tasks' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide blocking tasks' }));

    await act(async () => {
      view.queryClient.setQueryData(['tasks', taskId, 'readiness'], readiness(taskId));
    });
    expect(await findParagraph('Ready: no dependency links.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hide blocking tasks' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show blocking tasks' })).not.toBeInTheDocument();

    await act(async () => {
      view.queryClient.setQueryData(['tasks', taskId, 'readiness'], readiness(taskId, rows));
    });
    const showButton = await screen.findByRole('button', { name: 'Show blocking tasks' });
    expect(showButton).toHaveAttribute('aria-expanded', 'false');
    const blockerList = document.getElementById(showButton.getAttribute('aria-controls') as string);
    expect(blockerList).toBeInTheDocument();
    expect(blockerList).not.toBeVisible();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('resets to expanded on each effective task identity change', async () => {
    const firstRows = [blocker('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', taskId, firstBlockerTaskId, 'First task blocker')];
    const secondRows = [blocker('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', otherTaskId, secondBlockerTaskId, 'Second task blocker')];
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async (url) => {
      if (url === `/tasks/${taskId}/readiness`) return { data: readiness(taskId, firstRows) } as never;
      if (url === `/tasks/${otherTaskId}/readiness`) return { data: readiness(otherTaskId, secondRows) } as never;
      throw new Error(`unexpected readiness request: ${url}`);
    });
    const view = renderReadiness();
    expect(await screen.findByRole('button', { name: 'Hide blocking tasks' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide blocking tasks' }));
    expect(screen.getByRole('button', { name: 'Show blocking tasks' })).toBeInTheDocument();

    view.rerenderTask(otherTaskId);
    expect(await screen.findByText('Second task blocker')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Hide blocking tasks' })).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Hide blocking tasks' }));
    view.rerenderTask(taskId);
    expect(await screen.findByText('First task blocker')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Hide blocking tasks' })).toHaveAttribute('aria-expanded', 'true');
    expect(get.mock.calls.map(([url]) => url)).toContain(`/tasks/${otherTaskId}/readiness`);
  });

  it('offers no disclosure control while loading, on read failure, or for ready data', async () => {
    let resolveLoading: ((value: unknown) => void) | undefined;
    const get = vi.spyOn(apiClient, 'get')
      .mockImplementationOnce(() => new Promise((resolve) => { resolveLoading = resolve; }) as never)
      .mockRejectedValueOnce(new Error('synthetic readiness failure'))
      .mockResolvedValueOnce({ data: readiness(taskId) } as never);

    const noTask = renderReadiness('');
    expect(screen.getByText('Dependency readiness is unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /blocking tasks/ })).not.toBeInTheDocument();
    noTask.unmount();
    expect(get).not.toHaveBeenCalled();

    const loading = renderReadiness();
    expect(screen.getByText('Dependency readiness is unknown while it loads.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /blocking tasks/ })).not.toBeInTheDocument();
    await act(async () => resolveLoading?.({ data: readiness(taskId) }));
    loading.unmount();

    const error = renderReadiness(otherTaskId);
    expect(await screen.findByText('Dependency readiness is unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /blocking tasks/ })).not.toBeInTheDocument();
    error.unmount();

    renderReadiness();
    expect(await screen.findByText('Ready: no dependency links.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /blocking tasks/ })).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('keeps cached-read failure recovery separate from blocker disclosure', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClients.push(queryClient);
    queryClient.setQueryData(
      ['tasks', taskId, 'readiness'],
      readiness(taskId, [blocker('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', taskId, firstBlockerTaskId, 'Cached blocker')]),
    );
    const get = vi.spyOn(apiClient, 'get').mockRejectedValueOnce(new Error('synthetic background read failure'));
    render(
      <QueryClientProvider client={queryClient}>
        <TaskReadiness taskId={taskId} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Dependency readiness is unavailable.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry dependency readiness' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /blocking tasks/ })).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(`/tasks/${taskId}/readiness`);
  });
});
