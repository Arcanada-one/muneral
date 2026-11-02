import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import apiClient from '@/lib/api/client';
import { TaskDependencies } from './TaskDependencies';

const taskId = '11111111-1111-4111-8111-111111111111';
const secondTaskId = '99999999-9999-4999-8999-999999999999';
const outgoingId = '22222222-2222-4222-8222-222222222222';
const incomingId = '33333333-3333-4333-8333-333333333333';
const outgoingEdgeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const incomingEdgeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const graph = [
  {
    id: outgoingEdgeId,
    type: 'depends_on',
    direction: 'outgoing',
    fromTaskId: taskId,
    toTaskId: outgoingId,
    otherTaskId: outgoingId,
    otherTaskTitle: 'Outgoing dependency',
    otherTaskStatus: 'todo',
  },
  {
    id: incomingEdgeId,
    type: 'blocks',
    direction: 'incoming',
    fromTaskId: incomingId,
    toTaskId: taskId,
    otherTaskId: incomingId,
    otherTaskTitle: 'Incoming dependency',
    otherTaskStatus: 'in_progress',
  },
];

const secondGraph = [
  {
    ...graph[0],
    fromTaskId: secondTaskId,
    toTaskId: outgoingId,
  },
];

let clipboardWrite: ReturnType<typeof vi.fn>;
let originalClipboard: PropertyDescriptor | undefined;

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

function dependencyRow(title: string) {
  return screen.getByText(title).closest('li') as HTMLLIElement;
}

beforeEach(() => {
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  clipboardWrite = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: clipboardWrite },
  });

  vi.spyOn(apiClient, 'get').mockImplementation(async (url) => ({
    data: url === `/tasks/${secondTaskId}/dependency-graph` ? secondGraph : graph,
  }) as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalClipboard) {
    Object.defineProperty(navigator, 'clipboard', originalClipboard);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

describe('full dependency task ID disclosure', () => {
  it('starts compact, toggles the exact loaded ID, and retains row content and copy action', async () => {
    renderDependencies();
    await screen.findByText('Outgoing dependency');
    const row = dependencyRow('Outgoing dependency');

    expect(row).toHaveTextContent('22222222');
    expect(row).not.toHaveTextContent(outgoingId);
    expect(within(row).getByRole('button', { name: 'Show full task ID' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: `Copy task ID ${outgoingId}` })).toBeInTheDocument();

    fireEvent.click(within(row).getByRole('button', { name: 'Show full task ID' }));
    const fullId = within(row).getByText(outgoingId);
    expect(fullId).toBeVisible();
    expect(fullId).toHaveStyle({ overflowWrap: 'anywhere' });
    expect(within(row).getByRole('button', { name: 'Hide full task ID' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(row).getByText('Outgoing dependency')).toBeVisible();
    expect(within(row).getByText('To Do')).toBeVisible();
    expect(within(row).getByRole('button', { name: `Copy task ID ${outgoingId}` })).toBeInTheDocument();

    fireEvent.click(within(row).getByRole('button', { name: `Copy task ID ${outgoingId}` }));
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(outgoingId));

    fireEvent.click(within(row).getByRole('button', { name: 'Hide full task ID' }));
    expect(within(row).getByText('22222222')).toBeVisible();
    expect(within(row).queryByText(outgoingId)).toBeNull();
    expect(within(row).getByRole('button', { name: `Copy task ID ${outgoingId}` })).toBeInTheDocument();
  });

  it('keeps disclosure independent per row and does not affect filter counts or order', async () => {
    const get = vi.mocked(apiClient.get);
    const post = vi.spyOn(apiClient, 'post');
    const patch = vi.spyOn(apiClient, 'patch');
    const put = vi.spyOn(apiClient, 'put');
    const remove = vi.spyOn(apiClient, 'delete');
    renderDependencies();

    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    const outgoingRow = dependencyRow('Outgoing dependency');
    const incomingRow = dependencyRow('Incoming dependency');
    expect(screen.getByText('Showing 2 of 2 loaded dependencies.')).toBeVisible();

    fireEvent.click(within(outgoingRow).getByRole('button', { name: 'Show full task ID' }));
    expect(within(outgoingRow).getByText(outgoingId)).toBeVisible();
    expect(within(incomingRow).getByText('33333333')).toBeVisible();
    expect(within(incomingRow).queryByText(incomingId)).toBeNull();
    expect(screen.getByText('Showing 2 of 2 loaded dependencies.')).toBeVisible();

    fireEvent.change(screen.getByRole('combobox', { name: 'Dependency direction' }), { target: { value: 'incoming' } });
    expect(screen.getByText('Showing 1 of 2 loaded dependencies.')).toBeVisible();
    const filteredRow = screen.getByRole('listitem');
    fireEvent.click(within(filteredRow).getByRole('button', { name: 'Show full task ID' }));
    expect(within(filteredRow).getByText(incomingId)).toBeVisible();
    expect(screen.getByText('Showing 1 of 2 loaded dependencies.')).toBeVisible();

    fireEvent.change(screen.getByRole('combobox', { name: 'Dependency direction' }), { target: { value: 'all' } });
    const restoredRows = screen.getAllByRole('listitem');
    expect(restoredRows[0]).toHaveTextContent('Outgoing dependency');
    expect(restoredRows[1]).toHaveTextContent('Incoming dependency');
    expect(within(restoredRows[0]).getByText('22222222')).toBeVisible();
    expect(within(restoredRows[0]).queryByText(outgoingId)).toBeNull();
    expect(within(restoredRows[1]).getByText(incomingId)).toBeVisible();
    expect(screen.getByText('Showing 2 of 2 loaded dependencies.')).toBeVisible();
    expect(get).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('preserves expansion on same-identity refresh and derives row data from the refreshed graph', async () => {
    const view = renderDependencies();
    await screen.findByText('Outgoing dependency');
    const row = dependencyRow('Outgoing dependency');
    fireEvent.click(within(row).getByRole('button', { name: 'Show full task ID' }));

    view.queryClient.setQueryData(['tasks', taskId, 'dependency-graph'], [
      { ...graph[0], otherTaskTitle: 'Refreshed outgoing dependency', otherTaskStatus: 'in_progress' },
      graph[1],
    ]);

    await screen.findByText('Refreshed outgoing dependency');
    const refreshedRow = dependencyRow('Refreshed outgoing dependency');
    expect(within(refreshedRow).getByText(outgoingId)).toBeVisible();
    expect(within(refreshedRow).getByRole('button', { name: 'Hide full task ID' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(refreshedRow).getByText('In Progress')).toBeVisible();
    expect(screen.getByText('Showing 2 of 2 loaded dependencies.')).toBeVisible();
  });

  it('resets disclosure when row identity or current task changes', async () => {
    const view = renderDependencies();
    await screen.findByText('Outgoing dependency');
    const row = dependencyRow('Outgoing dependency');
    fireEvent.click(within(row).getByRole('button', { name: 'Show full task ID' }));
    expect(within(row).getByText(outgoingId)).toBeVisible();

    const replacedId = '55555555-5555-4555-8555-555555555555';
    view.queryClient.setQueryData(['tasks', taskId, 'dependency-graph'], [
      { ...graph[0], otherTaskId: replacedId, toTaskId: replacedId },
      graph[1],
    ]);
    await screen.findByText('55555555');
    const replacedRow = dependencyRow('Outgoing dependency');
    expect(within(replacedRow).getByText('55555555')).toBeVisible();
    expect(within(replacedRow).queryByText(replacedId)).toBeNull();
    expect(within(replacedRow).getByRole('button', { name: 'Show full task ID' })).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(within(replacedRow).getByRole('button', { name: 'Show full task ID' }));
    expect(within(replacedRow).getByText(replacedId)).toBeVisible();
    view.rerenderTask(secondTaskId);

    await screen.findByText('22222222');
    const switchedRow = dependencyRow('Outgoing dependency');
    expect(within(switchedRow).getByText('22222222')).toBeVisible();
    expect(within(switchedRow).queryByText(outgoingId)).toBeNull();
    expect(within(switchedRow).getByRole('button', { name: 'Show full task ID' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps a withheld counterpart title withheld while exposing only the loaded ID on demand', async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce({
      data: [{ ...graph[0], otherTaskTitle: 'Sensitive counterpart title', otherTaskTitleWithheld: true }],
    } as never);
    renderDependencies();
    const row = await screen.findByRole('listitem');

    expect(within(row).queryByText('Sensitive counterpart title')).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Show full task ID' }));
    expect(within(row).getByText(outgoingId)).toBeVisible();
    expect(within(row).queryByText('Sensitive counterpart title')).toBeNull();
  });
});
