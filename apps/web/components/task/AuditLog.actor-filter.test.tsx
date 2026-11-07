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
  queryKeys: [] as string[],
  refetch: vi.fn(),
}));

vi.mock('@/lib/api/tasks', () => ({
  useActivity: (taskId: string, page = 1) => {
    const key = `${taskId}:${page}`;
    if (state.queryKeys.at(-1) !== key) state.queryKeys.push(key);
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
const createdAt = '2026-10-24T00:00:00.000Z';
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function entry(
  id: string,
  taskId: string,
  actorType: string,
  action: string,
): ActivityFixture {
  return {
    id,
    taskId,
    actorId: `${id}-actor-id`,
    actorName: id,
    actorType,
    action,
    payload: action === 'task:status_changed' ? { from: 'todo', to: 'done' } : null,
    createdAt,
  };
}

function ready(taskId: string, page: number, entries: ActivityFixture[], total: number, limit = 20) {
  state.results.set(`${taskId}:${page}`, {
    data: { data: entries, total, page, limit },
    isLoading: false,
    isError: false,
  });
}

function visibleEntryNames(): string[] {
  return screen.getAllByRole('listitem').map((item) => item.textContent ?? '');
}

function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

beforeEach(() => {
  state.results.clear();
  state.queryKeys = [];
  state.refetch = vi.fn();
});

afterEach(() => {
  cleanup();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

describe('AuditLog activity actor filter', () => {
  it('shows the exact choices, defaults to all, and keeps unknown actor types only in All actors', () => {
    ready(taskA, 1, [
      entry('human-first', taskA, 'human', 'comment'),
      entry('agent-middle', taskA, 'agent', 'task:updated'),
      entry('unknown-last', taskA, 'service', 'task:created'),
    ], 28);

    render(<AuditLog taskId={taskA} />);

    const filter = screen.getByRole('combobox', { name: 'Actor filter' });
    expect(filter).toHaveValue('all');
    expect(Array.from((filter as HTMLSelectElement).options).map((option) => option.textContent))
      .toEqual(['All actors', 'Humans on this page', 'Agents on this page']);
    expect(visibleEntryNames()).toHaveLength(3);
    expect(visibleEntryNames()[0]).toContain('human-first');
    expect(visibleEntryNames()[1]).toContain('agent-middle');
    expect(visibleEntryNames()[2]).toContain('unknown-last');
    expect(screen.getByText('Showing 1–20 of 28')).toBeInTheDocument();

    fireEvent.change(filter, { target: { value: 'humans' } });
    expect(visibleEntryNames()).toHaveLength(1);
    expect(visibleEntryNames()[0]).toContain('human-first');
    expect(screen.queryByText('unknown-last')).not.toBeInTheDocument();

    fireEvent.change(filter, { target: { value: 'agents' } });
    expect(visibleEntryNames()).toHaveLength(1);
    expect(visibleEntryNames()[0]).toContain('agent-middle');
    expect(screen.queryByText('unknown-last')).not.toBeInTheDocument();
  });

  it('composes with the action filter, preserves order and actor copy controls, and reports a local no-match', () => {
    const writeText = vi.fn();
    installClipboard(writeText);
    ready(taskA, 1, [
      entry('agent-comment', taskA, 'agent', 'comment'),
      entry('human-status-first', taskA, 'human', 'task:status_changed'),
      entry('human-status-second', taskA, 'human', 'task:status_changed'),
    ], 35);

    render(<AuditLog taskId={taskA} />);

    fireEvent.change(screen.getByRole('combobox', { name: 'Activity filter' }), {
      target: { value: 'status_changes' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Actor filter' }), {
      target: { value: 'humans' },
    });

    expect(visibleEntryNames()).toHaveLength(2);
    expect(visibleEntryNames()[0]).toContain('human-status-first');
    expect(visibleEntryNames()[1]).toContain('human-status-second');
    expect(screen.getAllByRole('button', { name: 'Copy recorded actor ID' })).toHaveLength(2);
    expect(screen.getAllByText('human')).toHaveLength(2);
    expect(screen.getAllByText('To Do → Done')).toHaveLength(2);
    expect(screen.getByText('Showing 1–20 of 35')).toBeInTheDocument();
    expect(writeText).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: 'Copy recorded actor ID' })[0]);
    expect(writeText).toHaveBeenCalledWith('human-status-first-actor-id');

    fireEvent.change(screen.getByRole('combobox', { name: 'Actor filter' }), {
      target: { value: 'agents' },
    });
    expect(screen.getByText('No matching activity on this page.')).toBeInTheDocument();
    expect(screen.getByText('Showing 1–20 of 35')).toBeInTheDocument();
    expect(screen.queryByText('No activity on this page.')).not.toBeInTheDocument();
    expect(writeText).toHaveBeenCalledOnce();
  });

  it('does not refetch on local selection and applies the selection after normal page navigation', () => {
    ready(taskA, 1, [
      entry('agent-page-one', taskA, 'agent', 'comment'),
    ], 21);
    ready(taskA, 2, [
      entry('human-page-two', taskA, 'human', 'comment'),
      entry('agent-page-two', taskA, 'agent', 'comment'),
    ], 21);

    render(<AuditLog taskId={taskA} />);
    const filter = screen.getByRole('combobox', { name: 'Actor filter' });
    fireEvent.change(filter, { target: { value: 'humans' } });

    expect(state.queryKeys).toEqual([`${taskA}:1`]);
    expect(state.refetch).not.toHaveBeenCalled();
    expect(screen.getByText('Showing 1–20 of 21')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next activity page' }));

    expect(state.queryKeys).toEqual([`${taskA}:1`, `${taskA}:2`]);
    expect(screen.getByRole('combobox', { name: 'Actor filter' })).toHaveValue('humans');
    expect(screen.getByText('human-page-two')).toBeInTheDocument();
    expect(screen.queryByText('agent-page-two')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 21–21 of 21')).toBeInTheDocument();
  });

  it('retains selection on same-task refresh and resets it on task change', () => {
    ready(taskA, 1, [
      entry('agent-before-refresh', taskA, 'agent', 'comment'),
    ], 1);
    ready(taskB, 1, [
      entry('human-new-task', taskB, 'human', 'comment'),
      entry('agent-new-task', taskB, 'agent', 'comment'),
    ], 2);

    const view = render(<AuditLog taskId={taskA} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Actor filter' }), {
      target: { value: 'agents' },
    });
    expect(screen.getByText('agent-before-refresh')).toBeInTheDocument();

    ready(taskA, 1, [
      entry('human-after-refresh', taskA, 'human', 'comment'),
      entry('agent-after-refresh', taskA, 'agent', 'comment'),
    ], 2);
    view.rerender(<AuditLog taskId={taskA} />);
    expect(screen.getByRole('combobox', { name: 'Actor filter' })).toHaveValue('agents');
    expect(screen.getByText('agent-after-refresh')).toBeInTheDocument();
    expect(screen.queryByText('human-after-refresh')).not.toBeInTheDocument();

    view.rerender(<AuditLog taskId={taskB} />);
    expect(screen.getByRole('combobox', { name: 'Actor filter' })).toHaveValue('all');
    expect(screen.getByText('human-new-task')).toBeInTheDocument();
    expect(screen.getByText('agent-new-task')).toBeInTheDocument();
  });

  it('preserves loading and error recovery states', () => {
    state.results.set(`${taskA}:1`, { data: undefined, isLoading: true, isError: false });
    const loading = render(<AuditLog taskId={taskA} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Actor filter' })).not.toBeInTheDocument();
    loading.unmount();

    state.results.set(`${taskA}:1`, { data: undefined, isLoading: false, isError: true });
    render(<AuditLog taskId={taskA} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Activity is unavailable. Try again later.');
    expect(screen.getByRole('button', { name: 'Retry activity' })).toBeEnabled();
    expect(screen.queryByRole('combobox', { name: 'Actor filter' })).not.toBeInTheDocument();
  });
});
