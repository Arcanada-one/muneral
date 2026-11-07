import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskDependencies } from './TaskDependencies';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('@/lib/api/client', () => ({ default: api }));

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
const nextOtherId = '88888888-8888-4888-8888-888888888888';

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

const nextTaskGraph = [
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
    type: 'depends_on',
    direction: 'outgoing',
    fromTaskId: nextTaskId,
    toTaskId: nextOtherId,
    otherTaskId: nextOtherId,
    otherTaskTitle: 'Next task dependency',
    otherTaskStatus: 'todo',
  },
  {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc',
    type: 'blocks',
    direction: 'incoming',
    fromTaskId: nextOtherId,
    toTaskId: nextTaskId,
    otherTaskId: nextOtherId,
    otherTaskTitle: 'Next incoming blocker',
    otherTaskStatus: 'in_progress',
  },
];

function renderDependencies(currentTaskId = taskId) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const renderForTask = (id: string) => (
    <QueryClientProvider client={client}>
      <TaskDependencies taskId={id} />
    </QueryClientProvider>
  );
  const view = render(renderForTask(currentTaskId));
  return {
    ...view,
    client,
    rerenderTask: (id: string) => view.rerender(renderForTask(id)),
  };
}

function renderedDependencyTitles() {
  return screen.getAllByRole('listitem').map((item) => {
    const title = item.querySelector('span.min-w-0.break-words.font-medium');
    return title?.textContent ?? '';
  });
}

beforeEach(() => {
  api.get.mockReset().mockImplementation(async (url: string) => ({
    data: url === `/tasks/${nextTaskId}/dependency-graph` ? nextTaskGraph : graph,
  }));
  for (const method of [api.post, api.put, api.patch, api.delete]) method.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('task dependency direction filter', () => {
  it('shows the accessible three-option native selector by default and preserves loaded order', async () => {
    renderDependencies();

    const selector = await screen.findByRole('combobox', { name: 'Dependency direction' });
    expect(selector.tagName).toBe('SELECT');
    expect(Array.from((selector as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
      'All dependencies', 'Incoming', 'Outgoing',
    ]);
    expect(selector).toHaveValue('all');
    expect(screen.getByText('Showing 6 of 6 loaded dependencies.')).toBeInTheDocument();
    expect(renderedDependencyTitles()).toEqual([
      'Prerequisite task',
      'Dependent task',
      'Blocked task',
      'Blocking task',
      'Related task',
      'Duplicate task',
    ]);
  });

  it('filters exact directions, reports subset and full totals, and performs no additional request or mutation', async () => {
    renderDependencies();
    const selector = await screen.findByRole('combobox', { name: 'Dependency direction' });

    const cases = [
      {
        value: 'incoming',
        count: 3,
        titles: ['Dependent task', 'Blocking task', 'Related task'],
      },
      {
        value: 'outgoing',
        count: 3,
        titles: ['Prerequisite task', 'Blocked task', 'Duplicate task'],
      },
      {
        value: 'all',
        count: 6,
        titles: [
          'Prerequisite task',
          'Dependent task',
          'Blocked task',
          'Blocking task',
          'Related task',
          'Duplicate task',
        ],
      },
    ];
    for (const testCase of cases) {
      fireEvent.change(selector, { target: { value: testCase.value } });
      expect(selector).toHaveValue(testCase.value);
      expect(screen.getByText(`Showing ${testCase.count} of 6 loaded dependencies.`)).toBeInTheDocument();
      expect(renderedDependencyTitles()).toEqual(testCase.titles);
    }

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith(`/tasks/${taskId}/dependency-graph`);
    expect(api.post).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('distinguishes a filter-empty subset from loading, read failure, and a loaded-empty response', async () => {
    api.get.mockReset().mockResolvedValueOnce({
      data: [graph[0], graph[2], graph[5]],
    });
    const view = renderDependencies();
    const selector = await screen.findByRole('combobox', { name: 'Dependency direction' });
    fireEvent.change(selector, { target: { value: 'incoming' } });
    expect(screen.getByText(
      'No matching dependencies in the loaded list. Choose All dependencies to show all.',
    )).toBeInTheDocument();
    expect(selector).toHaveValue('incoming');
    expect(screen.getByText('Showing 0 of 3 loaded dependencies.')).toBeInTheDocument();

    view.unmount();
    let resolveLoad: ((response: { data: typeof graph }) => void) | undefined;
    api.get.mockReset().mockImplementationOnce(() => new Promise((resolve) => {
      resolveLoad = resolve;
    }));
    const loadingView = renderDependencies();
    expect(screen.getByRole('status')).toHaveTextContent('Loading dependencies…');
    expect(screen.queryByRole('combobox', { name: 'Dependency direction' })).not.toBeInTheDocument();
    await act(async () => resolveLoad?.({ data: graph }));
    expect(await screen.findByRole('combobox', { name: 'Dependency direction' })).toBeInTheDocument();
    loadingView.unmount();

    api.get.mockReset().mockRejectedValueOnce(new Error('Synthetic read failure'));
    const errorView = renderDependencies();
    expect(await screen.findByRole('alert')).toHaveTextContent('Dependencies are unavailable.');
    expect(screen.queryByRole('combobox', { name: 'Dependency direction' })).not.toBeInTheDocument();
    errorView.unmount();

    api.get.mockReset().mockResolvedValue({ data: [] });
    renderDependencies();
    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith(`/tasks/${taskId}/dependency-graph`);
      expect(screen.queryByText('Loading dependencies…')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('Dependencies')).not.toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Dependency direction' })).not.toBeInTheDocument();
    expect(screen.queryByText('Dependencies are unavailable.')).not.toBeInTheDocument();
  });

  it('preserves the choice across same-task data refresh and resets it when task identity changes', async () => {
    const view = renderDependencies();
    const selector = await screen.findByRole('combobox', { name: 'Dependency direction' });
    await waitFor(() => {
      expect(view.client.getQueryState(['tasks', taskId, 'dependency-graph'])).toMatchObject({
        status: 'success',
        fetchStatus: 'idle',
      });
    });
    fireEvent.change(selector, { target: { value: 'outgoing' } });
    expect(renderedDependencyTitles()).toEqual([
      'Prerequisite task',
      'Blocked task',
      'Duplicate task',
    ]);

    const refreshedGraph = [
      { ...graph[0], otherTaskTitle: 'Prerequisite current' },
      { ...graph[1] },
      { ...graph[2], otherTaskTitle: 'Blocked current' },
      { ...graph[3] },
      { ...graph[4] },
      { ...graph[5], otherTaskTitle: 'Duplicate current' },
    ];
    api.get.mockResolvedValueOnce({ data: refreshedGraph });
    await act(async () => {
      await view.client.refetchQueries({
        queryKey: ['tasks', taskId, 'dependency-graph'],
        exact: true,
      });
    });

    expect(api.get.mock.calls).toEqual([
      [`/tasks/${taskId}/dependency-graph`],
      [`/tasks/${taskId}/dependency-graph`],
    ]);
    expect(view.client.getQueryData(['tasks', taskId, 'dependency-graph'])).toEqual(refreshedGraph);
    expect(screen.getByRole('combobox', { name: 'Dependency direction' })).toHaveValue('outgoing');
    expect(screen.getByText('Showing 3 of 6 loaded dependencies.')).toBeInTheDocument();
    await waitFor(() => {
      expect(renderedDependencyTitles()).toEqual([
        'Prerequisite current',
        'Blocked current',
        'Duplicate current',
      ]);
    });
    expect(api.get).toHaveBeenCalledTimes(2);

    view.rerenderTask(nextTaskId);
    const nextSelector = await screen.findByRole('combobox', { name: 'Dependency direction' });
    expect(nextSelector).toHaveValue('all');
    expect(renderedDependencyTitles()).toEqual([
      'Next task dependency',
      'Next incoming blocker',
    ]);
  });

  it('keeps existing direction labels and copy controls while filtering', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderDependencies();
    const selector = await screen.findByRole('combobox', { name: 'Dependency direction' });
    fireEvent.change(selector, { target: { value: 'incoming' } });

    expect(screen.getByText('Required by')).toBeInTheDocument();
    expect(screen.getByText('Blocked by')).toBeInTheDocument();
    expect(screen.getByText('Related to')).toBeInTheDocument();
    expect(screen.queryByText('Depends on')).not.toBeInTheDocument();
    expect(screen.queryByText('Blocks')).not.toBeInTheDocument();
    expect(screen.queryByText('Duplicates')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: `Copy task ID ${otherIds[1]}` }));
    expect(writeText).toHaveBeenCalledWith(otherIds[1]);
    expect(await screen.findByRole('status')).toHaveTextContent('Task ID copied.');
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});
