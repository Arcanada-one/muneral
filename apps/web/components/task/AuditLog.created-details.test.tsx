import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AuditLog } from './AuditLog';

const activityState = vi.hoisted(() => ({
  data: [] as Array<{
    id: string;
    taskId: string;
    actorId: string;
    actorName: string;
    actorType: 'human';
    action: string;
    payload: unknown;
    createdAt: string;
  }>,
}));

vi.mock('@/lib/api/tasks', () => ({
  useActivity: () => ({
    data: { data: activityState.data, total: activityState.data.length, page: 1, limit: 20 },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

const taskId = '11111111-1111-4111-8111-111111111111';

function createdEntry(payload: unknown) {
  return {
    id: 'activity-created',
    taskId,
    actorId: '22222222-2222-4222-8222-222222222222',
    actorName: 'Task creator',
    actorType: 'human' as const,
    action: 'task:created',
    payload,
    createdAt: '2026-10-24T00:00:00.000Z',
  };
}

beforeEach(() => {
  activityState.data = [];
});

afterEach(cleanup);

describe('AuditLog task creation details', () => {
  it('shows the initial title and canonical status with the existing event context', () => {
    activityState.data = [createdEntry({ title: 'Original title', status: 'todo' })];

    render(<AuditLog taskId={taskId} />);

    expect(screen.getByText('Task creator')).toBeInTheDocument();
    expect(screen.getByText('task:created')).toBeInTheDocument();
    expect(screen.getByText('Created “Original title” · Status: To Do')).toBeInTheDocument();
  });

  it.each([
    ['todo', 'To Do'],
    ['in_progress', 'In Progress'],
    ['review', 'Review'],
    ['blocked', 'Blocked'],
    ['done', 'Done'],
    ['cancelled', 'Cancelled'],
    ['archived', 'Archived'],
  ])('uses the canonical label for %s', (status, label) => {
    activityState.data = [createdEntry({ title: 'Created title', status })];

    render(<AuditLog taskId={taskId} />);

    expect(screen.getByText(`Created “Created title” · Status: ${label}`)).toBeInTheDocument();
  });

  it('renders a task title as inert text', () => {
    const title = '<img src=x onerror=alert(1)>';
    activityState.data = [createdEntry({ title, status: 'todo' })];

    render(<AuditLog taskId={taskId} />);

    expect(screen.getByText(`Created “${title}” · Status: To Do`)).toBeInTheDocument();
    expect(document.querySelector('img')).not.toBeInTheDocument();
  });

  it('keeps malformed or unknown creation payload values on the action fallback', () => {
    activityState.data = [createdEntry({ title: '<img src=x onerror=alert(1)>', status: 'unknown' })];

    render(<AuditLog taskId={taskId} />);

    expect(screen.getByText('task:created')).toBeInTheDocument();
    expect(screen.queryByText(/Created “/)).not.toBeInTheDocument();
    expect(document.querySelector('img')).not.toBeInTheDocument();
  });
});
