import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import apiClient from '@/lib/api/client';
import { TaskReadiness } from './TaskReadiness';

const taskId = '11111111-1111-4111-8111-111111111111';
const anotherTaskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const firstBlockerId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const secondBlockerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const thirdBlockerId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const queryClients: QueryClient[] = [];
let originalClipboardDescriptor: PropertyDescriptor | undefined;
let clipboardDescriptorCaptured = false;

function edgeId(value: number) {
  return `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
}

function blocker(
  id: string,
  otherTaskId: string,
  title: string,
  withheld = false,
  sourceTaskId = taskId,
) {
  return {
    id,
    type: 'depends_on',
    direction: 'outgoing',
    fromTaskId: sourceTaskId,
    toTaskId: otherTaskId,
    otherTaskId,
    otherTaskTitle: title,
    ...(withheld ? { otherTaskTitleWithheld: true } : {}),
    otherTaskStatus: 'in_progress',
  };
}

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

function setClipboard(writeText?: (text: string) => Promise<void>) {
  if (!clipboardDescriptorCaptured) {
    originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    clipboardDescriptorCaptured = true;
  }
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

afterEach(() => {
  cleanup();
  queryClients.splice(0).forEach((queryClient) => queryClient.clear());
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
  originalClipboardDescriptor = undefined;
  clipboardDescriptorCaptured = false;
  vi.restoreAllMocks();
});

describe('TaskReadiness loaded blocker search', () => {
  it('trims and case-folds the query, searches IDs and visible titles, and preserves loaded order and duplicates', async () => {
    const rows = [
      blocker(edgeId(1), firstBlockerId, 'Ordinary blocker'),
      blocker(edgeId(2), secondBlockerId, 'Needle hidden title', true),
      blocker(edgeId(3), firstBlockerId, 'Needle visible title'),
    ];
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness(taskId, rows, 5),
    } as never);
    const view = renderReadiness();

    expect(await screen.findByText('3 of 5 dependency links are blocking this task.')).toBeInTheDocument();
    expect(screen.getByText('Blocked')).toBeInTheDocument();
    const search = screen.getByRole('searchbox', { name: 'Search loaded blockers' });
    expect(search).toHaveValue('');
    expect(screen.getByText('Showing 3 of 3 loaded blocking dependencies.')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: '  NEEDLE  ' } });
    expect(search).toHaveValue('  NEEDLE  ');
    expect(screen.getByText('Showing 1 of 3 loaded blocking dependencies.')).toBeInTheDocument();
    expect(screen.queryByText('Needle hidden title')).not.toBeInTheDocument();
    let blockerList = screen.getByRole('list');
    expect(within(blockerList).getAllByRole('listitem')).toHaveLength(1);
    expect(within(blockerList).getByText('Needle visible title')).toBeVisible();

    fireEvent.change(search, { target: { value: ' AAA ' } });
    expect(screen.getByText('Showing 2 of 3 loaded blocking dependencies.')).toBeInTheDocument();
    blockerList = screen.getByRole('list');
    expect(within(blockerList).getAllByRole('listitem')).toHaveLength(2);
    expect(within(blockerList).getByText('Ordinary blocker')).toBeVisible();
    expect(within(blockerList).getByText('Needle visible title')).toBeVisible();
    expect(within(blockerList).queryByText('Needle hidden title')).not.toBeInTheDocument();
    expect(within(blockerList).getAllByRole('listitem').map((item) => item.textContent?.replace(/\s+/g, ' ').trim()))
      .toEqual(['Ordinary blockerIn Progress', 'Needle visible titleIn Progress']);

    fireEvent.change(search, { target: { value: 'does-not-match' } });
    expect(screen.getByText('Showing 0 of 3 loaded blocking dependencies.')).toBeInTheDocument();
    expect(screen.getByText('No loaded blocking dependencies match this search. Clear search to see all loaded blockers.'))
      .toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(search).toHaveValue('');
    expect(screen.getByText('Showing 3 of 3 loaded blocking dependencies.')).toBeInTheDocument();
    expect(screen.getByText('3 of 5 dependency links are blocking this task.')).toBeInTheDocument();
    expect(view.queryClient.getQueryCache().getAll()).toHaveLength(1);
  });

  it('keeps search independent of disclosure, copies every loaded unique ID, and copies only a rendered row ID', async () => {
    const rows = [
      blocker(edgeId(4), firstBlockerId, 'First blocker'),
      blocker(edgeId(5), secondBlockerId, 'Needle blocker'),
      blocker(edgeId(6), thirdBlockerId, 'Needle duplicate'),
    ];
    const get = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ data: readiness(taskId, rows) } as never);
    const mutations = [
      vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('unexpected mutation')),
      vi.spyOn(apiClient, 'put').mockRejectedValue(new Error('unexpected mutation')),
      vi.spyOn(apiClient, 'patch').mockRejectedValue(new Error('unexpected mutation')),
      vi.spyOn(apiClient, 'delete').mockRejectedValue(new Error('unexpected mutation')),
    ];
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    const initialLocation = window.location.href;
    renderReadiness();

    const search = await screen.findByRole('searchbox', { name: 'Search loaded blockers' });
    fireEvent.change(search, { target: { value: 'needle' } });
    expect(screen.getByText('Showing 2 of 3 loaded blocking dependencies.')).toBeInTheDocument();
    let blockerList = screen.getByRole('list');
    expect(within(blockerList).getAllByRole('listitem')).toHaveLength(2);
    expect(within(blockerList).getByText('Needle blocker')).toBeVisible();
    expect(within(blockerList).getByText('Needle duplicate')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Hide blocking tasks' }));
    expect(screen.getByRole('button', { name: 'Show blocking tasks' })).toHaveAttribute('aria-expanded', 'false');
    expect(blockerList).not.toBeVisible();
    expect(search).toHaveValue('needle');
    const batchButton = screen.getByRole('button', { name: 'Copy loaded blocker IDs' });
    fireEvent.click(batchButton);
    expect(writeText).toHaveBeenCalledWith(`${firstBlockerId}\n${secondBlockerId}\n${thirdBlockerId}`);
    expect(await screen.findByText('Blocker IDs copied.')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Show blocking tasks' }));
    blockerList = screen.getByRole('list');
    const rowCopyButtons = within(blockerList).getAllByRole('button', { name: /^Copy blocker task ID / });
    expect(rowCopyButtons).toHaveLength(2);
    fireEvent.click(rowCopyButtons[0]);
    expect(writeText).toHaveBeenLastCalledWith(secondBlockerId);
    fireEvent.click(rowCopyButtons[1]);
    expect(writeText).toHaveBeenLastCalledWith(thirdBlockerId);

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(`/tasks/${taskId}/readiness`);
    mutations.forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
    expect(window.location.href).toBe(initialLocation);
  });

  it('retains the query across same-task refreshed data and clears it when the task changes', async () => {
    const get = vi.spyOn(apiClient, 'get')
      .mockResolvedValueOnce({
        data: readiness(taskId, [blocker(edgeId(7), firstBlockerId, 'Keep initial')]),
      } as never)
      .mockResolvedValueOnce({
        data: readiness(anotherTaskId, [
          blocker(edgeId(8), thirdBlockerId, 'Next task blocker', false, anotherTaskId),
        ]),
      } as never);
    const view = renderReadiness();
    const search = await screen.findByRole('searchbox', { name: 'Search loaded blockers' });
    fireEvent.change(search, { target: { value: 'keep' } });
    expect(screen.getByText('Keep initial')).toBeVisible();

    const refreshedReadiness = readiness(taskId, [
      blocker(edgeId(9), secondBlockerId, 'Keep refreshed'),
      blocker(edgeId(10), thirdBlockerId, 'Other refreshed'),
    ]);
    await act(async () => {
      view.queryClient.setQueryData(['tasks', taskId, 'readiness'], refreshedReadiness);
    });
    expect(view.queryClient.getQueryData(['tasks', taskId, 'readiness'])).toEqual(refreshedReadiness);
    expect(await screen.findByRole('searchbox', { name: 'Search loaded blockers' })).toHaveValue('keep');
    expect(await screen.findByText('Showing 1 of 2 loaded blocking dependencies.')).toBeInTheDocument();
    expect(screen.getByText('Keep refreshed')).toBeVisible();
    expect(screen.queryByText('Keep initial')).not.toBeInTheDocument();

    view.rerenderTask(anotherTaskId);
    const nextSearch = await screen.findByRole('searchbox', { name: 'Search loaded blockers' });
    expect(nextSearch).toHaveValue('');
    expect(screen.getByText('Next task blocker')).toBeVisible();
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(2, `/tasks/${anotherTaskId}/readiness`);
  });

  it('does not expose search controls while readiness is unknown, unavailable, or ready without blockers', async () => {
    let finishLoading: ((value: unknown) => void) | undefined;
    vi.spyOn(apiClient, 'get')
      .mockImplementationOnce(() => new Promise((resolve) => { finishLoading = resolve; }) as never)
      .mockRejectedValueOnce(new Error('synthetic read failure'))
      .mockResolvedValueOnce({ data: readiness(taskId) } as never);

    const loading = renderReadiness();
    expect(screen.getByText('Dependency readiness is unknown while it loads.')).toBeInTheDocument();
    expect(screen.queryByRole('searchbox', { name: 'Search loaded blockers' })).not.toBeInTheDocument();
    await act(async () => finishLoading?.({ data: readiness(taskId) }));
    expect(await screen.findByText('Ready: no dependency links.')).toBeInTheDocument();
    expect(screen.queryByRole('searchbox', { name: 'Search loaded blockers' })).not.toBeInTheDocument();
    loading.unmount();

    const error = renderReadiness(anotherTaskId);
    expect(await screen.findByText('Dependency readiness is unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('searchbox', { name: 'Search loaded blockers' })).not.toBeInTheDocument();
    error.unmount();
  });
});
