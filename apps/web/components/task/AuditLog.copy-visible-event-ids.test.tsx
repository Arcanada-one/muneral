import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import apiClient from '@/lib/api/client';
import { AuditLog } from './AuditLog';

interface ActivityEntry {
  id: string;
  taskId: string;
  actorId: string;
  actorName: string;
  actorType: 'human' | 'agent';
  action: string;
  payload: null;
  createdAt: string;
}

interface ActivityState {
  data?: {
    data: ActivityEntry[];
    total: number;
    page: number;
    limit: number;
  };
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
}

const activityState = vi.hoisted(() => ({
  results: new Map<string, ActivityState>(),
  requestedKeys: [] as string[],
  refetch: vi.fn(),
}));
const apiClientMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@/lib/api/tasks', () => ({
  useActivity: (taskId: string, page = 1) => {
    const key = `${taskId}:${page}`;
    activityState.requestedKeys.push(key);
    return {
      ...(activityState.results.get(key) ?? {
        data: { data: [], total: 0, page, limit: 20 },
        isLoading: false,
        isError: false,
        isFetching: false,
      }),
      refetch: activityState.refetch,
    };
  },
}));

vi.mock('@/lib/api/client', () => ({ default: apiClientMock }));

const taskA = '11111111-1111-4111-8111-111111111111';
const taskB = '22222222-2222-4222-8222-222222222222';
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function entry(
  id: string,
  options: Partial<Omit<ActivityEntry, 'id'>> = {},
): ActivityEntry {
  const actorId = options.actorId ?? `actor-${id}`;
  return {
    id,
    taskId: options.taskId ?? taskA,
    actorId,
    actorName: options.actorName ?? `Actor ${actorId}`,
    actorType: options.actorType ?? 'human',
    action: options.action ?? 'task:updated',
    payload: null,
    createdAt: options.createdAt ?? '2026-11-02T00:00:00.000Z',
  };
}

function ready(
  taskId: string,
  page: number,
  entries: ActivityEntry[],
  total = entries.length,
  limit = 20,
) {
  activityState.results.set(`${taskId}:${page}`, {
    data: { data: entries, total, page, limit },
    isLoading: false,
    isError: false,
    isFetching: false,
  });
}

function loading(taskId: string, page: number) {
  activityState.results.set(`${taskId}:${page}`, {
    data: undefined,
    isLoading: true,
    isError: false,
    isFetching: false,
  });
}

function failed(taskId: string, page: number) {
  activityState.results.set(`${taskId}:${page}`, {
    data: undefined,
    isLoading: false,
    isError: true,
    isFetching: false,
  });
}

function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

function bulkCopyButton(count: number) {
  return screen.getByRole('button', { name: `Copy visible activity event IDs (${count})` });
}

function rowForActor(actorName: string) {
  const row = screen.getByText(actorName).closest('li');
  if (!row) throw new Error(`Missing activity row for ${actorName}`);
  return row;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  activityState.results.clear();
  activityState.requestedKeys = [];
  activityState.refetch = vi.fn();
  Object.values(apiClientMock).forEach((method) => method.mockClear());
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

describe('copy visible activity event IDs', () => {
  it('copies the current page IDs after intersecting action and actor filters, preserving order and duplicates', async () => {
    const rows = [
      entry('event-one', { actorId: 'actor-one', action: 'task:status_changed' }),
      entry('event-hidden-action', { actorId: 'actor-two', action: 'task:created' }),
      entry('event-hidden-actor', {
        actorId: 'actor-three', actorType: 'agent', action: 'task:status_changed',
      }),
      entry('event-one', { actorId: 'actor-four', action: 'task:status_changed' }),
      entry('event-other-task', {
        actorId: 'actor-five', taskId: taskB, action: 'task:status_changed',
      }),
    ];
    ready(taskA, 1, rows, rows.length);
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const navigation = vi.spyOn(history, 'pushState');

    render(<AuditLog taskId={taskA} />);
    expect(writeText).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Activity filter' }), {
      target: { value: 'status_changes' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Actor filter' }), {
      target: { value: 'humans' },
    });

    expect(bulkCopyButton(2)).toBeEnabled();
    fireEvent.click(bulkCopyButton(2));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith('event-one\nevent-one');
    expect(writeText.mock.calls[0][0]).not.toContain('actor-');
    expect(await screen.findByText('Activity event IDs copied.')).toBeInTheDocument();
    expect(Object.values(apiClientMock).every((method) => method.mock.calls.length === 0)).toBe(true);
    expect(activityState.refetch).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
    expect(navigation).not.toHaveBeenCalled();
  });

  it('disables an empty batch and exposes no old batch while loading or in error', async () => {
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    ready(taskA, 1, []);
    const view = render(<AuditLog taskId={taskA} />);

    expect(bulkCopyButton(0)).toBeDisabled();
    fireEvent.click(bulkCopyButton(0));
    expect(writeText).not.toHaveBeenCalled();

    loading(taskA, 1);
    view.rerender(<AuditLog taskId={taskA} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy visible activity event IDs/ })).not.toBeInTheDocument();

    failed(taskA, 1);
    view.rerender(<AuditLog taskId={taskA} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Activity is unavailable.');
    expect(screen.queryByRole('button', { name: /Copy visible activity event IDs/ })).not.toBeInTheDocument();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('guards re-entry, waits for resolution, and keeps bulk and row copy independent', async () => {
    const bulkWrite = deferred<void>();
    const rowWrite = deferred<void>();
    const writeText = installClipboard(vi.fn()
      .mockReturnValueOnce(bulkWrite.promise)
      .mockReturnValueOnce(rowWrite.promise));
    ready(taskA, 1, [entry('event-one')]);
    render(<AuditLog taskId={taskA} />);

    const bulkButton = bulkCopyButton(1);
    act(() => {
      fireEvent.click(bulkButton);
      fireEvent.click(bulkButton);
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('event-one');
    expect(bulkButton).toBeDisabled();
    expect(screen.queryByText('Activity event IDs copied.')).not.toBeInTheDocument();

    const row = rowForActor('Actor actor-event-one');
    const rowButton = within(row).getByRole('button', { name: 'Copy activity event ID' });
    fireEvent.click(rowButton);
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenNthCalledWith(2, 'event-one');
    expect(rowButton).toBeDisabled();
    expect(bulkButton).toBeDisabled();

    await act(async () => rowWrite.resolve());
    expect(await within(row).findByText('Activity event ID copied.')).toBeInTheDocument();
    expect(screen.queryByText('Activity event IDs copied.')).not.toBeInTheDocument();
    expect(rowButton).toBeEnabled();
    expect(bulkButton).toBeDisabled();

    await act(async () => bulkWrite.resolve());
    expect(await screen.findByText('Activity event IDs copied.')).toBeInTheDocument();
    expect(bulkButton).toBeEnabled();
  });

  it('shows generic rejection or unavailable feedback and permits retry', async () => {
    const writeText = installClipboard(vi.fn()
      .mockRejectedValueOnce(new Error('private event payload'))
      .mockResolvedValueOnce(undefined));
    ready(taskA, 1, [entry('event-secret-value')]);
    render(<AuditLog taskId={taskA} />);

    fireEvent.click(bulkCopyButton(1));
    const failure = await screen.findByRole('alert');
    expect(failure).toHaveTextContent('Could not copy activity event IDs. Try copying them manually.');
    expect(failure).not.toHaveTextContent('private event payload');
    expect(failure).not.toHaveTextContent('event-secret-value');

    fireEvent.click(bulkCopyButton(1));
    expect(await screen.findByText('Activity event IDs copied.')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledTimes(2);

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {} });
    fireEvent.click(bulkCopyButton(1));
    const unavailable = await screen.findByRole('alert');
    expect(unavailable).toHaveTextContent('Could not copy activity event IDs.');
    expect(unavailable).not.toHaveTextContent('Clipboard unavailable');

    const recoveredWrite = installClipboard(vi.fn().mockResolvedValue(undefined));
    fireEvent.click(bulkCopyButton(1));
    expect(recoveredWrite).toHaveBeenCalledWith('event-secret-value');
    expect(await screen.findByText('Activity event IDs copied.')).toBeInTheDocument();
  });

  it('suppresses a stale success across filter A-B-A even when the restored batch is identical', async () => {
    const staleWrite = deferred<void>();
    const currentWrite = deferred<void>();
    const writeText = installClipboard(vi.fn()
      .mockReturnValueOnce(staleWrite.promise)
      .mockReturnValueOnce(currentWrite.promise));
    ready(taskA, 1, [
      entry('event-one', { action: 'task:status_changed' }),
      entry('event-two', { action: 'task:created' }),
    ]);
    render(<AuditLog taskId={taskA} />);

    fireEvent.click(bulkCopyButton(2));
    expect(writeText).toHaveBeenCalledWith('event-one\nevent-two');
    const filter = screen.getByRole('combobox', { name: 'Activity filter' });
    fireEvent.change(filter, { target: { value: 'status_changes' } });
    expect(bulkCopyButton(1)).toBeEnabled();
    fireEvent.change(filter, { target: { value: 'all' } });
    expect(bulkCopyButton(2)).toBeEnabled();

    await act(async () => staleWrite.resolve());
    expect(screen.queryByText('Activity event IDs copied.')).not.toBeInTheDocument();
    fireEvent.click(bulkCopyButton(2));
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenNthCalledWith(2, 'event-one\nevent-two');
    await act(async () => currentWrite.resolve());
    expect(await screen.findByText('Activity event IDs copied.')).toBeInTheDocument();
  });

  it('suppresses a stale rejection when the actor-filtered batch changes', async () => {
    const staleWrite = deferred<void>();
    const currentWrite = deferred<void>();
    const writeText = installClipboard(vi.fn()
      .mockReturnValueOnce(staleWrite.promise)
      .mockReturnValueOnce(currentWrite.promise));
    ready(taskA, 1, [
      entry('event-human', { actorType: 'human' }),
      entry('event-agent', { actorType: 'agent' }),
    ]);
    render(<AuditLog taskId={taskA} />);

    fireEvent.click(bulkCopyButton(2));
    fireEvent.change(screen.getByRole('combobox', { name: 'Actor filter' }), {
      target: { value: 'humans' },
    });
    await act(async () => staleWrite.reject(new Error('stale clipboard failure')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(bulkCopyButton(1));
    expect(writeText).toHaveBeenNthCalledWith(2, 'event-human');
    await act(async () => currentWrite.resolve());
    expect(await screen.findByText('Activity event IDs copied.')).toBeInTheDocument();
  });

  it('uses the current page and suppresses a completion from the previous page', async () => {
    const staleWrite = deferred<void>();
    const currentWrite = deferred<void>();
    const writeText = installClipboard(vi.fn()
      .mockReturnValueOnce(staleWrite.promise)
      .mockReturnValueOnce(currentWrite.promise));
    ready(taskA, 1, [entry('event-page-one')], 2, 1);
    ready(taskA, 2, [entry('event-page-two')], 2, 1);
    render(<AuditLog taskId={taskA} />);

    fireEvent.click(bulkCopyButton(1));
    expect(writeText).toHaveBeenCalledWith('event-page-one');
    fireEvent.click(screen.getByRole('button', { name: 'Next activity page' }));
    expect(bulkCopyButton(1)).toBeEnabled();
    await act(async () => staleWrite.resolve());
    expect(screen.queryByText('Activity event IDs copied.')).not.toBeInTheDocument();

    fireEvent.click(bulkCopyButton(1));
    expect(writeText).toHaveBeenNthCalledWith(2, 'event-page-two');
    await act(async () => currentWrite.resolve());
    expect(await screen.findByText('Activity event IDs copied.')).toBeInTheDocument();
  });

  it('invalidates pending feedback after same-task data refresh and copies the refreshed batch', async () => {
    const staleWrite = deferred<void>();
    const currentWrite = deferred<void>();
    const writeText = installClipboard(vi.fn()
      .mockReturnValueOnce(staleWrite.promise)
      .mockReturnValueOnce(currentWrite.promise));
    ready(taskA, 1, [entry('event-before-refresh')]);
    const view = render(<AuditLog taskId={taskA} />);

    fireEvent.click(bulkCopyButton(1));
    ready(taskA, 1, [entry('event-after-refresh')]);
    view.rerender(<AuditLog taskId={taskA} />);
    await act(async () => staleWrite.reject(new Error('stale rejection')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(bulkCopyButton(1)).toBeEnabled();

    fireEvent.click(bulkCopyButton(1));
    expect(writeText).toHaveBeenNthCalledWith(2, 'event-after-refresh');
    await act(async () => currentWrite.resolve());
    expect(await screen.findByText('Activity event IDs copied.')).toBeInTheDocument();
  });

  it('suppresses old completion across task switch and clears the batch while loading', async () => {
    const staleWrite = deferred<void>();
    const currentWrite = deferred<void>();
    const writeText = installClipboard(vi.fn()
      .mockReturnValueOnce(staleWrite.promise)
      .mockReturnValueOnce(currentWrite.promise));
    ready(taskA, 1, [entry('event-task-a')]);
    ready(taskB, 1, [entry('event-task-b', { taskId: taskB })]);
    const view = render(<AuditLog taskId={taskA} />);

    fireEvent.click(bulkCopyButton(1));
    view.rerender(<AuditLog taskId={taskB} />);
    await act(async () => staleWrite.resolve());
    expect(screen.queryByText('Activity event IDs copied.')).not.toBeInTheDocument();

    fireEvent.click(bulkCopyButton(1));
    expect(writeText).toHaveBeenNthCalledWith(2, 'event-task-b');
    loading(taskB, 1);
    view.rerender(<AuditLog taskId={taskB} />);
    expect(screen.queryByRole('button', { name: /Copy visible activity event IDs/ })).not.toBeInTheDocument();
    await act(async () => currentWrite.reject(new Error('stale loading failure')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(writeText).toHaveBeenCalledTimes(2);
  });
});
