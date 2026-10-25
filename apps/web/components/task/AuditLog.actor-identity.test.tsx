import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AuditLog } from './AuditLog';

const activityState = vi.hoisted(() => ({ data: [] as Array<Record<string, unknown>> }));

vi.mock('@/lib/api/tasks', () => ({
  useActivity: () => ({
    data: { data: activityState.data, total: activityState.data.length, page: 1, limit: 20 },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

const actorId = '33333333-3333-4333-8333-333333333333';
const taskId = '11111111-1111-4111-8111-111111111111';

function activityEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'activity-1',
    taskId,
    actorId,
    actorType: 'human',
    actorName: 'Task owner',
    action: 'task:created',
    payload: null,
    createdAt: '2026-10-25T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  activityState.data = [];
});

afterEach(cleanup);

describe('AuditLog actor identity', () => {
  it('shows the returned actor name when one is available', () => {
    activityState.data = [activityEntry()];

    render(<AuditLog taskId={taskId} />);

    expect(screen.getByText('Task owner')).toBeInTheDocument();
    expect(screen.queryByText(`Actor ID: ${actorId}`)).not.toBeInTheDocument();
  });

  it('shows the full recorded actor ID when the response has no actor name', () => {
    activityState.data = [activityEntry({ actorName: undefined })];

    render(<AuditLog taskId={taskId} />);

    expect(screen.getByText(`Actor ID: ${actorId}`)).toBeInTheDocument();
  });
});
