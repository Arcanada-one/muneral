import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import apiClient from '@/lib/api/client';
import { TaskReadiness } from './TaskReadiness';

const taskId = '11111111-1111-4111-8111-111111111111';
const otherTaskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const queryClients: QueryClient[] = [];

function blocker(id: string, otherTaskId: string, title: string, status: string, sourceTaskId = taskId) {
  return {
    id,
    type: 'depends_on',
    direction: 'outgoing',
    fromTaskId: sourceTaskId,
    toTaskId: otherTaskId,
    otherTaskId,
    otherTaskTitle: title,
    otherTaskStatus: status,
  };
}

function readiness(
  id = taskId,
  blockedBy: Array<Record<string, unknown>> = [],
  dependencyCount = blockedBy.length,
  ready = blockedBy.length === 0,
) {
  return { taskId: id, dependencyCount, ready, blockedBy };
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

function summaryItems() {
  return within(screen.getByRole('group', { name: 'Filtered blocker statuses' }))
    .getByRole('list', { name: 'Filtered blocker status counts' });
}

afterEach(() => {
  cleanup();
  queryClients.splice(0).forEach((queryClient) => queryClient.clear());
  vi.restoreAllMocks();
});

describe('TaskReadiness filtered loaded blocker status counts', () => {
  it('counts filtered blocker edges including duplicates, hides raw unknown statuses, and ignores reverse and collapse', async () => {
    const repeatedTask = '00000000-0000-4000-8000-000000000001';
    const rows = [
      blocker('00000000-0000-4000-8000-000000000101', repeatedTask, 'Needle todo', 'todo'),
      blocker('00000000-0000-4000-8000-000000000102', repeatedTask, 'Needle progress', 'in_progress'),
      blocker('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000003', 'Needle review', 'review'),
      blocker('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000004', 'Needle blocked', 'blocked'),
      blocker('00000000-0000-4000-8000-000000000105', repeatedTask, 'Needle duplicate', 'todo'),
      blocker('00000000-0000-4000-8000-000000000106', '00000000-0000-4000-8000-000000000006', 'Needle unknown', 'future_status'),
      blocker('00000000-0000-4000-8000-000000000107', '00000000-0000-4000-8000-000000000007', 'Other review', 'review'),
    ];
    const get = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ data: readiness(taskId, rows, 9, false) } as never);
    const mutations = [
      vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('unexpected mutation')),
      vi.spyOn(apiClient, 'put').mockRejectedValue(new Error('unexpected mutation')),
      vi.spyOn(apiClient, 'patch').mockRejectedValue(new Error('unexpected mutation')),
      vi.spyOn(apiClient, 'delete').mockRejectedValue(new Error('unexpected mutation')),
    ];
    renderReadiness();

    await screen.findByRole('group', { name: 'Filtered blocker statuses' });
    expect(within(summaryItems()).getAllByRole('listitem').map((item) => item.textContent))
      .toEqual(['To Do 2', 'In Progress 1', 'Review 2', 'Blocked 1', 'Other 1']);
    expect(screen.queryByText('future_status')).not.toBeInTheDocument();
    expect(screen.getByText('Counts of filtered loaded blocker edges:')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Blocker status' }), { target: { value: 'review' } });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded blockers' }), { target: { value: 'needle' } });
    expect(within(summaryItems()).getAllByRole('listitem').map((item) => item.textContent))
      .toEqual(['To Do 0', 'In Progress 0', 'Review 1', 'Blocked 0']);

    const filteredCounts = within(summaryItems()).getAllByRole('listitem').map((item) => item.textContent);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Reverse loaded blocker order' }));
    expect(within(summaryItems()).getAllByRole('listitem').map((item) => item.textContent)).toEqual(filteredCounts);
    fireEvent.click(screen.getByRole('button', { name: 'Hide blocking tasks' }));
    expect(screen.getByRole('group', { name: 'Filtered blocker statuses' })).toBeVisible();
    expect(screen.getByText('Counts of filtered loaded blocker edges:')).toBeVisible();
    expect(document.getElementById(`task-readiness-${taskId}-blockers`)).toHaveAttribute('hidden');
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(`/tasks/${taskId}/readiness`);
    mutations.forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
  });

  it('recomputes through same-task refresh, empty and A-B-A without stale counts or extra reads', async () => {
    const rowA = [blocker('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000011', 'A review', 'review')];
    const rowB = [blocker('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000012', 'B todo', 'todo', otherTaskId)];
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async (url) => {
      if (url === `/tasks/${taskId}/readiness`) return { data: readiness(taskId, rowA, 1, false) } as never;
      if (url === `/tasks/${otherTaskId}/readiness`) return { data: readiness(otherTaskId, rowB, 1, false) } as never;
      throw new Error(`unexpected readiness request: ${url}`);
    });
    const mutations = [
      vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('unexpected mutation')),
      vi.spyOn(apiClient, 'put').mockRejectedValue(new Error('unexpected mutation')),
      vi.spyOn(apiClient, 'patch').mockRejectedValue(new Error('unexpected mutation')),
      vi.spyOn(apiClient, 'delete').mockRejectedValue(new Error('unexpected mutation')),
    ];
    const view = renderReadiness();
    await screen.findByRole('group', { name: 'Filtered blocker statuses' });
    expect(within(summaryItems()).getAllByRole('listitem').map((item) => item.textContent))
      .toEqual(['To Do 0', 'In Progress 0', 'Review 1', 'Blocked 0']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Blocker status' }), { target: { value: 'review' } });

    await act(async () => {
      view.queryClient.setQueryData(['tasks', taskId, 'readiness'], readiness(taskId));
    });
    expect(await screen.findByText('Ready: no dependency links.')).toBeVisible();
    expect(screen.queryByRole('group', { name: 'Filtered blocker statuses' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Blocker status' })).not.toBeInTheDocument();

    await act(async () => {
      view.queryClient.setQueryData(['tasks', taskId, 'readiness'], readiness(taskId, rowA, 3, false));
    });
    await screen.findByText('Review 1');
    expect(within(summaryItems()).getAllByRole('listitem').map((item) => item.textContent))
      .toEqual(['To Do 0', 'In Progress 0', 'Review 1', 'Blocked 0']);
    fireEvent.change(screen.getByRole('combobox', { name: 'Blocker status' }), { target: { value: 'blocked' } });
    await screen.findByText('Review 0');
    expect(within(summaryItems()).getAllByRole('listitem').map((item) => item.textContent))
      .toEqual(['To Do 0', 'In Progress 0', 'Review 0', 'Blocked 0']);

    view.rerenderTask(otherTaskId);
    await screen.findByText('B todo');
    expect(within(summaryItems()).getAllByRole('listitem').map((item) => item.textContent))
      .toEqual(['To Do 1', 'In Progress 0', 'Review 0', 'Blocked 0']);
    view.rerenderTask(taskId);
    await screen.findByText('A review');
    expect(within(summaryItems()).getAllByRole('listitem').map((item) => item.textContent))
      .toEqual(['To Do 0', 'In Progress 0', 'Review 1', 'Blocked 0']);
    expect(screen.getByRole('combobox', { name: 'Blocker status' })).toHaveValue('all');
    expect(get.mock.calls.map(([url]) => url)).toEqual([
      `/tasks/${taskId}/readiness`,
      `/tasks/${otherTaskId}/readiness`,
      `/tasks/${taskId}/readiness`,
    ]);
    mutations.forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
  });

  it('does not show the summary while loading, after error, or for ready data', async () => {
    let rejectRequest: ((error: Error) => void) | undefined;
    const get = vi.spyOn(apiClient, 'get').mockImplementationOnce(() => new Promise((_, reject) => {
      rejectRequest = reject;
    }));
    const view = renderReadiness();
    expect(screen.queryByRole('group', { name: 'Filtered blocker statuses' })).not.toBeInTheDocument();
    await act(async () => {
      rejectRequest?.(new Error('offline'));
    });
    await screen.findByText('Dependency readiness is unavailable.');
    expect(screen.queryByRole('group', { name: 'Filtered blocker statuses' })).not.toBeInTheDocument();

    await act(async () => {
      view.queryClient.setQueryData(['tasks', taskId, 'readiness'], readiness(taskId));
    });
    expect(await screen.findByText('Ready: no dependency links.')).toBeVisible();
    expect(screen.queryByRole('group', { name: 'Filtered blocker statuses' })).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);
  });
});
