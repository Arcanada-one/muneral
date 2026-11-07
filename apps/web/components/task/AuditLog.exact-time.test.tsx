import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
      ...(state.results.get(key) ?? { data: undefined, isLoading: false, isError: false }),
      refetch: state.refetch,
    };
  },
}));

const taskA = '11111111-1111-4111-8111-111111111111';
const taskB = '22222222-2222-4222-8222-222222222222';
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function entry(id: string, taskId: string, createdAt: string, action = 'comment'): ActivityEntry {
  return {
    id,
    taskId,
    actorId: `${id}-actor`,
    actorName: id,
    actorType: action === 'task:status_changed' ? 'agent' : 'human',
    action,
    payload: action === 'task:status_changed' ? { from: 'todo', to: 'done' } : null,
    createdAt,
  };
}

function ready(taskId: string, page: number, entries: ActivityEntry[], total: number, limit = 20) {
  state.results.set(`${taskId}:${page}`, {
    data: { data: entries, total, page, limit },
    isLoading: false,
    isError: false,
  });
}

function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-29T12:00:00.000Z'));
  state.results.clear();
  state.queryKeys = [];
  state.refetch = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

describe('AuditLog exact UTC activity time', () => {
  it('defaults to relative time and normalizes equivalent UTC and offset instants', () => {
    ready(taskA, 1, [
      entry('utc-row', taskA, '2026-10-29T11:30:00.000Z'),
      entry('offset-row', taskA, '2026-10-29T14:30:00+03:00'),
    ], 2);
    const writeText = vi.fn();
    installClipboard(writeText);

    render(<AuditLog taskId={taskA} />);

    const toggle = screen.getByRole('checkbox', { name: 'Show exact UTC timestamps' });
    expect(toggle).not.toBeChecked();
    expect(screen.getAllByText('30m ago')).toHaveLength(2);
    const queryKeysBeforeToggle = [...state.queryKeys];

    fireEvent.click(toggle);

    expect(screen.getByRole('checkbox', { name: 'Show exact UTC timestamps' })).toBeChecked();
    expect(screen.getAllByText('2026-10-29T11:30:00.000Z')).toHaveLength(2);
    expect(screen.queryByText('30m ago')).not.toBeInTheDocument();
    expect(state.queryKeys).toEqual(queryKeysBeforeToggle);
    expect(state.refetch).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole('button', { name: 'Copy recorded actor ID' })[0]);
    expect(writeText).toHaveBeenCalledWith('utc-row-actor');
  });

  it('shows a generic message for invalid and zone-less input without reflecting raw values', () => {
    const invalid = '2026-02-30T10:00:00Z';
    const zoneLess = '2026-10-29T11:30:00';
    const malformed = 'raw-secret-like-value';
    ready(taskA, 1, [
      entry('invalid-row', taskA, invalid),
      entry('zoneless-row', taskA, zoneLess),
      entry('malformed-row', taskA, malformed),
    ], 3);

    render(<AuditLog taskId={taskA} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show exact UTC timestamps' }));

    expect(screen.getAllByText('Exact time unavailable')).toHaveLength(3);
    expect(screen.queryByText(invalid)).not.toBeInTheDocument();
    expect(screen.queryByText(zoneLess)).not.toBeInTheDocument();
    expect(screen.queryByText(malformed)).not.toBeInTheDocument();
  });

  it('preserves expanded UTC years and fractional precision when offsets cross year boundaries', () => {
    ready(taskA, 1, [
      entry('lower-year-rollover', taskA, '0000-01-01T00:30:00.1234500+01:00'),
      entry('upper-year-rollover', taskA, '9999-12-31T23:30:00.1234500-01:00'),
    ], 2);

    render(<AuditLog taskId={taskA} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show exact UTC timestamps' }));

    expect(screen.getByText('-000001-12-31T23:30:00.12345Z')).toBeInTheDocument();
    expect(screen.getByText('+010000-01-01T00:30:00.12345Z')).toBeInTheDocument();
  });

  it('retains exact mode through same-task refresh and page navigation, preserves filters, then resets on task switch', () => {
    ready(taskA, 1, [
      entry('page-one-status', taskA, '2026-10-29T11:00:00Z', 'task:status_changed'),
      entry('page-one-comment', taskA, '2026-10-29T11:15:00Z'),
    ], 22);
    ready(taskA, 2, [
      entry('page-two-status', taskA, '2026-10-29T11:20:00Z', 'task:status_changed'),
      entry('page-two-comment', taskA, '2026-10-29T11:25:00Z'),
    ], 22);
    ready(taskB, 1, [entry('new-task-row', taskB, '2026-10-29T11:30:00Z')], 1);

    const view = render(<AuditLog taskId={taskA} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show exact UTC timestamps' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Activity filter' }), {
      target: { value: 'status_changes' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Actor filter' }), {
      target: { value: 'agents' },
    });
    expect(screen.getByText('To Do → Done')).toBeInTheDocument();
    expect(screen.getByText('2026-10-29T11:00:00.000Z')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Actor filter' })).toHaveValue('agents');
    expect(screen.getByText('Showing 1–20 of 22')).toBeInTheDocument();

    ready(taskA, 1, [entry('refreshed-status', taskA, '2026-10-29T11:10:00Z', 'task:status_changed')], 22);
    view.rerender(<AuditLog taskId={taskA} />);
    expect(screen.getByRole('checkbox', { name: 'Show exact UTC timestamps' })).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Activity filter' })).toHaveValue('status_changes');
    expect(screen.getByRole('combobox', { name: 'Actor filter' })).toHaveValue('agents');
    expect(screen.getByText('2026-10-29T11:10:00.000Z')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next activity page' }));
    expect(screen.getByRole('checkbox', { name: 'Show exact UTC timestamps' })).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Activity filter' })).toHaveValue('status_changes');
    expect(screen.getByRole('combobox', { name: 'Actor filter' })).toHaveValue('agents');
    expect(screen.getByText('2026-10-29T11:20:00.000Z')).toBeInTheDocument();
    expect(screen.queryByText('page-two-comment')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 21–22 of 22')).toBeInTheDocument();

    view.rerender(<AuditLog taskId={taskB} />);
    expect(screen.getByRole('checkbox', { name: 'Show exact UTC timestamps' })).not.toBeChecked();
    expect(screen.getByText('30m ago')).toBeInTheDocument();
    expect(screen.queryByText('2026-10-29T11:30:00.000Z')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 1–1 of 1')).toBeInTheDocument();
  });
});
