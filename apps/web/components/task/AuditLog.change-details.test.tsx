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

function updatedEntry(payload: unknown) {
  return {
    id: 'activity-1',
    taskId,
    actorId: '22222222-2222-4222-8222-222222222222',
    actorName: 'Task editor',
    actorType: 'human' as const,
    action: 'task:updated',
    payload,
    createdAt: '2026-10-24T00:00:00.000Z',
  };
}

beforeEach(() => {
  activityState.data = [];
});

afterEach(cleanup);

describe('AuditLog task field changes', () => {
  it('shows known priority and due-date values from a task update beside its context', () => {
    const dueDate = '2026-10-28T00:00:00.000Z';
    activityState.data = [updatedEntry({ priority: 'high', dueDate })];

    render(<AuditLog taskId={taskId} />);

    expect(screen.getByText('Task editor')).toBeInTheDocument();
    expect(screen.getByText('Priority set to High')).toBeInTheDocument();
    expect(screen.getByText(`Due date set to ${new Date(dueDate).toLocaleDateString()}`)).toBeInTheDocument();
    expect(screen.getByText('task:updated')).toBeInTheDocument();
  });

  it('keeps unknown or free-text update payload fields hidden and falls back to the action', () => {
    activityState.data = [updatedEntry({
      priority: 'urgent',
      dueDate: 'not-a-date',
      title: 'Private title must not be repeated in activity',
      description: 'Private description must not be repeated in activity',
    })];

    render(<AuditLog taskId={taskId} />);

    expect(screen.getByText('task:updated')).toBeInTheDocument();
    expect(screen.queryByText('urgent')).not.toBeInTheDocument();
    expect(screen.queryByText('not-a-date')).not.toBeInTheDocument();
    expect(screen.queryByText('Private title must not be repeated in activity')).not.toBeInTheDocument();
    expect(screen.queryByText('Private description must not be repeated in activity')).not.toBeInTheDocument();
  });
});
