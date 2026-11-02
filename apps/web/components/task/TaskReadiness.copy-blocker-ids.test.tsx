import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import apiClient from '@/lib/api/client';
import { TaskReadiness } from './TaskReadiness';

const taskId = '11111111-1111-4111-8111-111111111111';
const anotherTaskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const firstBlockerId = '22222222-2222-4222-8222-222222222222';
const secondBlockerId = '33333333-3333-4333-8333-333333333333';
const thirdBlockerId = '44444444-4444-4444-8444-444444444444';
const firstEdgeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const secondEdgeId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const thirdEdgeId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const queryClients: QueryClient[] = [];
let originalClipboardDescriptor: PropertyDescriptor | undefined;
let clipboardDescriptorCaptured = false;

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
  options: { dependencyCount?: number } = {},
) {
  return {
    taskId: id,
    dependencyCount: options.dependencyCount ?? blockedBy.length,
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

describe('TaskReadiness loaded blocker ID copy', () => {
  it('copies unique loaded IDs in first-seen order while preserving disclosure and blocker details', async () => {
    const rows = [
      blocker(firstEdgeId, firstBlockerId, 'Withheld blocker title', true),
      blocker(secondEdgeId, secondBlockerId, 'Visible blocker title'),
      blocker(thirdEdgeId, firstBlockerId, 'Duplicate blocker title'),
    ];
    const get = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness(taskId, rows, { dependencyCount: 4 }),
    } as never);
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

    expect(await screen.findByText('3 of 4 dependency links are blocking this task.')).toBeInTheDocument();
    const blockerList = screen.getByRole('list', { name: 'Loaded blocking dependencies' });
    expect(within(blockerList).getByText('Blocked', { exact: true })).toBeInTheDocument();
    expect(within(blockerList).getAllByRole('listitem')).toHaveLength(3);
    expect(within(blockerList).queryByText('Withheld blocker title')).not.toBeInTheDocument();
    expect(within(blockerList).getByText('Visible blocker title')).toBeVisible();
    expect(within(blockerList).getAllByText('In Progress')).toHaveLength(3);
    expect(within(blockerList).getAllByRole('button', { name: /^Copy blocker task ID / })).toHaveLength(3);

    const batchButton = screen.getByRole('button', { name: 'Copy loaded blocker IDs' });
    expect(batchButton).toHaveAttribute('type', 'button');
    expect(writeText).not.toHaveBeenCalled();
    const disclosure = screen.getByRole('button', { name: 'Hide blocking tasks' });
    fireEvent.click(disclosure);
    expect(screen.getByRole('button', { name: 'Show blocking tasks' })).toHaveAttribute('aria-expanded', 'false');
    expect(blockerList).not.toBeVisible();
    expect(batchButton).toBeVisible();

    fireEvent.click(batchButton);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(`${firstBlockerId}\n${secondBlockerId}`);
    expect(await screen.findByRole('status')).toHaveTextContent('Blocker IDs copied.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(window.location.href).toBe(initialLocation);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(`/tasks/${taskId}/readiness`);
    mutations.forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
  });

  it('does not expose the batch action in unknown, error, or ready-empty states', async () => {
    let finishLoading: ((value: unknown) => void) | undefined;
    const get = vi.spyOn(apiClient, 'get')
      .mockImplementationOnce(() => new Promise((resolve) => { finishLoading = resolve; }) as never)
      .mockRejectedValueOnce(new Error('synthetic read failure'))
      .mockResolvedValueOnce({ data: readiness(taskId) } as never)

    const noTask = renderReadiness('');
    expect(screen.getByText('Dependency readiness is unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy loaded blocker IDs' })).not.toBeInTheDocument();
    noTask.unmount();

    const loading = renderReadiness();
    expect(screen.getByText('Dependency readiness is unknown while it loads.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy loaded blocker IDs' })).not.toBeInTheDocument();
    await act(async () => finishLoading?.({ data: readiness() }));
    loading.unmount();

    const error = renderReadiness(anotherTaskId);
    expect(await screen.findByText('Dependency readiness is unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy loaded blocker IDs' })).not.toBeInTheDocument();
    error.unmount();

    const ready = renderReadiness();
    expect(await screen.findByText('Ready: no dependency links.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy loaded blocker IDs' })).not.toBeInTheDocument();
    ready.unmount();

    expect(get).toHaveBeenCalledTimes(3);
  });

  it('disables duplicate pending clicks and keeps legitimate pending state across same-identity refresh', async () => {
    const rows = [blocker(firstEdgeId, firstBlockerId, 'Blocker')];
    const get = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ data: readiness(taskId, rows) } as never);
    let finishCopy: (() => void) | undefined;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { finishCopy = resolve; }));
    setClipboard(writeText);
    const view = renderReadiness();

    const batchButton = await screen.findByRole('button', { name: 'Copy loaded blocker IDs' });
    fireEvent.click(batchButton);
    fireEvent.click(batchButton);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(batchButton).toBeDisabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await act(async () => {
      view.queryClient.setQueryData(
        ['tasks', taskId, 'readiness'],
        readiness(taskId, [blocker(firstEdgeId, firstBlockerId, 'Refreshed title')]),
      );
    });
    expect(screen.getByRole('button', { name: 'Copy loaded blocker IDs' })).toBeDisabled();

    await act(async () => finishCopy?.());
    expect(await screen.findByRole('status')).toHaveTextContent('Blocker IDs copied.');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('does not let an old ID snapshot announce completion after the loaded order changes', async () => {
    const rows = [
      blocker(firstEdgeId, firstBlockerId, 'First blocker'),
      blocker(secondEdgeId, secondBlockerId, 'Second blocker'),
    ];
    const get = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ data: readiness(taskId, rows) } as never);
    let finishOldCopy: (() => void) | undefined;
    const writeText = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishOldCopy = resolve; }))
      .mockResolvedValueOnce(undefined);
    setClipboard(writeText);
    const view = renderReadiness();

    const batchButton = await screen.findByRole('button', { name: 'Copy loaded blocker IDs' });
    fireEvent.click(batchButton);
    expect(writeText).toHaveBeenCalledWith(`${firstBlockerId}\n${secondBlockerId}`);
    expect(screen.getByRole('button', { name: 'Copy loaded blocker IDs' })).toBeDisabled();

    await act(async () => {
      view.queryClient.setQueryData(
        ['tasks', taskId, 'readiness'],
        readiness(taskId, [
          blocker(secondEdgeId, secondBlockerId, 'Second blocker moved first'),
          blocker(thirdEdgeId, thirdBlockerId, 'Third blocker moved second'),
        ]),
      );
    });
    expect(await screen.findByText('Second blocker moved first')).toBeVisible();
    const refreshedButton = screen.getByRole('button', { name: 'Copy loaded blocker IDs' });
    expect(refreshedButton).not.toBe(batchButton);
    expect(refreshedButton).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await act(async () => finishOldCopy?.());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    fireEvent.click(refreshedButton);
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith(`${secondBlockerId}\n${thirdBlockerId}`);
    expect(await screen.findByRole('status')).toHaveTextContent('Blocker IDs copied.');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('scopes a deferred completion to the task ID that started the copy', async () => {
    const get = vi.spyOn(apiClient, 'get').mockImplementation(async (url) => {
      if (url === `/tasks/${taskId}/readiness`) {
        return { data: readiness(taskId, [blocker(firstEdgeId, firstBlockerId, 'Original blocker')]) } as never;
      }
      if (url === `/tasks/${anotherTaskId}/readiness`) {
        return {
          data: readiness(anotherTaskId, [
            blocker(secondEdgeId, secondBlockerId, 'New task blocker', false, anotherTaskId),
          ]),
        } as never;
      }
      throw new Error(`unexpected readiness request: ${url}`);
    });
    let finishOldCopy: (() => void) | undefined;
    const writeText = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishOldCopy = resolve; }))
      .mockResolvedValueOnce(undefined);
    setClipboard(writeText);
    const view = renderReadiness();

    fireEvent.click(await screen.findByRole('button', { name: 'Copy loaded blocker IDs' }));
    expect(writeText).toHaveBeenCalledWith(firstBlockerId);
    view.rerenderTask(anotherTaskId);
    expect(await screen.findByText('New task blocker')).toBeVisible();
    const newTaskButton = screen.getByRole('button', { name: 'Copy loaded blocker IDs' });
    expect(newTaskButton).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    await act(async () => finishOldCopy?.());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.click(newTaskButton);
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith(secondBlockerId);
    expect(await screen.findByRole('status')).toHaveTextContent('Blocker IDs copied.');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('shows generic failure for rejected or unavailable clipboard without exposing exception text', async () => {
    const get = vi.spyOn(apiClient, 'get')
      .mockResolvedValueOnce({ data: readiness(taskId, [blocker(firstEdgeId, firstBlockerId, 'Blocker')]) } as never)
      .mockResolvedValueOnce({
        data: readiness(anotherTaskId, [blocker(secondEdgeId, secondBlockerId, 'Blocker', false, anotherTaskId)]),
      } as never);
    const rejectedWrite = vi.fn().mockRejectedValue(new Error(`clipboard denied for ${firstBlockerId}`));
    setClipboard(rejectedWrite);

    const rejected = renderReadiness();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy loaded blocker IDs' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not copy blocker IDs. Try copying them manually.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).not.toHaveTextContent(firstBlockerId);
    rejected.unmount();

    setClipboard();
    renderReadiness(anotherTaskId);
    fireEvent.click(await screen.findByRole('button', { name: 'Copy loaded blocker IDs' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not copy blocker IDs. Try copying them manually.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(2);
  });
});
