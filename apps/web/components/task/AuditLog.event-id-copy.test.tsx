import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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

interface ActivityResult {
  data: ActivityEntry[];
  total: number;
  page: number;
  limit: number;
}

interface ActivityState {
  data: ActivityResult;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
}

const activityState = vi.hoisted(() => ({
  results: new Map<string, ActivityState>(),
  requestedKeys: [] as string[],
  refetch: vi.fn(),
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

const taskA = '11111111-1111-4111-8111-111111111111';
const taskB = '22222222-2222-4222-8222-222222222222';
const eventId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const nextEventId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actorId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const createdAt = '2026-10-24T00:00:00.000Z';
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function entry(
  id: string,
  taskId = taskA,
  actorType: ActivityEntry['actorType'] = 'human',
): ActivityEntry {
  return {
    id,
    taskId,
    actorId,
    actorName: `Actor for ${id}`,
    actorType,
    action: 'task:updated',
    payload: null,
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

function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

function rowForEvent(id: string): HTMLElement {
  const eventName = `Actor for ${id}`;
  const row = screen.getByText(eventName).closest('li');
  if (!row) throw new Error(`Missing row for ${id}`);
  return row;
}

beforeEach(() => {
  activityState.results.clear();
  activityState.requestedKeys = [];
  activityState.refetch = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

describe('AuditLog activity event ID copy', () => {
  it('copies only the explicit row event ID and keeps actor-ID copy independent', async () => {
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    ready(taskA, 1, [entry(eventId)]);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    render(<AuditLog taskId={taskA} />);
    const row = rowForEvent(eventId);
    const copyEventButton = within(row).getByRole('button', { name: 'Copy activity event ID' });
    const copyActorButton = within(row).getByRole('button', { name: 'Copy recorded actor ID' });

    expect(writeText).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fireEvent.click(copyEventButton);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(eventId);
    expect(writeText).not.toHaveBeenCalledWith(actorId);
    expect(await within(row).findByText('Activity event ID copied.')).toBeInTheDocument();

    fireEvent.click(copyActorButton);
    expect(writeText).toHaveBeenNthCalledWith(2, actorId);
    expect(await within(row).findByText('Actor ID copied.')).toBeInTheDocument();
    expect(activityState.refetch).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps feedback on the copied row and blocks reentry until the clipboard settles', async () => {
    let resolveClipboard!: () => void;
    const writeText = installClipboard(vi.fn(() => new Promise<void>((resolve) => {
      resolveClipboard = resolve;
    })));
    const secondEventId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    ready(taskA, 1, [entry(eventId), entry(secondEventId)]);

    render(<AuditLog taskId={taskA} />);
    const firstRow = rowForEvent(eventId);
    const secondRow = rowForEvent(secondEventId);
    const firstButton = within(firstRow).getByRole('button', { name: 'Copy activity event ID' });

    fireEvent.click(firstButton);
    expect(firstButton).toBeDisabled();
    fireEvent.click(firstButton);
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(eventId);
    expect(within(firstRow).queryByText('Activity event ID copied.')).not.toBeInTheDocument();
    expect(within(secondRow).queryByText('Activity event ID copied.')).not.toBeInTheDocument();

    await act(async () => resolveClipboard());
    expect(await within(firstRow).findByText('Activity event ID copied.')).toBeInTheDocument();
    expect(within(secondRow).queryByText('Activity event ID copied.')).not.toBeInTheDocument();
  });

  it('shows a generic rejection alert and allows a later successful retry', async () => {
    const writeText = installClipboard(vi.fn()
      .mockRejectedValueOnce(new Error(`private ${eventId}`))
      .mockResolvedValueOnce(undefined));
    ready(taskA, 1, [entry(eventId)]);

    render(<AuditLog taskId={taskA} />);
    const row = rowForEvent(eventId);
    const button = within(row).getByRole('button', { name: 'Copy activity event ID' });
    fireEvent.click(button);

    const alert = await within(row).findByRole('alert');
    expect(alert).toHaveTextContent('Could not copy activity event ID. Try again or copy it manually.');
    expect(alert).not.toHaveTextContent(eventId);
    expect(alert).not.toHaveTextContent('private');

    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenNthCalledWith(2, eventId);
    expect(await within(row).findByText('Activity event ID copied.')).toBeInTheDocument();
  });

  it('reports an unavailable clipboard without throwing and recovers when it becomes available', async () => {
    ready(taskA, 1, [entry(eventId)]);
    render(<AuditLog taskId={taskA} />);
    const row = rowForEvent(eventId);
    const button = within(row).getByRole('button', { name: 'Copy activity event ID' });

    Reflect.deleteProperty(navigator, 'clipboard');
    fireEvent.click(button);
    expect(await within(row).findByRole('alert')).toHaveTextContent(
      'Could not copy activity event ID. Try again or copy it manually.',
    );

    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledWith(eventId);
    expect(await within(row).findByText('Activity event ID copied.')).toBeInTheDocument();
  });

  it.each(['task', 'page', 'filter', 'event ID'] as const)(
    'does not show an old success after the %s identity changes',
    async (identityChange) => {
      let resolveClipboard!: () => void;
      installClipboard(vi.fn(() => new Promise<void>((resolve) => {
        resolveClipboard = resolve;
      })));
      ready(taskA, 1, [entry(eventId, taskA, 'human')], 2, 1);
      ready(taskA, 2, [entry(nextEventId, taskA, 'human')], 2, 1);
      ready(taskB, 1, [entry(nextEventId, taskB, 'human')]);
      const view = render(<AuditLog taskId={taskA} />);

      fireEvent.click(within(rowForEvent(eventId)).getByRole('button', {
        name: 'Copy activity event ID',
      }));

      if (identityChange === 'task') {
        view.rerender(<AuditLog taskId={taskB} />);
        view.rerender(<AuditLog taskId={taskA} />);
      } else if (identityChange === 'page') {
        fireEvent.click(screen.getByRole('button', { name: 'Next activity page' }));
        fireEvent.click(screen.getByRole('button', { name: 'Previous activity page' }));
      } else if (identityChange === 'filter') {
        fireEvent.change(screen.getByRole('combobox', { name: 'Actor filter' }), {
          target: { value: 'agents' },
        });
        fireEvent.change(screen.getByRole('combobox', { name: 'Actor filter' }), {
          target: { value: 'all' },
        });
      } else {
        ready(taskA, 1, [entry(nextEventId, taskA, 'human')], 2, 1);
        view.rerender(<AuditLog taskId={taskA} />);
      }

      await act(async () => resolveClipboard());
      expect(screen.queryByText('Activity event ID copied.')).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    },
  );

  it('suppresses a failed clipboard result after task A-B-A returns to the same event', async () => {
    let rejectClipboard!: (reason?: unknown) => void;
    installClipboard(vi.fn(() => new Promise<void>((_resolve, reject) => {
      rejectClipboard = reject;
    })));
    ready(taskA, 1, [entry(eventId)]);
    ready(taskB, 1, [entry(nextEventId, taskB)]);
    const view = render(<AuditLog taskId={taskA} />);

    fireEvent.click(within(rowForEvent(eventId)).getByRole('button', {
      name: 'Copy activity event ID',
    }));
    view.rerender(<AuditLog taskId={taskB} />);
    view.rerender(<AuditLog taskId={taskA} />);

    await act(async () => rejectClipboard(new Error('stale failure')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Activity event ID copied.')).not.toBeInTheDocument();
  });
});
