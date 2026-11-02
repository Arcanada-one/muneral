import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import apiClient from '@/lib/api/client';
import { TaskReadiness } from './TaskReadiness';

const taskId = '11111111-1111-4111-8111-111111111111';
const otherTaskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const firstId = '00000000-0000-4000-8000-000000000001';
const reviewId = '00000000-0000-4000-8000-000000000002';
const secondId = '00000000-0000-4000-8000-000000000003';
const thirdId = '00000000-0000-4000-8000-000000000004';
const todoId = '00000000-0000-4000-8000-000000000005';
const queryClients: QueryClient[] = [];
let originalClipboardDescriptor: PropertyDescriptor | undefined;
let clipboardDescriptorCaptured = false;

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
  return within(screen.getByRole('list', { name: 'Loaded blocking dependencies' }));
}

function rowLabels() {
  return blockerList().getAllByRole('listitem').map((item) => item.textContent?.replace(/\s+/g, ' ').trim());
}

function spyOnMutations() {
  return [
    vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('unexpected mutation')),
    vi.spyOn(apiClient, 'put').mockRejectedValue(new Error('unexpected mutation')),
    vi.spyOn(apiClient, 'patch').mockRejectedValue(new Error('unexpected mutation')),
    vi.spyOn(apiClient, 'delete').mockRejectedValue(new Error('unexpected mutation')),
  ];
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

describe('TaskReadiness reverse loaded blocker order', () => {
  it('reverses only the filtered rendered rows, restores server order, and copies each visible row ID in that order', async () => {
    const rows = [
      blocker('00000000-0000-4000-8000-000000000101', firstId, 'Needle first progress', 'in_progress'),
      blocker('00000000-0000-4000-8000-000000000102', reviewId, 'Needle review', 'review'),
      blocker('00000000-0000-4000-8000-000000000103', secondId, 'Needle second progress', 'in_progress'),
      blocker('00000000-0000-4000-8000-000000000104', thirdId, 'Needle third progress', 'in_progress'),
      blocker('00000000-0000-4000-8000-000000000105', firstId, 'Needle duplicate progress', 'in_progress'),
      blocker('00000000-0000-4000-8000-000000000106', todoId, 'Other todo', 'todo'),
    ];
    const get = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ data: readiness(taskId, rows, 9) } as never);
    const mutations = spyOnMutations();
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    renderReadiness();

    const reverse = await screen.findByRole('checkbox', { name: 'Reverse loaded blocker order' });
    expect(reverse).not.toBeChecked();
    expect(rowLabels()).toEqual([
      'Needle first progressIn Progress',
      'Needle reviewReview',
      'Needle second progressIn Progress',
      'Needle third progressIn Progress',
      'Needle duplicate progressIn Progress',
      'Other todoTo Do',
    ]);
    expect(screen.getByText('6 of 9 dependency links are blocking this task.')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Blocker status' }), {
      target: { value: 'in_progress' },
    });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded blockers' }), {
      target: { value: 'needle' },
    });
    expect(rowLabels()).toEqual([
      'Needle first progressIn Progress',
      'Needle second progressIn Progress',
      'Needle third progressIn Progress',
      'Needle duplicate progressIn Progress',
    ]);

    fireEvent.click(reverse);
    expect(reverse).toBeChecked();
    expect(rowLabels()).toEqual([
      'Needle duplicate progressIn Progress',
      'Needle third progressIn Progress',
      'Needle second progressIn Progress',
      'Needle first progressIn Progress',
    ]);
    fireEvent.click(reverse);
    expect(reverse).not.toBeChecked();
    expect(rowLabels()[0]).toBe('Needle first progressIn Progress');
    fireEvent.click(reverse);

    fireEvent.click(screen.getByRole('button', { name: 'Copy loaded blocker IDs' }));
    expect(writeText).toHaveBeenNthCalledWith(1, `${firstId}\n${reviewId}\n${secondId}\n${thirdId}\n${todoId}`);
    expect(await screen.findByText('Blocker IDs copied.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Copy visible blocker IDs (3)' }));
    expect(writeText).toHaveBeenNthCalledWith(2, `${firstId}\n${thirdId}\n${secondId}`);
    expect(await screen.findByText('Visible blocker IDs copied.')).toBeVisible();

    expect(screen.getByText('6 of 9 dependency links are blocking this task.')).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(`/tasks/${taskId}/readiness`);
    mutations.forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
  });

  it('keeps the preference through same-task updates and an empty round trip without affecting loaded counts', async () => {
    const firstRows = [
      blocker('00000000-0000-4000-8000-000000000201', firstId, 'First todo', 'todo'),
      blocker('00000000-0000-4000-8000-000000000202', secondId, 'Second review', 'review'),
    ];
    const get = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ data: readiness(taskId, firstRows, 5) } as never);
    const mutations = spyOnMutations();
    const view = renderReadiness();
    const reverse = await screen.findByRole('checkbox', { name: 'Reverse loaded blocker order' });
    fireEvent.click(reverse);

    const refreshedRows = [
      blocker('00000000-0000-4000-8000-000000000203', thirdId, 'Refreshed first', 'blocked'),
      blocker('00000000-0000-4000-8000-000000000204', todoId, 'Refreshed second', 'todo'),
    ];
    await act(async () => {
      view.queryClient.setQueryData(['tasks', taskId, 'readiness'], readiness(taskId, refreshedRows, 7));
    });
    expect(screen.getByRole('checkbox', { name: 'Reverse loaded blocker order' })).toBeChecked();
    expect(await screen.findByText('Refreshed second')).toBeVisible();
    expect(rowLabels()).toEqual(['Refreshed secondTo Do', 'Refreshed firstBlocked']);
    expect(screen.getByText('2 of 7 dependency links are blocking this task.')).toBeInTheDocument();

    await act(async () => {
      view.queryClient.setQueryData(['tasks', taskId, 'readiness'], readiness(taskId, [], 0));
    });
    expect(await screen.findByText('Ready: no dependency links.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Reverse loaded blocker order' })).not.toBeInTheDocument();

    const returnedRows = [
      blocker('00000000-0000-4000-8000-000000000205', firstId, 'Returned todo', 'todo'),
      blocker('00000000-0000-4000-8000-000000000206', secondId, 'Returned review', 'review'),
    ];
    await act(async () => {
      view.queryClient.setQueryData(['tasks', taskId, 'readiness'], readiness(taskId, returnedRows, 4));
    });
    expect(await screen.findByText('Returned review')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: 'Reverse loaded blocker order' })).toBeChecked();
    expect(rowLabels()).toEqual(['Returned reviewReview', 'Returned todoTo Do']);

    const status = screen.getByRole('combobox', { name: 'Blocker status' });
    fireEvent.change(status, { target: { value: 'todo' } });
    expect(screen.getByRole('checkbox', { name: 'Reverse loaded blocker order' })).toBeChecked();
    expect(rowLabels()).toEqual(['Returned todoTo Do']);
    fireEvent.change(status, { target: { value: 'all' } });
    expect(rowLabels()).toEqual(['Returned reviewReview', 'Returned todoTo Do']);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(`/tasks/${taskId}/readiness`);
    mutations.forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
  });

  it('resets to server order when task identity changes, including A-to-B-to-A', async () => {
    const taskARows = [
      blocker('00000000-0000-4000-8000-000000000301', firstId, 'Task A first', 'todo', taskId),
      blocker('00000000-0000-4000-8000-000000000302', secondId, 'Task A second', 'review', taskId),
    ];
    const taskBRows = [
      blocker('00000000-0000-4000-8000-000000000303', thirdId, 'Task B first', 'todo', otherTaskId),
      blocker('00000000-0000-4000-8000-000000000304', todoId, 'Task B second', 'blocked', otherTaskId),
    ];
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async (url) => {
      if (url === `/tasks/${taskId}/readiness`) return { data: readiness(taskId, taskARows) } as never;
      if (url === `/tasks/${otherTaskId}/readiness`) return { data: readiness(otherTaskId, taskBRows) } as never;
      throw new Error(`unexpected readiness request: ${url}`);
    });
    const mutations = spyOnMutations();
    const view = renderReadiness();
    const reverseA = await screen.findByRole('checkbox', { name: 'Reverse loaded blocker order' });
    fireEvent.click(reverseA);
    expect(rowLabels()).toEqual(['Task A secondReview', 'Task A firstTo Do']);

    view.rerenderTask(otherTaskId);
    const reverseB = await screen.findByRole('checkbox', { name: 'Reverse loaded blocker order' });
    expect(reverseB).not.toBeChecked();
    expect(rowLabels()).toEqual(['Task B firstTo Do', 'Task B secondBlocked']);

    view.rerenderTask(taskId);
    const reverseAAgain = await screen.findByRole('checkbox', { name: 'Reverse loaded blocker order' });
    expect(reverseAAgain).not.toBeChecked();
    expect(rowLabels()).toEqual(['Task A firstTo Do', 'Task A secondReview']);
    expect(get.mock.calls.map(([url]) => url)).toEqual([
      `/tasks/${taskId}/readiness`,
      `/tasks/${otherTaskId}/readiness`,
      `/tasks/${taskId}/readiness`,
    ]);
    mutations.forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
  });

  it('clears stale copy feedback on every reverse change and keeps duplicate-copy suppression while pending', async () => {
    const rows = [
      blocker('00000000-0000-4000-8000-000000000401', firstId, 'First blocker', 'todo'),
      blocker('00000000-0000-4000-8000-000000000402', secondId, 'Second blocker', 'review'),
      blocker('00000000-0000-4000-8000-000000000403', thirdId, 'Third blocker', 'blocked'),
    ];
    const get = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ data: readiness(taskId, rows) } as never);
    const mutations = spyOnMutations();
    let resolvePendingCopy: (() => void) | undefined;
    const writeText = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolvePendingCopy = resolve; }))
      .mockResolvedValueOnce(undefined);
    setClipboard(writeText);
    renderReadiness();

    const reverse = await screen.findByRole('checkbox', { name: 'Reverse loaded blocker order' });
    const copyButton = screen.getByRole('button', { name: 'Copy visible blocker IDs (3)' });
    fireEvent.click(copyButton);
    expect(copyButton).toBeDisabled();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenNthCalledWith(1, `${firstId}\n${secondId}\n${thirdId}`);

    fireEvent.click(reverse);
    const pendingButtonForNewOrder = screen.getByRole('button', { name: 'Copy visible blocker IDs (3)' });
    expect(pendingButtonForNewOrder).toBeEnabled();
    fireEvent.click(pendingButtonForNewOrder);
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenNthCalledWith(2, `${thirdId}\n${secondId}\n${firstId}`);
    expect(await screen.findByText('Visible blocker IDs copied.')).toBeVisible();

    await act(async () => resolvePendingCopy?.());
    expect(screen.getByText('Visible blocker IDs copied.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Copy visible blocker IDs (3)' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Copy visible blocker IDs (3)' }));
    expect(writeText).toHaveBeenNthCalledWith(3, `${thirdId}\n${secondId}\n${firstId}`);
    expect(await screen.findByText('Visible blocker IDs copied.')).toBeVisible();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(`/tasks/${taskId}/readiness`);
    mutations.forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
  });
});
