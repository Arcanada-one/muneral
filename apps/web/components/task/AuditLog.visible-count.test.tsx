import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AuditLog } from './AuditLog';

interface ActivityFixture {
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
  data: ActivityFixture[];
  total: number;
  page?: number;
  limit: number;
}

interface ActivityState {
  data: ActivityResult | undefined;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
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
        isFetching: false,
      }),
      refetch: state.refetch,
    };
  },
}));

const taskA = '11111111-1111-4111-8111-111111111111';
const taskB = '22222222-2222-4222-8222-222222222222';
const createdAt = '2026-10-24T00:00:00.000Z';

function entry(
  id: string,
  taskId: string,
  actorType: string,
  action: string,
): ActivityFixture {
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
  entries: ActivityFixture[],
  total: number,
  limit = 20,
) {
  state.results.set(`${taskId}:${page}`, {
    data: { data: entries, total, page, limit },
    isLoading: false,
    isError: false,
    isFetching: false,
  });
}

function visibleCount(): HTMLElement | null {
  return screen.queryByRole('status');
}

beforeEach(() => {
  state.results.clear();
  state.requestedKeys = [];
  state.refetch = vi.fn();
});

afterEach(() => cleanup());

describe('AuditLog visible activity count', () => {
  it('counts the current page before the intersecting filters and preserves the server range', () => {
    ready(taskA, 1, [
      entry('status-service-one', taskA, 'service', 'task:status_changed'),
      entry('status-service-two', taskA, 'service', 'task:status_changed'),
      entry('comment-human', taskA, 'human', 'comment'),
      entry('comment-agent', taskA, 'agent', 'comment'),
      entry('foreign-status', taskB, 'human', 'task:status_changed'),
    ], 47, 12);

    render(<AuditLog taskId={taskA} />);

    expect(visibleCount()).toHaveTextContent(
      'Showing 4 of 4 loaded activity entries on this page.',
    );
    expect(screen.getByText('Showing 1–12 of 47')).toBeInTheDocument();
    expect(screen.getByText('comment-human')).toBeInTheDocument();
    expect(screen.getByText('comment-agent')).toBeInTheDocument();
    expect(screen.queryByText('foreign-status')).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Activity filter' }), {
      target: { value: 'status_changes' },
    });
    expect(visibleCount()).toHaveTextContent(
      'Showing 2 of 4 loaded activity entries on this page.',
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Actor filter' }), {
      target: { value: 'humans' },
    });
    expect(visibleCount()).toHaveTextContent(
      'Showing 0 of 4 loaded activity entries on this page.',
    );
    expect(screen.getByText('No matching activity on this page.')).toBeInTheDocument();
    expect(screen.getByText('Showing 1–12 of 47')).toBeInTheDocument();
    expect(state.requestedKeys).toEqual([`${taskA}:1`]);
    expect(state.refetch).not.toHaveBeenCalled();
  });

  it('uses only each current page, updates after same-task data changes, and hides while refetching', () => {
    ready(taskA, 1, [
      entry('page-one-first', taskA, 'human', 'task:status_changed'),
      entry('foreign-page-one', taskB, 'human', 'task:status_changed'),
      entry('page-one-second', taskA, 'human', 'comment'),
    ], 3, 2);
    ready(taskA, 2, [
      entry('page-two-status', taskA, 'human', 'task:status_changed'),
      entry('foreign-page-two', taskB, 'human', 'task:status_changed'),
    ], 3, 2);

    const view = render(<AuditLog taskId={taskA} />);
    expect(visibleCount()).toHaveTextContent(
      'Showing 2 of 2 loaded activity entries on this page.',
    );
    expect(screen.getByText('Showing 1–2 of 3')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Activity filter' }), {
      target: { value: 'status_changes' },
    });
    expect(visibleCount()).toHaveTextContent(
      'Showing 1 of 2 loaded activity entries on this page.',
    );
    expect(state.refetch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Next activity page' }));
    expect(visibleCount()).toHaveTextContent(
      'Showing 1 of 1 loaded activity entry on this page.',
    );
    expect(screen.getByText('Showing 3–3 of 3')).toBeInTheDocument();
    expect(screen.getByText('page-two-status')).toBeInTheDocument();
    expect(screen.queryByText('page-one-first')).not.toBeInTheDocument();

    state.results.set(`${taskA}:2`, {
      data: {
        data: [entry('stale-while-fetching', taskA, 'human', 'task:status_changed')],
        total: 3,
        page: 2,
        limit: 2,
      },
      isLoading: false,
      isError: false,
      isFetching: true,
    });
    view.rerender(<AuditLog taskId={taskA} />);
    expect(screen.getByText('stale-while-fetching')).toBeInTheDocument();
    expect(visibleCount()).not.toBeInTheDocument();

    ready(taskA, 2, [
      entry('page-two-refreshed-comment', taskA, 'human', 'comment'),
      entry('page-two-refreshed-status', taskA, 'human', 'task:status_changed'),
    ], 3, 2);
    view.rerender(<AuditLog taskId={taskA} />);
    expect(visibleCount()).toHaveTextContent(
      'Showing 1 of 2 loaded activity entries on this page.',
    );
    expect(screen.getByText('Showing 3–3 of 3')).toBeInTheDocument();
    expect(state.requestedKeys).toEqual([`${taskA}:1`, `${taskA}:2`]);
    expect(state.refetch).not.toHaveBeenCalled();
  });

  it('does not label page-mismatched, missing-page, pending, error, or out-of-range data current', () => {
    state.results.set(`${taskA}:1`, {
      data: {
        data: [entry('mismatched-page', taskA, 'human', 'comment')],
        total: 30,
        page: 2,
        limit: 20,
      },
      isLoading: false,
      isError: false,
      isFetching: false,
    });
    const mismatch = render(<AuditLog taskId={taskA} />);
    expect(visibleCount()).not.toBeInTheDocument();
    expect(screen.queryByText('mismatched-page')).not.toBeInTheDocument();
    mismatch.unmount();

    state.results.set(`${taskA}:1`, {
      data: {
        data: [entry('missing-page-metadata', taskA, 'human', 'comment')],
        total: 1,
        limit: 20,
      },
      isLoading: false,
      isError: false,
      isFetching: false,
    });
    const missingPage = render(<AuditLog taskId={taskA} />);
    expect(screen.getByText('missing-page-metadata')).toBeInTheDocument();
    expect(visibleCount()).not.toBeInTheDocument();
    missingPage.unmount();

    state.results.set(`${taskA}:1`, {
      data: undefined,
      isLoading: true,
      isError: false,
      isFetching: true,
    });
    const pending = render(<AuditLog taskId={taskA} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(visibleCount()).not.toBeInTheDocument();
    pending.unmount();

    state.results.set(`${taskA}:1`, {
      data: {
        data: [entry('failed-page', taskA, 'human', 'comment')],
        total: 1,
        page: 1,
        limit: 20,
      },
      isLoading: false,
      isError: true,
      isFetching: false,
    });
    const failed = render(<AuditLog taskId={taskA} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Activity is unavailable.');
    expect(visibleCount()).not.toBeInTheDocument();
    failed.unmount();

    ready(taskA, 1, [entry('page-one', taskA, 'human', 'comment')], 21, 20);
    ready(taskA, 2, [entry('now-out-of-range', taskA, 'human', 'comment')], 20, 20);
    const outOfRange = render(<AuditLog taskId={taskA} />);
    state.results.delete(`${taskA}:1`);
    fireEvent.click(screen.getByRole('button', { name: 'Next activity page' }));
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(visibleCount()).not.toBeInTheDocument();
    expect(screen.queryByText('now-out-of-range')).not.toBeInTheDocument();
    outOfRange.unmount();
  });

  it('uses the new task page and excludes foreign rows after a task switch', () => {
    ready(taskA, 1, [
      entry('old-task-status', taskA, 'human', 'task:status_changed'),
    ], 1);
    const view = render(<AuditLog taskId={taskA} />);
    expect(visibleCount()).toHaveTextContent(
      'Showing 1 of 1 loaded activity entry on this page.',
    );
    view.rerender(<AuditLog taskId={taskB} />);

    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(visibleCount()).not.toBeInTheDocument();
    expect(screen.queryByText('old-task-status')).not.toBeInTheDocument();

    ready(taskB, 1, [
      entry('foreign-old-task', taskA, 'human', 'task:status_changed'),
      entry('new-task-comment', taskB, 'human', 'comment'),
    ], 2);
    view.rerender(<AuditLog taskId={taskB} />);

    expect(screen.getByRole('combobox', { name: 'Activity filter' })).toHaveValue('all');
    expect(visibleCount()).toHaveTextContent(
      'Showing 1 of 1 loaded activity entry on this page.',
    );
    expect(screen.getByText('new-task-comment')).toBeInTheDocument();
    expect(screen.queryByText('old-task-status')).not.toBeInTheDocument();
    expect(screen.queryByText('foreign-old-task')).not.toBeInTheDocument();
    expect(state.requestedKeys).toEqual([`${taskA}:1`, `${taskB}:1`]);
    expect(state.refetch).not.toHaveBeenCalled();
  });
});
