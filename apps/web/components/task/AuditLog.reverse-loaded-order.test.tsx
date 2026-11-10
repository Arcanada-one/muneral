import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from './AuditLog';

interface ActivityEntry {
  id: string;
  taskId: string;
  actorId: string;
  actorName: string;
  actorType: string;
  action: string;
  payload: unknown;
  createdAt: string;
}

interface ActivityResult {
  data: ActivityEntry[];
  total: number;
  page: number;
  limit: number;
}

interface ActivityState {
  data: ActivityResult | undefined;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
}

const activityState = vi.hoisted(() => ({
  results: new Map<string, ActivityState>(),
  queryKeys: [] as string[],
  refetch: vi.fn(),
}));

vi.mock('@/lib/api/tasks', () => ({
  useActivity: (taskId: string, page = 1) => {
    const key = `${taskId}:${page}`;
    if (activityState.queryKeys.at(-1) !== key) activityState.queryKeys.push(key);
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

const taskA = '11111111-1111-4111-8111-111111111111';
const taskB = '22222222-2222-4222-8222-222222222222';
const createdAt = '2026-11-02T12:34:56.789Z';
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function entry(
  id: string,
  actorType: string,
  action: string,
  taskId = taskA,
): ActivityEntry {
  return {
    id,
    taskId,
    actorId: `${id}-actor`,
    actorName: id,
    actorType,
    action,
    payload: action === 'task:status_changed' ? { from: 'todo', to: 'done' } : null,
    createdAt,
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

function visibleIds(): string[] {
  return screen.getAllByRole('listitem').map((row) => {
    const label = [...row.querySelectorAll('span')]
      .map((span) => span.textContent?.trim() ?? '')
      .find((text) => text.startsWith('event-'));
    return label ?? '';
  });
}

function orderButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Reverse loaded activity order' });
}

function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

function deferredClipboard() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  activityState.results.clear();
  activityState.queryKeys = [];
  activityState.refetch = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

describe('AuditLog reverse loaded activity order', () => {
  it('starts off, reverses a copy of the loaded rows and exposes a scoped pressed state', () => {
    const supplied = Object.freeze([
      entry('event-first', 'human', 'comment'),
      entry('event-middle', 'agent', 'task:status_changed'),
      entry('event-last', 'human', 'comment'),
    ]) as unknown as ActivityEntry[];
    const originalIds = supplied.map((item) => item.id);
    ready(taskA, 1, supplied, 27);
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    installClipboard(clipboardWrite);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    const storageWriteSpy = vi.spyOn(Storage.prototype, 'setItem');

    render(<AuditLog taskId={taskA} />);

    expect(visibleIds()).toEqual(originalIds);
    expect(orderButton()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Reverses only matching activity already loaded on this page.'))
      .toBeInTheDocument();
    expect(screen.getByText('Showing 3 of 3 loaded activity entries on this page.')).toBeInTheDocument();
    expect(screen.getByText('Showing 1–20 of 27')).toBeInTheDocument();

    fireEvent.click(orderButton());

    expect(visibleIds()).toEqual([...originalIds].reverse());
    expect(orderButton()).toHaveAttribute('aria-pressed', 'true');
    expect(supplied.map((item) => item.id)).toEqual(originalIds);
    expect(activityState.queryKeys).toEqual([`${taskA}:1`]);
    expect(activityState.refetch).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(pushStateSpy).not.toHaveBeenCalled();
    expect(storageWriteSpy).not.toHaveBeenCalled();
    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  it('filters in server order first, then reverses the matching loaded rows', () => {
    ready(taskA, 1, [
      entry('event-human-comment', 'human', 'comment'),
      entry('event-agent-status-a', 'agent', 'task:status_changed'),
      entry('event-human-status', 'human', 'task:status_changed'),
      entry('event-agent-comment', 'agent', 'comment'),
      entry('event-agent-status-b', 'agent', 'task:status_changed'),
    ]);
    render(<AuditLog taskId={taskA} />);

    fireEvent.click(orderButton());
    expect(visibleIds()).toEqual([
      'event-agent-status-b',
      'event-agent-comment',
      'event-human-status',
      'event-agent-status-a',
      'event-human-comment',
    ]);

    fireEvent.change(screen.getByRole('combobox', { name: 'Activity filter' }), {
      target: { value: 'status_changes' },
    });
    expect(visibleIds()).toEqual([
      'event-agent-status-b',
      'event-human-status',
      'event-agent-status-a',
    ]);

    fireEvent.change(screen.getByRole('combobox', { name: 'Actor filter' }), {
      target: { value: 'agents' },
    });
    expect(visibleIds()).toEqual(['event-agent-status-b', 'event-agent-status-a']);
    expect(orderButton()).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps the reverse preference through empty recovery and filter reset without changing page or time', () => {
    ready(taskA, 1, [entry('event-page-one', 'human', 'comment')], 43, 20);
    ready(taskA, 2, [
      entry('event-page-two-human', 'human', 'task:status_changed'),
      entry('event-page-two-agent', 'agent', 'comment'),
      entry('event-page-two-last', 'human', 'comment'),
    ], 43, 20);
    const view = render(<AuditLog taskId={taskA} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next activity page' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show exact UTC timestamps' }));
    fireEvent.click(orderButton());

    fireEvent.change(screen.getByRole('combobox', { name: 'Activity filter' }), {
      target: { value: 'status_changes' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Actor filter' }), {
      target: { value: 'agents' },
    });
    expect(screen.getByText('No matching activity on this page.')).toBeInTheDocument();
    expect(orderButton()).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Reset activity filters' }));

    expect(visibleIds()).toEqual([
      'event-page-two-last',
      'event-page-two-agent',
      'event-page-two-human',
    ]);
    expect(orderButton()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('combobox', { name: 'Activity filter' })).toHaveValue('all');
    expect(screen.getByRole('combobox', { name: 'Actor filter' })).toHaveValue('all');
    expect(screen.getByRole('checkbox', { name: 'Show exact UTC timestamps' })).toBeChecked();
    expect(screen.getAllByText(createdAt)).toHaveLength(3);
    expect(screen.getByText('Showing 3 of 3 loaded activity entries on this page.')).toBeInTheDocument();
    expect(screen.getByText('Showing 21–40 of 43')).toBeInTheDocument();
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
    expect(activityState.queryKeys).toEqual([`${taskA}:1`, `${taskA}:2`]);
    view.unmount();
  });

  it('retains reversal on same-task refresh and resets it across A-to-B-to-A', () => {
    ready(taskA, 1, [entry('event-a-before', 'human', 'comment')]);
    ready(taskB, 1, [
      entry('event-b-first', 'human', 'comment', taskB),
      entry('event-b-last', 'agent', 'comment', taskB),
    ]);
    const view = render(<AuditLog taskId={taskA} />);
    fireEvent.click(orderButton());

    ready(taskA, 1, [
      entry('event-a-new-first', 'human', 'comment'),
      entry('event-a-new-last', 'agent', 'comment'),
    ]);
    view.rerender(<AuditLog taskId={taskA} />);
    expect(orderButton()).toHaveAttribute('aria-pressed', 'true');
    expect(visibleIds()).toEqual(['event-a-new-last', 'event-a-new-first']);

    view.rerender(<AuditLog taskId={taskB} />);
    expect(orderButton()).toHaveAttribute('aria-pressed', 'false');
    expect(visibleIds()).toEqual(['event-b-first', 'event-b-last']);

    view.rerender(<AuditLog taskId={taskA} />);
    expect(orderButton()).toHaveAttribute('aria-pressed', 'false');
    expect(visibleIds()).toEqual(['event-a-new-first', 'event-a-new-last']);
  });

  it('keeps the task preference through loading, retry, error and same-task recovery', () => {
    activityState.results.set(`${taskA}:1`, {
      data: undefined,
      isLoading: true,
      isError: false,
      isFetching: false,
    });
    const loading = render(<AuditLog taskId={taskA} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reverse loaded activity order' })).not.toBeInTheDocument();
    loading.unmount();

    ready(taskA, 1, [entry('event-before-error', 'human', 'comment')]);
    activityState.refetch = vi.fn().mockResolvedValue(undefined);
    const view = render(<AuditLog taskId={taskA} />);
    fireEvent.click(orderButton());
    activityState.results.set(`${taskA}:1`, {
      data: undefined,
      isLoading: false,
      isError: true,
      isFetching: false,
    });
    view.rerender(<AuditLog taskId={taskA} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Activity is unavailable. Try again later.');
    expect(screen.getByRole('button', { name: 'Retry activity' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Reverse loaded activity order' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry activity' }));
    expect(activityState.refetch).toHaveBeenCalledExactlyOnceWith();

    ready(taskA, 1, [
      entry('event-after-retry-first', 'human', 'comment'),
      entry('event-after-retry-last', 'agent', 'comment'),
    ]);
    view.rerender(<AuditLog taskId={taskA} />);
    expect(orderButton()).toHaveAttribute('aria-pressed', 'true');
    expect(visibleIds()).toEqual(['event-after-retry-last', 'event-after-retry-first']);
  });

  it.each([
    ['success', 'resolve'],
    ['rejection', 'reject'],
  ] as const)(
    'does not show a visible-ID copy %s after reversal and an ABA return to the same order',
    async (_outcome, settlement) => {
      ready(taskA, 1, [
        entry('event-first', 'human', 'comment'),
        entry('event-last', 'agent', 'comment'),
      ]);
      const pending = deferredClipboard();
      const clipboardWrite = vi.fn(() => pending.promise);
      installClipboard(clipboardWrite);
      render(<AuditLog taskId={taskA} />);

      fireEvent.click(screen.getByRole('button', { name: 'Copy visible activity event IDs (2)' }));
      expect(clipboardWrite).toHaveBeenCalledExactlyOnceWith('event-first\nevent-last');
      fireEvent.click(orderButton());
      expect(visibleIds()).toEqual(['event-last', 'event-first']);
      fireEvent.click(orderButton());
      expect(visibleIds()).toEqual(['event-first', 'event-last']);

      await act(async () => {
        if (settlement === 'resolve') pending.resolve();
        else pending.reject(new Error('private clipboard detail'));
      });

      expect(screen.queryByText('Activity event IDs copied.')).not.toBeInTheDocument();
      expect(screen.queryByText('Could not copy activity event IDs. Try copying them manually.'))
        .not.toBeInTheDocument();
      expect(screen.queryByText('private clipboard detail')).not.toBeInTheDocument();
    },
  );

  it('copies visible IDs exactly in the current rendered order', async () => {
    ready(taskA, 1, [
      entry('event-first', 'human', 'comment'),
      entry('event-middle', 'agent', 'comment'),
      entry('event-last', 'human', 'comment'),
    ]);
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    installClipboard(clipboardWrite);
    render(<AuditLog taskId={taskA} />);
    fireEvent.click(orderButton());
    fireEvent.click(screen.getByRole('button', { name: 'Copy visible activity event IDs (3)' }));

    expect(clipboardWrite).toHaveBeenCalledExactlyOnceWith('event-last\nevent-middle\nevent-first');
    expect(await screen.findByText('Activity event IDs copied.')).toBeInTheDocument();
  });

  it.each([
    ['success', 'resolve'],
    ['rejection', 'reject'],
  ] as const)(
    'does not show a per-row actor copy %s after reversal and an ABA return',
    async (_outcome, settlement) => {
      ready(taskA, 1, [entry('event-first', 'human', 'comment'), entry('event-last', 'agent', 'comment')]);
      const pending = deferredClipboard();
      installClipboard(vi.fn(() => pending.promise));
      render(<AuditLog taskId={taskA} />);
      const firstRow = screen.getAllByRole('listitem')[0];
      fireEvent.click(within(firstRow).getByRole('button', {
        name: 'Copy recorded actor ID',
      }));

      fireEvent.click(orderButton());
      fireEvent.click(orderButton());
      await act(async () => {
        if (settlement === 'resolve') pending.resolve();
        else pending.reject(new Error('private clipboard detail'));
      });

      expect(screen.queryByText('Actor ID copied.')).not.toBeInTheDocument();
      expect(screen.queryByText('Could not copy actor ID. Try copying it manually.')).not.toBeInTheDocument();
      expect(screen.queryByText('private clipboard detail')).not.toBeInTheDocument();
    },
  );

  it('keeps the existing loading, error and out-of-range recovery paths', () => {
    activityState.results.set(`${taskA}:1`, {
      data: undefined,
      isLoading: true,
      isError: false,
      isFetching: false,
    });
    const loading = render(<AuditLog taskId={taskA} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reverse loaded activity order' })).not.toBeInTheDocument();
    loading.unmount();

    activityState.results.set(`${taskA}:1`, {
      data: undefined,
      isLoading: false,
      isError: true,
      isFetching: false,
    });
    const failed = render(<AuditLog taskId={taskA} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Activity is unavailable. Try again later.');
    expect(screen.getByRole('button', { name: 'Retry activity' })).toBeEnabled();
    failed.unmount();

    ready(taskA, 1, [entry('event-page-one', 'human', 'comment')], 21, 20);
    ready(taskA, 2, [], 20, 20);
    const outOfRange = render(<AuditLog taskId={taskA} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next activity page' }));
    expect(screen.getByText('event-page-one')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    expect(orderButton()).toHaveAttribute('aria-pressed', 'false');
    outOfRange.unmount();
  });

  it('does not surface stale task rows or a mismatched response page when reversed', () => {
    ready(taskA, 1, [
      entry('event-current-page', 'human', 'comment', taskA),
      entry('event-stale-task', 'agent', 'comment', taskB),
    ], 2, 1);
    const view = render(<AuditLog taskId={taskA} />);
    fireEvent.click(orderButton());
    expect(visibleIds()).toEqual(['event-current-page']);

    activityState.results.set(`${taskA}:1`, {
      data: {
        data: [entry('event-wrong-page', 'human', 'comment', taskA)],
        total: 2,
        page: 2,
        limit: 1,
      },
      isLoading: false,
      isError: false,
      isFetching: false,
    });
    view.rerender(<AuditLog taskId={taskA} />);
    expect(screen.queryByText('event-wrong-page')).not.toBeInTheDocument();
    expect(screen.queryByText('event-stale-task')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reverse loaded activity order' })).not.toBeInTheDocument();
    view.unmount();
  });
});
