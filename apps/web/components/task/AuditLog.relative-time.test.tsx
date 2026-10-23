import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AuditLog } from './AuditLog';

const state = vi.hoisted(() => ({ activity: { data: undefined as unknown, isLoading: false, isError: false } }));

vi.mock('@/lib/api/tasks', () => ({ useActivity: () => state.activity }));

const taskId = '11111111-1111-4111-8111-111111111111';
const now = new Date('2026-10-23T12:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  state.activity = { data: undefined, isLoading: false, isError: false };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderActivity(createdAt: string) {
  state.activity.data = {
    data: [{ id: '22222222-2222-4222-8222-222222222222', actorType: 'human', action: 'comment', createdAt }],
  };
  render(<AuditLog taskId={taskId} />);
}

describe('AuditLog relative activity time', () => {
  it('labels a valid activity timestamp one hour in the future as future time', () => {
    renderActivity('2026-10-23T13:00:00.000Z');

    expect(screen.getByText('in 1h')).toBeInTheDocument();
    expect(screen.queryByText('just now')).not.toBeInTheDocument();
  });

  it('keeps elapsed minute wording for activity timestamps in the past', () => {
    renderActivity('2026-10-23T11:30:00.000Z');

    expect(screen.getByText('30m ago')).toBeInTheDocument();
  });

  it('keeps the near-now label for a timestamp less than a minute ahead', () => {
    renderActivity('2026-10-23T12:00:30.000Z');

    expect(screen.getByText('just now')).toBeInTheDocument();
  });
});
