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
  isFetching?: boolean;
  isPending?: boolean;
  fetchStatus?: 'idle' | 'fetching' | 'paused';
  refetch?: () => Promise<unknown>;
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
      isFetching: false,
      refetch: vi.fn().mockResolvedValue(undefined),
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
    isFetching: false,
    refetch: vi.fn().mockResolvedValue(undefined),
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
    state.results.set(`${taskA}:1`, { data: undefined, isLoading: true, isError: false, isFetching: true });
    const loading = render(<AuditLog taskId={taskA} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next activity page' })).not.toBeInTheDocument();
    loading.unmount();

    state.results.set(`${taskA}:1`, { data: undefined, isLoading: false, isError: true, isFetching: false });
    render(<AuditLog taskId={taskA} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Activity is unavailable. Try again later.');
  });

  it('does not present a paused initial no-data query as an empty activity page', () => {
    state.results.set(`${taskA}:1`, {
      data: undefined,
      isLoading: false,
      isError: false,
      isFetching: false,
      isPending: true,
      fetchStatus: 'paused',
    });

    render(<AuditLog taskId={taskA} />);

    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByText('No activity on this page.')).not.toBeInTheDocument();
    expect(screen.queryByText('Showing 0–0 of 0')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Activity pagination' })).not.toBeInTheDocument();
  });

  it('does not claim loading or empty activity when an empty task ID disables the query', () => {
    render(<AuditLog taskId="" />);

    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
    expect(screen.queryByText('No activity on this page.')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Activity pagination' })).not.toBeInTheDocument();
  });

  it('offers page recovery after an older activity page fails', () => {
    ready(taskA, 1, 21);
    const retryPageTwo = vi.fn().mockResolvedValue(undefined);
    state.results.set(`${taskA}:2`, {
      data: page(taskA, 2, 21),
      isLoading: false,
      isError: true,
      isFetching: false,
      refetch: retryPageTwo,
    });

    render(<AuditLog taskId={taskA} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next activity page' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Activity is unavailable. Try again later.');
    expect(screen.getByRole('button', { name: 'Retry activity' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Show newest activity' })).toBeEnabled();
    expect(screen.queryByText('event-21')).not.toBeInTheDocument();
  });

  it('retries the failed first-page query and renders its recovered result', async () => {
    const retryFirstPage = vi.fn().mockResolvedValue(undefined);
    state.results.set(`${taskA}:1`, {
      data: undefined,
      isLoading: false,
      isError: true,
      isFetching: false,
      refetch: retryFirstPage,
    });

    const view = render(<AuditLog taskId={taskA} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry activity' }));
    expect(retryFirstPage).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Show newest activity' })).not.toBeInTheDocument();

    ready(taskA, 1, 1);
    view.rerender(<AuditLog taskId={taskA} />);
    expect(screen.getByText('event-1')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retries the same failed older-page query without showing stale rows', () => {
    ready(taskA, 1, 21);
    const retryPageTwo = vi.fn().mockResolvedValue(undefined);
    state.results.set(`${taskA}:2`, {
      data: page(taskA, 2, 21),
      isLoading: false,
      isError: true,
      isFetching: false,
      refetch: retryPageTwo,
    });

    render(<AuditLog taskId={taskA} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next activity page' }));
    expect(screen.queryByText('event-21')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry activity' }));
    expect(retryPageTwo).toHaveBeenCalledOnce();
    expect(state.requested.at(-1)).toEqual({ taskId: taskA, page: 2 });
    expect(screen.getByRole('alert')).toHaveTextContent('Activity is unavailable. Try again later.');
  });

  it('escapes an older-page error by returning to the newest page', () => {
    ready(taskA, 1, 21);
    state.results.set(`${taskA}:2`, {
      data: page(taskA, 2, 21),
      isLoading: false,
      isError: true,
      isFetching: false,
      refetch: vi.fn().mockResolvedValue(undefined),
    });

    render(<AuditLog taskId={taskA} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next activity page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show newest activity' }));

    expect(state.requested.at(-1)).toEqual({ taskId: taskA, page: 1 });
    expect(screen.getByText('event-1')).toBeInTheDocument();
    expect(screen.queryByText('event-21')).not.toBeInTheDocument();
  });

  it('disables retry and newest-page recovery while a failed query is fetching', () => {
    ready(taskA, 1, 21);
    const retryPageTwo = vi.fn().mockResolvedValue(undefined);
    state.results.set(`${taskA}:2`, {
      data: page(taskA, 2, 21),
      isLoading: false,
      isError: true,
      isFetching: true,
      refetch: retryPageTwo,
    });

    render(<AuditLog taskId={taskA} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next activity page' }));
    const retry = screen.getByRole('button', { name: 'Retry activity' });
    const newest = screen.getByRole('button', { name: 'Show newest activity' });
    expect(retry).toBeDisabled();
    expect(newest).toBeDisabled();

    fireEvent.click(retry);
    fireEvent.click(newest);
    expect(retryPageTwo).not.toHaveBeenCalled();
    expect(state.requested.at(-1)).toEqual({ taskId: taskA, page: 2 });
  });

  it('uses only the current task query for error recovery after a task switch', () => {
    ready(taskA, 1, 21);
    const retryTaskA = vi.fn().mockResolvedValue(undefined);
    state.results.set(`${taskA}:2`, {
      data: page(taskA, 2, 21),
      isLoading: false,
      isError: true,
      isFetching: false,
      refetch: retryTaskA,
    });
    const retryTaskB = vi.fn().mockResolvedValue(undefined);
    state.results.set(`${taskB}:1`, {
      data: { ...page(taskB, 1, 1), data: [entry(taskA, 99)] },
      isLoading: false,
      isError: true,
      isFetching: false,
      refetch: retryTaskB,
    });

    const view = render(<AuditLog taskId={taskA} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next activity page' }));
    expect(screen.getByRole('button', { name: 'Show newest activity' })).toBeInTheDocument();

    view.rerender(<AuditLog taskId={taskB} />);
    expect(state.requested.at(-1)).toEqual({ taskId: taskB, page: 1 });
    expect(screen.queryByRole('button', { name: 'Show newest activity' })).not.toBeInTheDocument();
    expect(screen.queryByText('event-99')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry activity' }));
    expect(retryTaskB).toHaveBeenCalledOnce();
    expect(retryTaskA).not.toHaveBeenCalled();
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
