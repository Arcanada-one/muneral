import '@testing-library/jest-dom/vitest';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import apiClient from '@/lib/api/client';
import { TaskDependencies } from './TaskDependencies';

const taskId = '11111111-1111-4111-8111-111111111111';
const secondTaskId = '99999999-9999-4999-8999-999999999999';
const secondOtherId = '88888888-8888-4888-8888-888888888888';
const otherIds = [
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];

const graph = [
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    type: 'depends_on',
    direction: 'outgoing',
    fromTaskId: taskId,
    toTaskId: otherIds[0],
    otherTaskId: otherIds[0],
    otherTaskTitle: 'Prerequisite task',
    otherTaskStatus: 'in_progress',
  },
  {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    type: 'depends_on',
    direction: 'incoming',
    fromTaskId: otherIds[1],
    toTaskId: taskId,
    otherTaskId: otherIds[1],
    otherTaskTitle: 'Dependent task',
    otherTaskStatus: 'todo',
  },
  {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    type: 'blocks',
    direction: 'outgoing',
    fromTaskId: taskId,
    toTaskId: otherIds[2],
    otherTaskId: otherIds[2],
    otherTaskTitle: 'Blocked task',
    otherTaskStatus: 'todo',
  },
];

function renderDependencies(currentTaskId = taskId, initialGraph?: typeof graph | []) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
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
  return { ...view, queryClient, rerenderTask: (id: string) => view.rerender(renderForTask(id)) };
}

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
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

describe('task dependency full-id disclosure', () => {
  it('keeps compact eight-character IDs and exposes an accessible show control per loaded row', async () => {
    vi.mocked(apiClient.get).mockImplementationOnce(() => new Promise(() => {}));
    renderDependencies(taskId, graph);

    expect(await screen.findByText('Prerequisite task')).toBeInTheDocument();
    const showButtons = screen.getAllByRole('button', { name: 'Show full task ID' });
    expect(showButtons).toHaveLength(graph.length);

    for (const id of otherIds) {
      expect(screen.getByText(id.slice(0, 8))).toBeInTheDocument();
      expect(screen.queryByText(id)).not.toBeInTheDocument();
    }

    expect(showButtons[0]).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Hide full task ID' })).not.toBeInTheDocument();
  });

  it('expands one row to the exact loaded full ID with wrapping text and can hide it again', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockImplementationOnce(() => new Promise(() => {}));
    renderDependencies(taskId, graph);

    const firstRow = (await screen.findByText('Prerequisite task')).closest('li');
    expect(firstRow).not.toBeNull();
    const row = firstRow as HTMLElement;

    await user.click(within(row).getByRole('button', { name: 'Show full task ID' }));

    const fullId = within(row).getByText(otherIds[0]);
    expect(fullId.tagName).toBe('CODE');
    expect(fullId).toHaveClass('break-all');
    expect(within(row).getByRole('button', { name: 'Hide full task ID' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(within(row).queryByText(otherIds[0].slice(0, 8))).not.toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Hide full task ID' }));

    expect(within(row).getByText(otherIds[0].slice(0, 8))).toBeInTheDocument();
    expect(within(row).queryByText(otherIds[0])).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Show full task ID' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(within(row).getByText('Prerequisite task')).toBeInTheDocument();
    expect(within(row).getByText('In Progress')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: `Copy task ID ${otherIds[0]}` })).toBeInTheDocument();
  });

  it('toggles only the selected row and preserves order, titles, statuses, and copy controls', async () => {
    const user = userEvent.setup();
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    vi.mocked(apiClient.get).mockImplementationOnce(() => new Promise(() => {}));
    renderDependencies(taskId, graph);

    await screen.findByText('Prerequisite task');
    const rowsBefore = screen.getAllByRole('listitem').map((row) => row.textContent);
    expect(rowsBefore).toHaveLength(3);

    const firstRow = screen.getByText('Prerequisite task').closest('li') as HTMLElement;
    const secondRow = screen.getByText('Dependent task').closest('li') as HTMLElement;

    await user.click(within(firstRow).getByRole('button', { name: 'Show full task ID' }));

    expect(within(firstRow).getByText(otherIds[0])).toBeInTheDocument();
    expect(within(secondRow).getByText(otherIds[1].slice(0, 8))).toBeInTheDocument();
    expect(within(secondRow).queryByText(otherIds[1])).not.toBeInTheDocument();
    expect(within(secondRow).getByRole('button', { name: 'Show full task ID' })).toBeInTheDocument();

    const rowsAfter = screen.getAllByRole('listitem').map((row) => {
      const title = within(row).getByText(/Prerequisite task|Dependent task|Blocked task/).textContent;
      return title;
    });
    expect(rowsAfter).toEqual(['Prerequisite task', 'Dependent task', 'Blocked task']);
    expect(within(firstRow).getByText('In Progress')).toBeInTheDocument();
    expect(within(secondRow).getByText('To Do')).toBeInTheDocument();

    fireEvent.click(within(firstRow).getByRole('button', { name: `Copy task ID ${otherIds[0]}` }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(otherIds[0]);
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith(`/tasks/${taskId}/dependency-graph`);
  });

  it('preserves per-row disclosure across a same-task loaded refresh and empty transition', async () => {
    const user = userEvent.setup();
    const previousOnlineState = onlineManager.isOnline();
    onlineManager.setOnline(false);
    const view = renderDependencies(taskId, graph);

    try {
      const firstRow = (await screen.findByText('Prerequisite task')).closest('li') as HTMLElement;
      await user.click(within(firstRow).getByRole('button', { name: 'Show full task ID' }));
      expect(within(firstRow).getByText(otherIds[0])).toBeInTheDocument();
      expect(apiClient.get).not.toHaveBeenCalled();

      await act(async () => {
        view.queryClient.setQueryData(['tasks', taskId, 'dependency-graph'], []);
      });
      expect(view.queryClient.getQueryData(['tasks', taskId, 'dependency-graph'])).toEqual([]);
      await waitFor(() => {
        expect(screen.queryByText('Prerequisite task')).not.toBeInTheDocument();
      });
      expect(screen.queryAllByRole('button', { name: 'Show full task ID' })).toHaveLength(0);
      expect(screen.queryAllByRole('button', { name: 'Hide full task ID' })).toHaveLength(0);

      await act(async () => {
        view.queryClient.setQueryData(['tasks', taskId, 'dependency-graph'], [
          { ...graph[0], otherTaskTitle: 'Prerequisite task refreshed' },
          graph[1],
          graph[2],
        ]);
      });

      const refreshedRow = (await screen.findByText('Prerequisite task refreshed')).closest('li') as HTMLElement;
      expect(within(refreshedRow).getByText(otherIds[0])).toBeInTheDocument();
      expect(within(refreshedRow).getByRole('button', { name: 'Hide full task ID' })).toBeInTheDocument();
      expect(within(screen.getByText('Dependent task').closest('li') as HTMLElement)
        .getByRole('button', { name: 'Show full task ID' })).toBeInTheDocument();
      expect(apiClient.get).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      view.queryClient.clear();
      onlineManager.setOnline(previousOnlineState);
    }
  });

  it('resets disclosure when the task identity changes', async () => {
    const user = userEvent.setup();
    const previousOnlineState = onlineManager.isOnline();
    onlineManager.setOnline(false);
    const secondTaskGraph = [{
      ...graph[0],
      id: '99999999-aaaa-4999-8999-999999999999',
      fromTaskId: secondTaskId,
      toTaskId: secondOtherId,
      otherTaskId: secondOtherId,
      otherTaskTitle: 'Second task dependency',
    }];
    const view = renderDependencies(taskId, graph);

    try {
      const firstRow = (await screen.findByText('Prerequisite task')).closest('li') as HTMLElement;
      await user.click(within(firstRow).getByRole('button', { name: 'Show full task ID' }));
      expect(within(firstRow).getByText(otherIds[0])).toBeInTheDocument();

      view.queryClient.setQueryData(['tasks', secondTaskId, 'dependency-graph'], secondTaskGraph);
      view.rerenderTask(secondTaskId);

      const secondRow = (await screen.findByText('Second task dependency')).closest('li') as HTMLElement;
      expect(within(secondRow).getByText(secondOtherId.slice(0, 8))).toBeInTheDocument();
      expect(within(secondRow).queryByText(secondOtherId)).not.toBeInTheDocument();
      expect(within(secondRow).getByRole('button', { name: 'Show full task ID' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      expect(apiClient.get).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      view.queryClient.clear();
      onlineManager.setOnline(previousOnlineState);
    }
  });

  it('resets disclosure when a loaded row identity is replaced on the same task', async () => {
    const user = userEvent.setup();
    const previousOnlineState = onlineManager.isOnline();
    onlineManager.setOnline(false);
    const view = renderDependencies(taskId, graph);

    try {
      const firstRow = (await screen.findByText('Prerequisite task')).closest('li') as HTMLElement;
      await user.click(within(firstRow).getByRole('button', { name: 'Show full task ID' }));
      expect(within(firstRow).getByText(otherIds[0])).toBeInTheDocument();

      const replacedOtherId = 'abababab-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      const replacedGraph = [
        {
          ...graph[0],
          id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          toTaskId: replacedOtherId,
          otherTaskId: replacedOtherId,
        },
        graph[1],
        graph[2],
      ];
      await act(async () => {
        view.queryClient.setQueryData(['tasks', taskId, 'dependency-graph'], replacedGraph);
      });
      expect(view.queryClient.getQueryData(['tasks', taskId, 'dependency-graph'])).toEqual(replacedGraph);
      await waitFor(() => {
        expect(screen.getByText(replacedOtherId.slice(0, 8))).toBeInTheDocument();
      });

      const replacedRow = (await screen.findByText('Prerequisite task')).closest('li') as HTMLElement;
      expect(within(replacedRow).getByText(replacedOtherId.slice(0, 8))).toBeInTheDocument();
      expect(within(replacedRow).queryByText(replacedOtherId)).not.toBeInTheDocument();
      expect(within(replacedRow).getByRole('button', { name: 'Show full task ID' })).toBeInTheDocument();
      expect(apiClient.get).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      view.queryClient.clear();
      onlineManager.setOnline(previousOnlineState);
    }
  });

  it('does not expose disclosure controls for loading, error, or empty loaded states', async () => {
    const previousOnlineState = onlineManager.isOnline();
    onlineManager.setOnline(false);
    const loadingView = renderDependencies();
    try {
      expect(screen.getByRole('status')).toHaveTextContent('Loading dependencies…');
      expect(screen.queryByRole('button', { name: 'Show full task ID' })).not.toBeInTheDocument();
      expect(apiClient.get).not.toHaveBeenCalled();
    } finally {
      loadingView.unmount();
      loadingView.queryClient.clear();
      onlineManager.setOnline(previousOnlineState);
    }

    vi.mocked(apiClient.get).mockRejectedValueOnce(new Error('private server detail'));
    const errorView = renderDependencies();
    expect(await screen.findByRole('alert')).toHaveTextContent('Dependencies are unavailable.');
    expect(screen.queryByRole('button', { name: 'Show full task ID' })).not.toBeInTheDocument();
    errorView.unmount();
    errorView.queryClient.clear();

    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: [] } as never);
    const emptyView = renderDependencies();
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('No dependencies.');
    });
    expect(screen.queryByRole('button', { name: 'Show full task ID' })).not.toBeInTheDocument();
    emptyView.unmount();
    emptyView.queryClient.clear();
  });

  it('keeps withheld titles and never turns dependency IDs into guessed links or extra reads', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.get).mockResolvedValueOnce({
      data: [{ ...graph[0], otherTaskTitle: null, otherTaskTitleWithheld: true }],
    } as never);
    const view = renderDependencies();

    const compactId = await screen.findByText(otherIds[0].slice(0, 8));
    const row = compactId.closest('li') as HTMLElement;
    expect(screen.queryByText('Prerequisite task')).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: `Copy task ID ${otherIds[0]}` })).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Show full task ID' }));
    expect(within(row).getByText(otherIds[0])).toBeInTheDocument();
    expect(view.container.querySelector('a')).toBeNull();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith(`/tasks/${taskId}/dependency-graph`);
    expect(vi.mocked(apiClient.get).mock.calls.every((call) =>
      typeof call[0] === 'string' && call[0].endsWith('/dependency-graph'),
    )).toBe(true);
  });
});
