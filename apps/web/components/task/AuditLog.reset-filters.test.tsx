import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

function ready(taskId: string, page: number, entries: ActivityEntry[], total = entries.length, limit = 20) {
  activityState.results.set(`${taskId}:${page}`, {
    data: { data: entries, total, page, limit },
    isLoading: false,
    isError: false,
    isFetching: false,
  });
}

function visibleEntryNames(): string[] {
  return screen.getAllByRole('listitem').map((item) => item.textContent ?? '');
}

function resetButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Reset activity filters' });
}

function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
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

describe('AuditLog reset activity filters', () => {
  it('starts disabled and atomically restores each independently selected filter', () => {
    ready(taskA, 1, [
      entry('human-comment', 'human', 'comment'),
      entry('human-status', 'human', 'task:status_changed'),
      entry('agent-status', 'agent', 'task:status_changed'),
    ], 27);
    const view = render(<AuditLog taskId={taskA} />);

    expect(resetButton()).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Activity filter' }), {
      target: { value: 'status_changes' },
    });
    expect(resetButton()).toBeEnabled();
    expect(visibleEntryNames()).toHaveLength(2);
    fireEvent.click(resetButton());
    expect(screen.getByRole('combobox', { name: 'Activity filter' })).toHaveValue('all');
    expect(screen.getByRole('combobox', { name: 'Actor filter' })).toHaveValue('all');
    expect(visibleEntryNames()).toHaveLength(3);
    expect(resetButton()).toBeDisabled();

    fireEvent.change(screen.getByRole('combobox', { name: 'Actor filter' }), {
      target: { value: 'agents' },
    });
    expect(resetButton()).toBeEnabled();
    expect(visibleEntryNames()).toHaveLength(1);
    expect(visibleEntryNames()[0]).toContain('agent-status');
    fireEvent.click(resetButton());
    expect(screen.getByRole('combobox', { name: 'Activity filter' })).toHaveValue('all');
    expect(screen.getByRole('combobox', { name: 'Actor filter' })).toHaveValue('all');
    expect(visibleEntryNames()).toHaveLength(3);
    expect(screen.getByText('Showing 1–20 of 27')).toBeInTheDocument();
    expect(activityState.queryKeys).toEqual([`${taskA}:1`]);
    view.unmount();
  });

  it('restores an empty combined-filter view on the same loaded page without extra effects', () => {
    const entries = [
      entry('old-task-status', 'human', 'task:status_changed', taskB),
      entry('page-two-comment', 'human', 'comment'),
      entry('page-two-human-status', 'human', 'task:status_changed'),
      entry('page-two-agent-comment', 'agent', 'comment'),
      entry('page-two-last-status', 'human', 'task:status_changed'),
    ];
    ready(taskA, 1, [entry('page-one', 'human', 'comment')], 43, 20);
    ready(taskA, 2, entries, 43, 20);
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    installClipboard(clipboardWrite);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const pushStateSpy = vi.spyOn(window.history, 'pushState');
    const storageWriteSpy = vi.spyOn(Storage.prototype, 'setItem');

    render(<AuditLog taskId={taskA} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next activity page' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show exact UTC timestamps' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Activity filter' }), {
      target: { value: 'status_changes' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Actor filter' }), {
      target: { value: 'agents' },
    });

    expect(screen.getByText('No matching activity on this page.')).toBeInTheDocument();
    expect(resetButton()).toBeEnabled();
    const requestedPagesBeforeReset = [...activityState.queryKeys];
    fireEvent.click(resetButton());

    expect(visibleEntryNames()).toEqual([
      expect.stringContaining('page-two-comment'),
      expect.stringContaining('page-two-human-status'),
      expect.stringContaining('page-two-agent-comment'),
      expect.stringContaining('page-two-last-status'),
    ]);
    expect(screen.queryByText('old-task-status')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 4 of 4 loaded activity entries on this page.')).toBeInTheDocument();
    expect(screen.getByText('Showing 21–40 of 43')).toBeInTheDocument();
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Show exact UTC timestamps' })).toBeChecked();
    expect(screen.getAllByText(createdAt)).toHaveLength(4);
    expect(activityState.queryKeys).toEqual(requestedPagesBeforeReset);
    expect(activityState.refetch).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(pushStateSpy).not.toHaveBeenCalled();
    expect(storageWriteSpy).not.toHaveBeenCalled();
    expect(clipboardWrite).not.toHaveBeenCalled();
  });

  it.each([
    ['success', 'resolve'],
    ['rejection', 'reject'],
  ] as const)(
    'does not show a pre-reset clipboard %s after reset and an ABA return to the same filtered view',
    async (_outcome, settlement) => {
      let resolveClipboard!: () => void;
      let rejectClipboard!: (reason?: unknown) => void;
      const clipboardWrite = vi.fn(() => new Promise<void>((resolve, reject) => {
        resolveClipboard = resolve;
        rejectClipboard = reject;
      }));
      installClipboard(clipboardWrite);
      ready(taskA, 1, [
        entry('human-status', 'human', 'task:status_changed'),
        entry('agent-comment', 'agent', 'comment'),
      ]);

      render(<AuditLog taskId={taskA} />);
      fireEvent.change(screen.getByRole('combobox', { name: 'Activity filter' }), {
        target: { value: 'status_changes' },
      });
      fireEvent.change(screen.getByRole('combobox', { name: 'Actor filter' }), {
        target: { value: 'humans' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Copy visible activity event IDs (1)' }));
      expect(clipboardWrite).toHaveBeenCalledExactlyOnceWith('human-status');

      fireEvent.click(resetButton());
      expect(visibleEntryNames()).toHaveLength(2);
      expect(screen.queryByText('Activity event IDs copied.')).not.toBeInTheDocument();
      expect(screen.queryByText('Could not copy activity event IDs. Try copying them manually.'))
        .not.toBeInTheDocument();
      fireEvent.change(screen.getByRole('combobox', { name: 'Activity filter' }), {
        target: { value: 'status_changes' },
      });
      fireEvent.change(screen.getByRole('combobox', { name: 'Actor filter' }), {
        target: { value: 'humans' },
      });
      expect(visibleEntryNames()).toHaveLength(1);

      await act(async () => {
        if (settlement === 'resolve') resolveClipboard();
        else rejectClipboard(new Error('private clipboard detail'));
      });

      expect(screen.queryByText('Activity event IDs copied.')).not.toBeInTheDocument();
      expect(screen.queryByText('Could not copy activity event IDs. Try copying them manually.'))
        .not.toBeInTheDocument();
      expect(screen.queryByText('private clipboard detail')).not.toBeInTheDocument();
    },
  );

  it('copies the current all-filter view IDs in rendered order after a reset', async () => {
    const clipboardWrite = vi.fn().mockResolvedValue(undefined);
    installClipboard(clipboardWrite);
    ready(taskA, 1, [
      entry('first-human-status', 'human', 'task:status_changed'),
      entry('middle-agent-comment', 'agent', 'comment'),
      entry('last-human-comment', 'human', 'comment'),
    ]);
    render(<AuditLog taskId={taskA} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Activity filter' }), {
      target: { value: 'status_changes' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Actor filter' }), {
      target: { value: 'humans' },
    });
    fireEvent.click(resetButton());
    fireEvent.click(screen.getByRole('button', { name: 'Copy visible activity event IDs (3)' }));

    expect(clipboardWrite).toHaveBeenCalledExactlyOnceWith(
      'first-human-status\nmiddle-agent-comment\nlast-human-comment',
    );
    expect(await screen.findByText('Activity event IDs copied.')).toBeInTheDocument();
  });

  it('keeps same-task filters on refresh and resets filters and exact-time preference on task change', () => {
    ready(taskA, 1, [entry('agent-before-refresh', 'agent', 'comment')], 1);
    ready(taskB, 1, [
      entry('human-new-task', 'human', 'comment', taskB),
      entry('agent-new-task', 'agent', 'comment', taskB),
    ], 2);
    const view = render(<AuditLog taskId={taskA} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Activity filter' }), {
      target: { value: 'status_changes' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Actor filter' }), {
      target: { value: 'agents' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show exact UTC timestamps' }));

    ready(taskA, 1, [
      entry('human-after-refresh', 'human', 'comment'),
      entry('agent-after-refresh', 'agent', 'task:status_changed'),
    ], 2);
    view.rerender(<AuditLog taskId={taskA} />);
    expect(screen.getByRole('combobox', { name: 'Activity filter' })).toHaveValue('status_changes');
    expect(screen.getByRole('combobox', { name: 'Actor filter' })).toHaveValue('agents');
    expect(screen.getByRole('checkbox', { name: 'Show exact UTC timestamps' })).toBeChecked();
    expect(visibleEntryNames()).toHaveLength(1);
    expect(visibleEntryNames()[0]).toContain('agent-after-refresh');

    view.rerender(<AuditLog taskId={taskB} />);
    expect(screen.getByRole('combobox', { name: 'Activity filter' })).toHaveValue('all');
    expect(screen.getByRole('combobox', { name: 'Actor filter' })).toHaveValue('all');
    expect(screen.getByRole('checkbox', { name: 'Show exact UTC timestamps' })).not.toBeChecked();
    expect(visibleEntryNames()).toHaveLength(2);
    expect(visibleEntryNames()[0]).toContain('human-new-task');
    expect(visibleEntryNames()[1]).toContain('agent-new-task');
  });

  it('keeps loading, error, true-empty, and out-of-range transitions on their existing paths', () => {
    activityState.results.set(`${taskA}:1`, {
      data: undefined,
      isLoading: true,
      isError: false,
      isFetching: false,
    });
    const loading = render(<AuditLog taskId={taskA} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset activity filters' })).not.toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: 'Reset activity filters' })).not.toBeInTheDocument();
    failed.unmount();

    ready(taskA, 1, [], 0, 20);
    render(<AuditLog taskId={taskA} />);
    expect(screen.getByText('No activity on this page.')).toBeInTheDocument();
    expect(resetButton()).toBeDisabled();
    cleanup();

    ready(taskA, 1, [entry('first-page', 'human', 'comment')], 21, 20);
    ready(taskA, 2, [], 20, 20);
    render(<AuditLog taskId={taskA} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next activity page' }));
    expect(screen.getByText('first-page')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    expect(resetButton()).toBeDisabled();
  });

  it('never shows another task or a mismatched response page after a local reset', () => {
    ready(taskA, 1, [
      entry('current-task', 'human', 'task:status_changed'),
      entry('stale-task', 'human', 'task:status_changed', taskB),
    ], 2, 1);
    ready(taskA, 2, [entry('page-two-current', 'human', 'comment')], 2, 1);
    const view = render(<AuditLog taskId={taskA} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next activity page' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Actor filter' }), {
      target: { value: 'agents' },
    });
    expect(screen.getByText('No matching activity on this page.')).toBeInTheDocument();
    fireEvent.click(resetButton());
    expect(visibleEntryNames()).toEqual([expect.stringContaining('page-two-current')]);
    expect(screen.queryByText('stale-task')).not.toBeInTheDocument();
    view.unmount();

    activityState.results.set(`${taskA}:2`, {
      data: { data: [entry('wrong-page', 'human', 'comment')], total: 2, page: 1, limit: 1 },
      isLoading: false,
      isError: false,
      isFetching: false,
    });
    const mismatchedView = render(<AuditLog taskId={taskA} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next activity page' }));
    expect(screen.queryByText('wrong-page')).not.toBeInTheDocument();
    mismatchedView.unmount();
  });
});
