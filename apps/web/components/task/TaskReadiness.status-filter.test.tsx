import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import apiClient from '@/lib/api/client';
import { TaskReadiness } from './TaskReadiness';

const taskId = '11111111-1111-4111-8111-111111111111';
const otherTaskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const todoId = '00000000-0000-4000-8000-000000000001';
const progressId = '00000000-0000-4000-8000-000000000002';
const reviewId = '00000000-0000-4000-8000-000000000003';
const blockedId = '00000000-0000-4000-8000-000000000004';
const extraTodoId = '00000000-0000-4000-8000-000000000005';
const unknownId = '00000000-0000-4000-8000-000000000006';
const withheldId = '00000000-0000-4000-8000-000000000007';
const queryClients: QueryClient[] = [];
let originalClipboardDescriptor: PropertyDescriptor | undefined;
let clipboardDescriptorCaptured = false;

function blocker(
  id: string,
  otherTaskId: string,
  title: string,
  status: string,
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
    otherTaskStatus: status,
  };
}

function readiness(id = taskId, blockedBy: Array<Record<string, unknown>> = [], dependencyCount = blockedBy.length) {
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

function blockerList() {
  return within(screen.getByRole('list'));
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

describe('TaskReadiness loaded blocker status filter', () => {
  it('defaults to all statuses, composes exact status with search, preserves order/counts, and recovers from zero results', async () => {
    const rows = [
      blocker('00000000-0000-4000-8000-000000000101', todoId, 'Needle todo', 'todo'),
      blocker('00000000-0000-4000-8000-000000000102', progressId, 'Needle progress first', 'in_progress'),
      blocker('00000000-0000-4000-8000-000000000103', reviewId, 'Needle review', 'review'),
      blocker('00000000-0000-4000-8000-000000000104', blockedId, 'Other blocked', 'blocked'),
      blocker('00000000-0000-4000-8000-000000000105', progressId, 'Needle progress second', 'in_progress'),
      blocker('00000000-0000-4000-8000-000000000106', extraTodoId, 'Needle additional todo', 'todo'),
      blocker('00000000-0000-4000-8000-000000000107', unknownId, 'Needle unknown', 'future_status'),
      blocker('00000000-0000-4000-8000-000000000108', withheldId, 'Needle private title', 'review', true),
    ];
    const get = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness(taskId, rows, 11),
    } as never);
    const mutations = [
      vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('unexpected mutation')),
      vi.spyOn(apiClient, 'put').mockRejectedValue(new Error('unexpected mutation')),
      vi.spyOn(apiClient, 'patch').mockRejectedValue(new Error('unexpected mutation')),
      vi.spyOn(apiClient, 'delete').mockRejectedValue(new Error('unexpected mutation')),
    ];
    renderReadiness();

    const status = await screen.findByRole('combobox', { name: 'Blocker status' });
    expect(status).toHaveValue('all');
    expect(Array.from((status as HTMLSelectElement).options).map((option) => [option.value, option.textContent]))
      .toEqual([
        ['all', 'All blocker statuses'],
        ['todo', 'To Do'],
        ['in_progress', 'In Progress'],
        ['review', 'Review'],
        ['blocked', 'Blocked'],
      ]);
    expect(screen.getByText('8 of 11 dependency links are blocking this task.')).toBeInTheDocument();
    expect(screen.getAllByText('Blocked', { selector: 'div' })).toHaveLength(2);
    expect(blockerList().getAllByRole('listitem')).toHaveLength(8);
    expect(blockerList().getByText('Needle unknown')).toBeVisible();
    expect(blockerList().getByText(withheldId)).toBeVisible();
    expect(screen.queryByText('Needle private title')).not.toBeInTheDocument();
    expect(blockerList().queryByText('future_status')).not.toBeInTheDocument();

    fireEvent.change(status, { target: { value: 'review' } });
    expect(blockerList().getAllByRole('listitem')).toHaveLength(2);
    expect(blockerList().getAllByRole('listitem').map((item) => item.textContent?.replace(/\s+/g, ' ').trim()))
      .toEqual([`Needle reviewReview`, `${withheldId}Review`]);
    expect(screen.getByText('Showing 2 of 8 loaded blocking dependencies.')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded blockers' }), {
      target: { value: ' needle ' },
    });
    expect(blockerList().getAllByRole('listitem').map((item) => item.textContent?.replace(/\s+/g, ' ').trim()))
      .toEqual(['Needle reviewReview']);
    expect(screen.getByText('Showing 1 of 8 loaded blocking dependencies.')).toBeInTheDocument();
    expect(screen.queryByText('Needle private title')).not.toBeInTheDocument();

    fireEvent.change(status, { target: { value: 'in_progress' } });
    expect(blockerList().getAllByRole('listitem').map((item) => item.textContent?.replace(/\s+/g, ' ').trim()))
      .toEqual(['Needle progress firstIn Progress', 'Needle progress secondIn Progress']);
    expect(screen.getByText('Showing 2 of 8 loaded blocking dependencies.')).toBeInTheDocument();

    fireEvent.change(status, { target: { value: 'blocked' } });
    expect(screen.getByText(
      'No loaded blocking dependencies match the selected filters. Choose All blocker statuses or clear search to broaden the loaded results.',
    )).toBeVisible();
    expect(screen.getByText('Showing 0 of 8 loaded blocking dependencies.')).toBeInTheDocument();

    fireEvent.change(status, { target: { value: 'all' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(status).toHaveValue('all');
    expect(screen.getByRole('searchbox', { name: 'Search loaded blockers' })).toHaveValue('');
    expect(blockerList().getAllByRole('listitem')).toHaveLength(8);
    expect(screen.getByText('8 of 11 dependency links are blocking this task.')).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(`/tasks/${taskId}/readiness`);
    mutations.forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
  });

  it('preserves status selection through same-task refresh and an empty-to-populated round trip', async () => {
    const rows = [blocker('00000000-0000-4000-8000-000000000201', progressId, 'Progress blocker', 'in_progress')];
    const get = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ data: readiness(taskId, rows) } as never);
    const view = renderReadiness();
    const status = await screen.findByRole('combobox', { name: 'Blocker status' });
    fireEvent.change(status, { target: { value: 'review' } });

    await act(async () => {
      view.queryClient.setQueryData(['tasks', taskId, 'readiness'], readiness(taskId));
    });
    expect(await screen.findByText('Ready: no dependency links.')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Blocker status' })).not.toBeInTheDocument();

    const refreshedRows = [
      blocker('00000000-0000-4000-8000-000000000202', reviewId, 'Review blocker', 'review'),
      blocker('00000000-0000-4000-8000-000000000203', progressId, 'Progress blocker', 'in_progress'),
    ];
    await act(async () => {
      view.queryClient.setQueryData(['tasks', taskId, 'readiness'], readiness(taskId, refreshedRows));
    });
    expect(await screen.findByRole('combobox', { name: 'Blocker status' })).toHaveValue('review');
    expect(blockerList().getAllByRole('listitem')).toHaveLength(1);
    expect(blockerList().getByText('Review blocker')).toBeVisible();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('resets the filter across A-to-B-to-A task identity changes', async () => {
    const firstRows = [
      blocker('00000000-0000-4000-8000-000000000301', progressId, 'Task A progress', 'in_progress', false, taskId),
      blocker('00000000-0000-4000-8000-000000000302', blockedId, 'Task A blocked', 'blocked', false, taskId),
    ];
    const secondRows = [
      blocker('00000000-0000-4000-8000-000000000303', todoId, 'Task B todo', 'todo', false, otherTaskId),
      blocker('00000000-0000-4000-8000-000000000304', reviewId, 'Task B review', 'review', false, otherTaskId),
    ];
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async (url) => {
      if (url === `/tasks/${taskId}/readiness`) return { data: readiness(taskId, firstRows) } as never;
      if (url === `/tasks/${otherTaskId}/readiness`) return { data: readiness(otherTaskId, secondRows) } as never;
      throw new Error(`unexpected readiness request: ${url}`);
    });
    const view = renderReadiness();
    const statusA = await screen.findByRole('combobox', { name: 'Blocker status' });
    fireEvent.change(statusA, { target: { value: 'blocked' } });
    expect(blockerList().getByText('Task A blocked')).toBeVisible();

    view.rerenderTask(otherTaskId);
    const statusB = await screen.findByRole('combobox', { name: 'Blocker status' });
    expect(statusB).toHaveValue('all');
    fireEvent.change(statusB, { target: { value: 'review' } });
    expect(blockerList().getByText('Task B review')).toBeVisible();

    view.rerenderTask(taskId);
    const statusAAgain = await screen.findByRole('combobox', { name: 'Blocker status' });
    expect(statusAAgain).toHaveValue('all');
    expect(blockerList().getAllByRole('listitem')).toHaveLength(2);
    expect(get.mock.calls.map(([url]) => url)).toEqual([
      `/tasks/${taskId}/readiness`,
      `/tasks/${otherTaskId}/readiness`,
      `/tasks/${taskId}/readiness`,
    ]);
  });

  it('copies deduplicated loaded IDs and only the current status-and-search rows without another read', async () => {
    const rows = [
      blocker('00000000-0000-4000-8000-000000000401', progressId, 'Needle first', 'in_progress'),
      blocker('00000000-0000-4000-8000-000000000402', progressId, 'Needle duplicate ID', 'in_progress'),
      blocker('00000000-0000-4000-8000-000000000403', reviewId, 'Needle review', 'review'),
      blocker('00000000-0000-4000-8000-000000000404', todoId, 'Other todo', 'todo'),
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
    renderReadiness();

    const status = await screen.findByRole('combobox', { name: 'Blocker status' });
    fireEvent.change(status, { target: { value: 'in_progress' } });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded blockers' }), {
      target: { value: ' needle ' },
    });
    expect(blockerList().getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Copy loaded blocker IDs' }));
    expect(writeText).toHaveBeenNthCalledWith(1, `${progressId}\n${reviewId}\n${todoId}`);
    expect(await screen.findByText('Blocker IDs copied.')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Copy visible blocker IDs (1)' }));
    expect(writeText).toHaveBeenNthCalledWith(2, progressId);
    expect(await screen.findByText('Visible blocker IDs copied.')).toBeVisible();
    expect(get).toHaveBeenCalledTimes(1);
    mutations.forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
  });

  it('drops pending visible-copy feedback when the selected status changes', async () => {
    const rows = [
      blocker('00000000-0000-4000-8000-000000000501', progressId, 'Progress blocker', 'in_progress'),
      blocker('00000000-0000-4000-8000-000000000502', blockedId, 'Blocked blocker', 'blocked'),
    ];
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ data: readiness(taskId, rows) } as never);
    let resolveWrite: (() => void) | undefined;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { resolveWrite = resolve; }));
    setClipboard(writeText);
    renderReadiness();

    const status = await screen.findByRole('combobox', { name: 'Blocker status' });
    fireEvent.change(status, { target: { value: 'in_progress' } });
    const copyButton = screen.getByRole('button', { name: 'Copy visible blocker IDs (1)' });
    fireEvent.click(copyButton);
    expect(copyButton).toBeDisabled();
    expect(writeText).toHaveBeenCalledWith(progressId);

    fireEvent.change(status, { target: { value: 'blocked' } });
    const currentCopyButton = screen.getByRole('button', { name: 'Copy visible blocker IDs (1)' });
    expect(currentCopyButton).toBeEnabled();
    expect(screen.queryByText('Visible blocker IDs copied.')).not.toBeInTheDocument();
    await act(async () => resolveWrite?.());
    expect(screen.queryByText('Visible blocker IDs copied.')).not.toBeInTheDocument();
  });
});
