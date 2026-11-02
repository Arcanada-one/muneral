import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import apiClient from '@/lib/api/client';
import { TaskDependencies } from './TaskDependencies';

const taskId = '11111111-1111-4111-8111-111111111111';
const nextTaskId = '99999999-9999-4999-8999-999999999999';
const otherIds = [
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
  '77777777-7777-4777-8777-777777777777',
];

type DependencyFixture = {
  id: string;
  type: string;
  direction: 'incoming' | 'outgoing';
  fromTaskId: string;
  toTaskId: string;
  otherTaskId: string;
  otherTaskTitle: string | null;
  otherTaskTitleWithheld?: boolean;
  otherTaskStatus?: string;
};

function dependency(
  id: string,
  otherTaskId: string,
  title: string,
  status: string | undefined,
  direction: 'incoming' | 'outgoing',
): DependencyFixture {
  const row: DependencyFixture = {
    id,
    type: 'depends_on',
    direction,
    fromTaskId: direction === 'outgoing' ? taskId : otherTaskId,
    toTaskId: direction === 'outgoing' ? otherTaskId : taskId,
    otherTaskId,
    otherTaskTitle: title,
  };
  if (status !== undefined) row.otherTaskStatus = status;
  return row;
}

const graph: DependencyFixture[] = [
  dependency('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', otherIds[0], 'Completed incoming', 'done', 'incoming'),
  dependency('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', otherIds[1], 'Open outgoing', 'todo', 'outgoing'),
  dependency('cccccccc-cccc-4ccc-8ccc-cccccccccccc', otherIds[2], 'Unknown status incoming', 'future_state', 'incoming'),
  dependency('dddddddd-dddd-4ddd-8ddd-dddddddddddd', otherIds[3], 'Unrecognized status outgoing', 'future_status', 'outgoing'),
  dependency('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', otherIds[4], 'Cancelled incoming', 'cancelled', 'incoming'),
  dependency('ffffffff-ffff-4fff-8fff-ffffffffffff', otherIds[5], 'Archived outgoing', 'archived', 'outgoing'),
];

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function renderDependencies(currentTaskId = taskId, initialGraph?: DependencyFixture[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (initialGraph) {
    queryClient.setQueryData(['tasks', currentTaskId, 'dependency-graph'], initialGraph);
  }
  const renderForTask = (id: string) => (
    <QueryClientProvider client={queryClient}>
      <TaskDependencies taskId={id} />
    </QueryClientProvider>
  );
  const view = render(renderForTask(currentTaskId));
  return {
    ...view,
    queryClient,
    rerenderTask: (id: string) => view.rerender(renderForTask(id)),
  };
}

function visibleTitles() {
  return screen.getAllByRole('listitem').map((row) => (
    ['Completed incoming', 'Open outgoing', 'Unknown status incoming', 'Unrecognized status outgoing',
      'Cancelled incoming', 'Archived outgoing']
      .find((title) => row.textContent?.includes(title)) ?? ''
  ));
}

beforeEach(() => {
  vi.spyOn(apiClient, 'get').mockResolvedValue({ data: graph } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

describe('loaded dependency completed filter', () => {
  it('hides only exact done status and preserves every other status and loaded order', async () => {
    const mutationSpies = [
      vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('unexpected dependency mutation')),
      vi.spyOn(apiClient, 'put').mockRejectedValue(new Error('unexpected dependency mutation')),
      vi.spyOn(apiClient, 'patch').mockRejectedValue(new Error('unexpected dependency mutation')),
      vi.spyOn(apiClient, 'delete').mockRejectedValue(new Error('unexpected dependency mutation')),
    ];
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    const initialUrl = window.location.href;
    const pushState = vi.spyOn(window.history, 'pushState').mockImplementation(() => {});
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});

    renderDependencies();

    const filter = await screen.findByRole('checkbox', { name: 'Hide completed dependencies' });
    expect(filter).not.toBeChecked();
    expect(screen.getByText('Showing 6 of 6 loaded dependencies.')).toBeInTheDocument();

    fireEvent.click(filter);

    expect(screen.getByText('Showing 5 of 6 loaded dependencies.')).toBeInTheDocument();
    expect(visibleTitles()).toEqual([
      'Open outgoing',
      'Unknown status incoming',
      'Unrecognized status outgoing',
      'Cancelled incoming',
      'Archived outgoing',
    ]);
    expect(screen.queryByText('Completed incoming')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Hide completed dependencies' })).toBeChecked();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(mutationSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    expect(clipboardWrite).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(window.location.href).toBe(initialUrl);
  });

  it('keeps an already-loaded row with no counterpart status visible', () => {
    const missingStatus = dependency(
      '12121212-1212-4212-8212-121212121212',
      otherIds[0],
      'Missing status incoming',
      undefined,
      'incoming',
    );
    renderDependencies(taskId, [missingStatus]);

    expect(screen.getByText('Missing status incoming')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide completed dependencies' }));

    expect(screen.getByText('Missing status incoming')).toBeInTheDocument();
    expect(screen.getByText('Showing 1 of 1 loaded dependencies.')).toBeInTheDocument();
    expect(apiClient.get).not.toHaveBeenCalled();
  });

  it('combines the filter with direction and preserves loaded ordering and counts', async () => {
    renderDependencies();

    const direction = await screen.findByRole('combobox', { name: 'Dependency direction' });
    fireEvent.change(direction, { target: { value: 'incoming' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide completed dependencies' }));

    expect(screen.getByText('Showing 2 of 6 loaded dependencies.')).toBeInTheDocument();
    expect(visibleTitles()).toEqual(['Unknown status incoming', 'Cancelled incoming']);
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('offers loaded-list recovery when the combined filters remove every row', async () => {
    const doneIncoming = graph[0];
    const openOutgoing = graph[1];
    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: [doneIncoming, openOutgoing] } as never);
    renderDependencies();

    const direction = await screen.findByRole('combobox', { name: 'Dependency direction' });
    fireEvent.change(direction, { target: { value: 'incoming' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide completed dependencies' }));

    expect(screen.getByText('Showing 0 of 2 loaded dependencies.')).toBeInTheDocument();
    expect(screen.getByText(/No matching dependencies in the loaded list\./)).toHaveTextContent(
      'Clear Hide completed dependencies or choose All dependencies to show more.',
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide completed dependencies' }));
    expect(screen.getByText('Showing 1 of 2 loaded dependencies.')).toBeInTheDocument();
    expect(screen.getByText('Completed incoming')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Dependency direction' })).toHaveValue('incoming');
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('retains the choice during same-task data refresh and rematches current statuses', async () => {
    const initial = [graph[0], graph[1]];
    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: initial } as never);
    const view = renderDependencies();

    expect(await screen.findByText('Completed incoming')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide completed dependencies' }));
    expect(screen.queryByText('Completed incoming')).not.toBeInTheDocument();
    expect(screen.getByText('Open outgoing')).toBeInTheDocument();

    view.queryClient.setQueryData(['tasks', taskId, 'dependency-graph'], [
      { ...graph[0], otherTaskStatus: 'in_progress' },
      { ...graph[1], otherTaskStatus: 'done' },
    ]);
    await waitFor(() => expect(screen.getByText('Completed incoming')).toBeInTheDocument());
    expect(screen.queryByText('Open outgoing')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Hide completed dependencies' })).toBeChecked();
    expect(screen.getByText('Showing 1 of 2 loaded dependencies.')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('resets to unchecked on task change and preserves ID disclosure and copy behavior', async () => {
    const nextTaskGraph = [{ ...graph[0], fromTaskId: otherIds[0], toTaskId: nextTaskId }];
    vi.mocked(apiClient.get).mockImplementation(async (url) => ({
      data: url === `/tasks/${nextTaskId}/dependency-graph` ? nextTaskGraph : graph,
    }) as never);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const view = renderDependencies();

    expect(await screen.findByText('Completed incoming')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide completed dependencies' }));
    view.rerenderTask(nextTaskId);

    expect(await screen.findByText('Completed incoming')).toBeInTheDocument();
    const filter = screen.getByRole('checkbox', { name: 'Hide completed dependencies' });
    expect(filter).not.toBeChecked();
    expect(screen.getByText('Showing 1 of 1 loaded dependencies.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show full task ID' }));
    expect(screen.getByText(otherIds[0])).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `Copy task ID ${otherIds[0]}` }));
    expect(await screen.findByRole('status')).toHaveTextContent('Task ID copied.');
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(otherIds[0]);
    expect(apiClient.get).toHaveBeenCalledTimes(2);
  });

  it('keeps true-empty behavior without rendering the loaded-list filter', async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: [] } as never);
    renderDependencies();

    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('checkbox', { name: 'Hide completed dependencies' })).not.toBeInTheDocument();
    expect(screen.queryByText(/No matching dependencies in the loaded list/)).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});
