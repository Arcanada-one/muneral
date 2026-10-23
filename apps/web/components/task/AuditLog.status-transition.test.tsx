import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TASK_STATUSES, TASK_TRANSITIONS, type TaskStatus } from '@muneral/types';
import { AuditLog } from './AuditLog';

const state = vi.hoisted(() => ({
  activity: { data: undefined as unknown, isLoading: false, isError: false },
  requestedTaskId: undefined as string | undefined,
}));

vi.mock('@/lib/api/tasks', () => ({
  useActivity: (taskId: string) => {
    state.requestedTaskId = taskId;
    return state.activity;
  },
}));

const taskId = '11111111-1111-4111-8111-111111111111';
const activityId = '22222222-2222-4222-8222-222222222222';
const statusLabels: Record<TaskStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
  archived: 'Archived',
};

const validStatusTransitions = TASK_STATUSES.map((from) => {
  const to = TASK_TRANSITIONS[from][0];
  if (!to) throw new Error(`Status ${from} has no valid transition example`);
  return [from, to] as const;
});

beforeEach(() => {
  state.activity = { data: undefined, isLoading: false, isError: false };
  state.requestedTaskId = undefined;
});

afterEach(() => {
  cleanup();
});

function renderEntry(action: string, payload?: unknown) {
  state.activity.data = {
    data: [{
      id: activityId,
      taskId,
      actorId: '33333333-3333-4333-8333-333333333333',
      actorName: 'Task owner',
      actorType: 'human',
      action,
      payload,
      createdAt: '2026-10-23T12:00:00.000Z',
    }],
    total: 1,
    page: 1,
    limit: 20,
  };

  const result = render(<AuditLog taskId={taskId} />);
  return result;
}

describe('AuditLog status transition summaries', () => {
  it.each(validStatusTransitions)(
    'shows the known before and after labels for %s → %s',
    (from, to) => {
      renderEntry('task:status_changed', { from, to });

      expect(
        screen.getByText(`${statusLabels[from]} → ${statusLabels[to]}`),
      ).toBeInTheDocument();
      expect(screen.queryByText('task:status_changed')).not.toBeInTheDocument();
      expect(state.requestedTaskId).toBe(taskId);
    },
  );

  it.each([
    ['missing payload', undefined],
    ['null payload', null],
    ['array payload', ['todo', 'done']],
    ['boxed payload', Reflect.construct(String, ['todo'])],
    ['inherited fields', Object.create({ from: 'todo', to: 'done' })],
    ['missing destination', { from: 'todo' }],
    ['unknown source status', { from: 'future_status', to: 'done' }],
    ['unknown destination status', { from: 'todo', to: 'future_status' }],
    ['boxed source status', { from: Reflect.construct(String, ['todo']), to: 'done' }],
    ['non-string destination', { from: 'todo', to: 5 }],
    ['markup in destination', { from: 'todo', to: '<img src=x onerror=alert(1)>' }],
  ])('falls back to the action for %s', (_caseName, payload) => {
    renderEntry('task:status_changed', payload);

    expect(screen.getByText('task:status_changed')).toBeInTheDocument();
    expect(screen.queryByText(/To Do →/)).not.toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('keeps non-status actions even when their payload resembles a transition', () => {
    renderEntry('task:commented', { from: 'todo', to: 'done' });

    expect(screen.getByText('task:commented')).toBeInTheDocument();
    expect(screen.queryByText('To Do → Done')).not.toBeInTheDocument();
  });

  it('renders fallback action text as text, not markup', () => {
    const action = '<img src=x onerror=alert(1)>';
    const { container } = renderEntry(action, { from: 'unknown', to: 'done' });

    expect(screen.getByText(action)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('preserves the activity loading and error states', () => {
    state.activity = { data: undefined, isLoading: true, isError: false };
    const loading = render(<AuditLog taskId={taskId} />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    loading.unmount();

    state.activity = { data: undefined, isLoading: false, isError: true };
    render(<AuditLog taskId={taskId} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Activity is unavailable. Try again later.');
  });
});
