import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import apiClient from '@/lib/api/client';
import { TaskDependencies } from './TaskDependencies';

const taskId = '11111111-1111-4111-8111-111111111111';
const secondTaskId = '99999999-9999-4999-8999-999999999999';
const incomingId = '22222222-2222-4222-8222-222222222222';
const outgoingId = '33333333-3333-4333-8333-333333333333';
const secondOutgoingId = '44444444-4444-4444-8444-444444444444';

const graph = [
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    type: 'depends_on',
    direction: 'outgoing',
    fromTaskId: taskId,
    toTaskId: outgoingId,
    otherTaskId: outgoingId,
    otherTaskTitle: 'Outgoing dependency',
    otherTaskStatus: 'todo',
  },
  {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    type: 'blocks',
    direction: 'incoming',
    fromTaskId: incomingId,
    toTaskId: taskId,
    otherTaskId: incomingId,
    otherTaskTitle: 'Incoming dependency',
    otherTaskStatus: 'in_progress',
  },
];

function renderDependencies(currentTaskId = taskId) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const renderForTask = (id: string) => (
    <QueryClientProvider client={queryClient}>
      <TaskDependencies taskId={id} />
    </QueryClientProvider>
  );
  const view = render(renderForTask(currentTaskId));
  return { ...view, queryClient, rerenderTask: (id: string) => view.rerender(renderForTask(id)) };
}

function directionSelect() {
  return screen.getByRole('combobox', { name: 'Dependency direction' });
}

function loadedCount() {
  return screen.getByText(/Showing/);
}

beforeEach(() => {
  vi.spyOn(apiClient, 'get').mockResolvedValue({ data: graph } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('task dependency direction filter', () => {
  it('defaults to all loaded dependencies in their original order and reports the full count', async () => {
    renderDependencies();

    const select = await screen.findByRole('combobox', { name: 'Dependency direction' });
    expect(select).toHaveValue('all');
    expect(Array.from((select as HTMLSelectElement).options).map((option) => option.text)).toEqual([
      'All dependencies',
      'Incoming',
      'Outgoing',
    ]);
    expect(loadedCount()).toHaveTextContent('Showing 2 of 2 loaded dependencies.');
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Outgoing dependency');
    expect(rows[1]).toHaveTextContent('Incoming dependency');
  });

  it('filters to incoming and outgoing rows, reports the subset count, and restores the original order', async () => {
    renderDependencies();
    const select = await screen.findByRole('combobox', { name: 'Dependency direction' });

    fireEvent.change(select, { target: { value: 'incoming' } });
    expect(loadedCount()).toHaveTextContent('Showing 1 of 2 loaded dependencies.');
    expect(screen.getByText('Incoming dependency')).toBeInTheDocument();
    expect(screen.queryByText('Outgoing dependency')).not.toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'outgoing' } });
    expect(screen.getByText('Outgoing dependency')).toBeInTheDocument();
    expect(screen.queryByText('Incoming dependency')).not.toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'all' } });
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('Outgoing dependency'),
      expect.stringContaining('Incoming dependency'),
    ]));
    expect(rows[0]).toHaveTextContent('Outgoing dependency');
    expect(rows[1]).toHaveTextContent('Incoming dependency');
  });

  it('distinguishes a loaded filter-empty result from loading, errors, and a loaded-empty graph', async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: [graph[1]] } as never);
    const filtered = renderDependencies();
    const select = await screen.findByRole('combobox', { name: 'Dependency direction' });
    fireEvent.change(select, { target: { value: 'outgoing' } });
    expect(screen.getByText(/No matching dependencies in the loaded list\./)).toBeInTheDocument();
    expect(screen.getByText(/Choose All dependencies/)).toBeInTheDocument();
    expect(loadedCount()).toHaveTextContent('Showing 0 of 1 loaded dependencies.');
    filtered.unmount();
    filtered.queryClient.clear();

    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: [] } as never);
    const empty = renderDependencies('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('combobox', { name: 'Dependency direction' })).not.toBeInTheDocument();
    empty.unmount();
    empty.queryClient.clear();

    vi.mocked(apiClient.get).mockRejectedValueOnce(new Error('private failure detail'));
    renderDependencies('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    expect(await screen.findByRole('alert')).toHaveTextContent('Dependencies are unavailable.');
    expect(screen.queryByRole('combobox', { name: 'Dependency direction' })).not.toBeInTheDocument();
    expect(screen.queryByText('private failure detail')).not.toBeInTheDocument();
  });

  it('resets the effective selection when task identity changes and preserves it on same-task refresh', async () => {
    const view = renderDependencies();
    const select = await screen.findByRole('combobox', { name: 'Dependency direction' });
    fireEvent.change(select, { target: { value: 'incoming' } });

    view.queryClient.setQueryData(['tasks', taskId, 'dependency-graph'], [
      ...graph,
      { ...graph[0], id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', otherTaskTitle: 'Refreshed outgoing dependency' },
    ]);
    expect(directionSelect()).toHaveValue('incoming');
    await waitFor(() => expect(loadedCount()).toHaveTextContent('Showing 1 of 3 loaded dependencies.'));
    expect(screen.getByText('Incoming dependency')).toBeInTheDocument();

    vi.mocked(apiClient.get).mockImplementation(async (url) => ({
      data: url === `/tasks/${secondTaskId}/dependency-graph`
        ? [{ ...graph[0], id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', fromTaskId: secondTaskId, toTaskId: secondOutgoingId, otherTaskId: secondOutgoingId, otherTaskTitle: 'Second task dependency' }]
        : graph,
    }) as never);
    view.rerenderTask(secondTaskId);

    expect(await screen.findByText('Second task dependency')).toBeInTheDocument();
    expect(directionSelect()).toHaveValue('all');
    expect(loadedCount()).toHaveTextContent('Showing 1 of 1 loaded dependencies.');
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('does not issue additional reads or mutations when changing direction', async () => {
    const get = vi.mocked(apiClient.get);
    const post = vi.spyOn(apiClient, 'post');
    const patch = vi.spyOn(apiClient, 'patch');
    const put = vi.spyOn(apiClient, 'put');
    const deleteRequest = vi.spyOn(apiClient, 'delete');
    renderDependencies();
    const select = await screen.findByRole('combobox', { name: 'Dependency direction' });
    expect(get).toHaveBeenCalledTimes(1);

    fireEvent.change(select, { target: { value: 'incoming' } });
    fireEvent.change(select, { target: { value: 'outgoing' } });
    fireEvent.change(select, { target: { value: 'all' } });

    expect(get).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(deleteRequest).not.toHaveBeenCalled();
  });

  it('does not offer a filter before data is loaded', () => {
    vi.mocked(apiClient.get).mockImplementationOnce(() => new Promise(() => {}));
    renderDependencies();

    expect(screen.getByRole('status')).toHaveTextContent('Loading dependencies…');
    expect(screen.queryByRole('combobox', { name: 'Dependency direction' })).not.toBeInTheDocument();
  });
});
