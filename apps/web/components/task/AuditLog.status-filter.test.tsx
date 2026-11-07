import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AuditLog } from './AuditLog';

interface ActivityFixture {
  id: string;
  taskId: string;
  actorId: string;
  actorName: string;
  actorType: 'human';
  action: string;
  payload: unknown;
  createdAt: string;
}

interface ActivityResult {
  data: ActivityFixture[];
  total: number;
  page: number;
  limit: number;
}

interface ActivityState {
  data: ActivityResult | undefined;
  isLoading: boolean;
  isError: boolean;
}

const state = vi.hoisted(() => ({
  results: new Map<string, ActivityState>(),
  requestedKeys: [] as string[],
  refetch: vi.fn(),
}));

vi.mock('@/lib/api/tasks', () => ({
  useActivity: (taskId: string, page = 1) => {
    const key = `${taskId}:${page}`;
    if (state.requestedKeys.at(-1) !== key) state.requestedKeys.push(key);
    return {
      ...(state.results.get(key) ?? {
        data: undefined,
        isLoading: false,
        isError: false,
      }),
      refetch: state.refetch,
    };
  },
}));

const taskA = '11111111-1111-4111-8111-111111111111';
const taskB = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
const createdAt = '2026-10-24T00:00:00.000Z';

function entry(
  id: string,
  taskId: string,
  action: string,
  payload: unknown = null,
): ActivityFixture {
  return {
    id,
    taskId,
    actorId,
    actorName: id,
    actorType: 'human',
    action,
    payload,
    createdAt,
  };
}

function ready(
  taskId: string,
  page: number,
  entries: ActivityFixture[],
  total: number,
  limit = 20,
) {
  state.results.set(`${taskId}:${page}`, {
    data: { data: entries, total, page, limit },
    isLoading: false,
    isError: false,
  });
}

function visibleEntryNames(): string[] {
  return screen.getAllByRole('listitem').map((item) => item.textContent ?? '');
}

beforeEach(() => {
  state.results.clear();
  state.requestedKeys = [];
  state.refetch = vi.fn();
});

afterEach(() => cleanup());

describe('AuditLog activity filter', () => {
  it('defaults to all activity, filters the exact action, restores order, and keeps the same query', () => {
    ready(taskA, 1, [
      entry('comment-first', taskA, 'comment'),
      entry('status-entry', taskA, 'task:status_changed', { from: 'todo', to: 'done' }),
      entry('status-like-action', taskA, 'task:status_changed_extra', { from: 'todo', to: 'done' }),
      entry('update-last', taskA, 'task:updated'),
    ], 32);

    render(<AuditLog taskId={taskA} />);

    const filter = screen.getByRole('combobox', { name: 'Activity filter' });
    expect(filter).toHaveValue('all');
    expect(screen.getByText('Showing 1–20 of 32')).toBeInTheDocument();
    expect(visibleEntryNames()).toHaveLength(4);
    expect(visibleEntryNames()[0]).toContain('comment-first');
    expect(visibleEntryNames()[1]).toContain('status-entry');
    expect(visibleEntryNames()[2]).toContain('status-like-action');
    expect(visibleEntryNames()[3]).toContain('update-last');
    expect(state.requestedKeys).toEqual([`${taskA}:1`]);

    fireEvent.change(filter, { target: { value: 'status_changes' } });

    expect(filter).toHaveValue('status_changes');
    expect(visibleEntryNames()).toHaveLength(1);
    expect(visibleEntryNames()[0]).toContain('status-entry');
    expect(screen.getByText('To Do → Done')).toBeInTheDocument();
    expect(screen.queryByText('comment-first')).not.toBeInTheDocument();
    expect(screen.queryByText('status-like-action')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 1–20 of 32')).toBeInTheDocument();
    expect(state.requestedKeys).toEqual([`${taskA}:1`]);
    expect(state.refetch).not.toHaveBeenCalled();

    fireEvent.change(filter, { target: { value: 'all' } });

    expect(visibleEntryNames()).toHaveLength(4);
    expect(visibleEntryNames()[0]).toContain('comment-first');
    expect(visibleEntryNames()[1]).toContain('status-entry');
    expect(visibleEntryNames()[2]).toContain('status-like-action');
    expect(visibleEntryNames()[3]).toContain('update-last');
    expect(state.requestedKeys).toEqual([`${taskA}:1`]);
    expect(state.refetch).not.toHaveBeenCalled();
  });

  it('explains an empty filtered page locally without relabelling the server total', () => {
    ready(taskA, 1, [entry('comment-only', taskA, 'comment')], 20);

    render(<AuditLog taskId={taskA} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Activity filter' }), {
      target: { value: 'status_changes' },
    });

    expect(screen.getByText('No status changes on this page.')).toBeInTheDocument();
    expect(screen.queryByText('No activity on this page.')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 1–20 of 20')).toBeInTheDocument();
    expect(state.requestedKeys).toEqual([`${taskA}:1`]);
  });

  it('preserves status-only mode when moving between current pages', () => {
    ready(taskA, 1, [
      entry('page-one-status', taskA, 'task:status_changed', { from: 'todo', to: 'in_progress' }),
    ], 21);
    ready(taskA, 2, [entry('page-two-comment', taskA, 'comment')], 21);

    render(<AuditLog taskId={taskA} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Activity filter' }), {
      target: { value: 'status_changes' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next activity page' }));

    expect(screen.getByRole('combobox', { name: 'Activity filter' })).toHaveValue('status_changes');
    expect(screen.getByText('No status changes on this page.')).toBeInTheDocument();
    expect(screen.getByText('Showing 21–21 of 21')).toBeInTheDocument();
    expect(screen.queryByText('page-one-status')).not.toBeInTheDocument();
    expect(screen.queryByText('page-two-comment')).not.toBeInTheDocument();
    expect(state.requestedKeys).toEqual([`${taskA}:1`, `${taskA}:2`]);
  });

  it('resets to all activity on task change and never shows the prior task page', () => {
    ready(taskA, 1, [entry('task-a-status-one', taskA, 'task:status_changed')], 21);
    ready(taskA, 2, [entry('task-a-status-two', taskA, 'task:status_changed')], 21);
    ready(taskB, 1, [entry('task-b-comment', taskB, 'comment')], 1);

    const view = render(<AuditLog taskId={taskA} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Activity filter' }), {
      target: { value: 'status_changes' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next activity page' }));
    expect(screen.getByText('task-a-status-two')).toBeInTheDocument();

    view.rerender(<AuditLog taskId={taskB} />);

    expect(state.requestedKeys).toEqual([`${taskA}:1`, `${taskA}:2`, `${taskB}:1`]);
    expect(screen.getByRole('combobox', { name: 'Activity filter' })).toHaveValue('all');
    expect(screen.getByText('task-b-comment')).toBeInTheDocument();
    expect(screen.getByText('Showing 1–1 of 1')).toBeInTheDocument();
    expect(screen.queryByText('task-a-status-one')).not.toBeInTheDocument();
    expect(screen.queryByText('task-a-status-two')).not.toBeInTheDocument();
  });
});
