import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
  '77777777-7777-4777-8777-777777777777',
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
  {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    type: 'blocks',
    direction: 'incoming',
    fromTaskId: otherIds[3],
    toTaskId: taskId,
    otherTaskId: otherIds[3],
    otherTaskTitle: 'Blocking task',
    otherTaskStatus: 'in_progress',
  },
  {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    type: 'related_to',
    direction: 'incoming',
    fromTaskId: otherIds[4],
    toTaskId: taskId,
    otherTaskId: otherIds[4],
    otherTaskTitle: 'Related task',
    otherTaskStatus: 'todo',
  },
  {
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    type: 'duplicates',
    direction: 'outgoing',
    fromTaskId: taskId,
    toTaskId: otherIds[5],
    otherTaskId: otherIds[5],
    otherTaskTitle: 'Duplicate task',
    otherTaskStatus: 'todo',
  },
];

function renderDependencies(currentTaskId = taskId) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const renderForTask = (id: string) => (
    <QueryClientProvider client={queryClient}>
      <TaskDependencies taskId={id} />
    </QueryClientProvider>
  );
  const view = render(renderForTask(currentTaskId));
  return { ...view, rerenderTask: (id: string) => view.rerender(renderForTask(id)) };
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

describe('task dependency directions', () => {
  it('reads the complete graph and describes each directed relation from the current task', async () => {
    renderDependencies();

    expect(await screen.findAllByText('Depends on')).toHaveLength(1);
    expect(screen.getByText('Required by')).toBeInTheDocument();
    expect(screen.getByText('Blocks')).toBeInTheDocument();
    expect(screen.getByText('Blocked by')).toBeInTheDocument();
    expect(screen.getByText('Related to')).toBeInTheDocument();
    expect(screen.getByText('Duplicates')).toBeInTheDocument();

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith(`/tasks/${taskId}/dependency-graph`);
    });
    for (const id of otherIds) {
      expect(screen.getByText(id.slice(0, 8))).toBeInTheDocument();
    }
    expect(screen.getByText('Required by').closest('li')).toHaveTextContent(otherIds[1].slice(0, 8));
    expect(screen.getByText('Blocked by').closest('li')).toHaveTextContent(otherIds[3].slice(0, 8));
    expect(screen.getByText('Prerequisite task').closest('li')).toHaveTextContent('In Progress');
    expect(screen.getByText('Dependent task').closest('li')).toHaveTextContent('To Do');
  });

  it('shows the counterpart title returned by the dependency graph', async () => {
    renderDependencies();

    expect(await screen.findByText('Prerequisite task')).toBeInTheDocument();
  });

  it('shows the counterpart status using the task status label', async () => {
    renderDependencies();

    const title = await screen.findByText('Prerequisite task');
    expect(title.closest('li')).toHaveTextContent('In Progress');
  });

  it('keeps the validated UUID fallback when the API withholds a counterpart title', async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce({
      data: [{ ...graph[0], otherTaskTitle: null, otherTaskTitleWithheld: true }],
    } as never);
    renderDependencies();

    const id = await screen.findByText(otherIds[0].slice(0, 8));
    expect(id.closest('li')).toHaveTextContent('In Progress');
    expect(screen.getByRole('button', { name: `Copy task ID ${otherIds[0]}` })).toBeInTheDocument();
    expect(screen.queryByText('Prerequisite task')).not.toBeInTheDocument();
  });

  it('renders a returned title as inert text', async () => {
    const untrustedTitle = '<img src=x onerror=alert(1)>';
    vi.mocked(apiClient.get).mockResolvedValueOnce({
      data: [{ ...graph[0], otherTaskTitle: untrustedTitle }],
    } as never);
    const view = renderDependencies();

    expect(await screen.findByText(untrustedTitle)).toBeInTheDocument();
    expect(view.container.querySelector('img')).not.toBeInTheDocument();
  });

  it('lets the user copy the full counterpart task ID instead of only seeing its abbreviated prefix', async () => {
    const fullId = '22222222-2222-4222-8222-222222222222';
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    renderDependencies();

    const copyButton = await screen.findByRole('button', { name: `Copy task ID ${fullId}` });
    expect(screen.getByText(fullId.slice(0, 8))).toBeInTheDocument();
    expect(writeText).not.toHaveBeenCalled();

    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(fullId);
    expect(await screen.findByRole('status')).toHaveTextContent('Task ID copied.');
  });

  it('reports clipboard failures without exposing the browser error', async () => {
    const writeText = installClipboard(vi.fn().mockRejectedValue(new Error('clipboard permission details')));
    renderDependencies();

    fireEvent.click(await screen.findByRole('button', { name: `Copy task ID ${otherIds[0]}` }));

    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('Could not copy task ID. Try copying it manually.');
    expect(error).not.toHaveTextContent('clipboard permission details');
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(otherIds[0]);
  });

  it('clears copy feedback when the displayed task changes', async () => {
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    const view = renderDependencies();

    fireEvent.click(await screen.findByRole('button', { name: `Copy task ID ${otherIds[0]}` }));
    expect(await screen.findByRole('status')).toHaveTextContent('Task ID copied.');

    vi.mocked(apiClient.get).mockImplementation(async (url) => ({
      data: url === `/tasks/${secondTaskId}/dependency-graph`
        ? [{ ...graph[0], id: '99999999-aaaa-4999-8999-999999999999', fromTaskId: secondTaskId, toTaskId: secondOtherId, otherTaskId: secondOtherId }]
        : graph,
    }) as never);
    view.rerenderTask(secondTaskId);

    expect(await screen.findByRole('button', { name: `Copy task ID ${secondOtherId}` })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Copy task ID ${otherIds[0]}` })).not.toBeInTheDocument();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(otherIds[0]);
  });

  it('rejects a graph row that is not bound to the requested task', async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce({
      data: [{ ...graph[0], fromTaskId: otherIds[2], toTaskId: otherIds[3] }],
    } as never);
    renderDependencies();

    expect(await screen.findByRole('alert')).toHaveTextContent('Dependencies are unavailable');
    expect(screen.queryByText('Depends on')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Copy task ID ${otherIds[2]}` })).not.toBeInTheDocument();
  });

  it('retries the same failed dependency graph read and renders its successful response', async () => {
    vi.mocked(apiClient.get).mockRejectedValueOnce(new Error('private server detail'));
    renderDependencies();

    expect(await screen.findByRole('alert')).toHaveTextContent('Dependencies are unavailable.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry dependencies' }));

    expect(await screen.findByText('Prerequisite task')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('private server detail')).not.toBeInTheDocument();
  });

  it('disables duplicate retry and keeps a late result bound to the original task', async () => {
    let firstTaskCalls = 0;
    let resolveRetry: ((response: { data: typeof graph }) => void) | undefined;
    const secondTaskGraph = [{
      ...graph[0],
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
      fromTaskId: secondTaskId,
      toTaskId: secondOtherId,
      otherTaskId: secondOtherId,
      otherTaskTitle: 'Second task dependency',
    }];
    vi.mocked(apiClient.get).mockImplementation((url) => {
      if (url === `/tasks/${taskId}/dependency-graph`) {
        firstTaskCalls += 1;
        if (firstTaskCalls === 1) return Promise.reject(new Error('private server detail'));
        return new Promise((resolve) => { resolveRetry = resolve; }) as never;
      }
      if (url === `/tasks/${secondTaskId}/dependency-graph`) {
        return Promise.resolve({ data: secondTaskGraph }) as never;
      }
      return Promise.resolve({ data: [] }) as never;
    });

    const view = renderDependencies();
    expect(await screen.findByRole('alert')).toHaveTextContent('Dependencies are unavailable.');

    const retry = screen.getByRole('button', { name: 'Retry dependencies' });
    fireEvent.click(retry);
    expect(await screen.findByRole('status')).toHaveTextContent('Retrying dependencies…');
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(firstTaskCalls).toBe(2);

    view.rerenderTask(secondTaskId);
    expect(await screen.findByText('Second task dependency')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await act(async () => {
      resolveRetry?.({ data: graph });
    });
    expect(screen.getByText('Second task dependency')).toBeInTheDocument();
    expect(screen.queryByText('Prerequisite task')).not.toBeInTheDocument();
  });
});
