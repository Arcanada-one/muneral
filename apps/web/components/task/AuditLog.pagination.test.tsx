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
  payload: null;
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
  requested: [] as Array<{ taskId: string; page: number }>,
}));

vi.mock('@/lib/api/tasks', () => ({
  useActivity: (taskId: string, page = 1) => {
    state.requested.push({ taskId, page });
    return state.results.get(`${taskId}:${page}`) ?? {
      data: undefined,
      isLoading: false,
      isError: false,
    };
  },
}));

const taskA = '11111111-1111-4111-8111-111111111111';
const taskB = '22222222-2222-4222-8222-222222222222';
const createdAt = '2026-10-24T00:00:00.000Z';

function entry(taskId: string, number: number): ActivityFixture {
  return {
    id: `${taskId}-activity-${number}`,
    taskId,
    actorId: '33333333-3333-4333-8333-333333333333',
    actorName: `event-${number}`,
    actorType: 'human',
    action: 'task:updated',
    payload: null,
    createdAt,
  };
}

function page(taskId: string, number: number, total: number, limit = 20): ActivityResult {
  const start = (number - 1) * limit + 1;
  const end = Math.min(number * limit, total);
  return {
    data: Array.from({ length: Math.max(0, end - start + 1) }, (_, index) =>
      entry(taskId, start + index),
    ),
    total,
    page: number,
    limit,
  };
}

function ready(taskId: string, number: number, total: number, limit = 20) {
  state.results.set(`${taskId}:${number}`, {
    data: page(taskId, number, total, limit),
    isLoading: false,
    isError: false,
  });
}

beforeEach(() => {
  state.results.clear();
  state.requested = [];
});

afterEach(() => cleanup());

describe('AuditLog activity pagination', () => {
  it('opens the 21st entry and returns to the newest page', () => {
    ready(taskA, 1, 21);
    ready(taskA, 2, 21);

    render(<AuditLog taskId={taskA} />);
    expect(screen.getByText('Showing 1–20 of 21')).toBeInTheDocument();
    expect(screen.getByText('event-1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous activity page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next activity page' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next activity page' }));
    expect(state.requested.at(-1)).toEqual({ taskId: taskA, page: 2 });
    expect(screen.getByText('Showing 21–21 of 21')).toBeInTheDocument();
    expect(screen.getByText('event-21')).toBeInTheDocument();
    expect(screen.queryByText('event-1')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Previous activity page' }));
    expect(state.requested.at(-1)).toEqual({ taskId: taskA, page: 1 });
    expect(screen.getByText('event-1')).toBeInTheDocument();
    expect(screen.queryByText('event-21')).not.toBeInTheDocument();
  });

  it('resets to page one on task change and excludes rows bound to another task', () => {
    ready(taskA, 1, 21);
    ready(taskA, 2, 21);
    const taskBResult = page(taskB, 1, 1);
    taskBResult.data = [entry(taskB, 99), entry(taskA, 98)];
    state.results.set(`${taskB}:1`, {
      data: taskBResult,
      isLoading: false,
      isError: false,
    });

    const view = render(<AuditLog taskId={taskA} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next activity page' }));
    expect(screen.getByText('event-21')).toBeInTheDocument();

    view.rerender(<AuditLog taskId={taskB} />);
    expect(state.requested.at(-1)).toEqual({ taskId: taskB, page: 1 });
    expect(screen.getByText('event-99')).toBeInTheDocument();
    expect(screen.queryByText('event-21')).not.toBeInTheDocument();
    expect(screen.queryByText('event-98')).not.toBeInTheDocument();
  });

  it('returns to the newest page when the total shrinks below the current page', () => {
    ready(taskA, 1, 41);
    ready(taskA, 2, 41);
    state.results.set(`${taskA}:3`, {
      data: { data: [], total: 21, page: 3, limit: 20 },
      isLoading: false,
      isError: false,
    });
    ready(taskA, 1, 21);

    render(<AuditLog taskId={taskA} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next activity page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next activity page' }));

    expect(state.requested.at(-1)).toEqual({ taskId: taskA, page: 1 });
    expect(screen.getByText('Showing 1–20 of 21')).toBeInTheDocument();
    expect(screen.getByText('event-1')).toBeInTheDocument();
  });

  it('keeps navigation disabled while loading and preserves the error state', () => {
    state.results.set(`${taskA}:1`, { data: undefined, isLoading: true, isError: false });
    const loading = render(<AuditLog taskId={taskA} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next activity page' })).not.toBeInTheDocument();
    loading.unmount();

    state.results.set(`${taskA}:1`, { data: undefined, isLoading: false, isError: true });
    render(<AuditLog taskId={taskA} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Activity is unavailable. Try again later.');
  });

  it('shows an empty state and disables both boundaries when there are no entries', () => {
    ready(taskA, 1, 0);

    render(<AuditLog taskId={taskA} />);

    expect(screen.getByText('Showing 0–0 of 0')).toBeInTheDocument();
    expect(screen.getByText('No activity on this page.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous activity page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next activity page' })).toBeDisabled();
  });
});
