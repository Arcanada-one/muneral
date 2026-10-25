import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AuditLog } from './AuditLog';

const eventId = '44444444-4444-4444-8444-444444444444';
const otherEventId = '55555555-5555-4555-8555-555555555555';
const taskId = '11111111-1111-4111-8111-111111111111';
const otherTaskId = '66666666-6666-4666-8666-666666666666';
const state = vi.hoisted(() => ({ activity: undefined as unknown }));
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

vi.mock('@/lib/api/tasks', () => ({
  useActivity: () => state.activity,
}));

function entry(id: string, currentTaskId = taskId) {
  return {
    id,
    taskId: currentTaskId,
    actorId: '33333333-3333-4333-8333-333333333333',
    actorType: 'human' as const,
    actorName: 'Recorded actor',
    action: 'task:updated',
    payload: null,
    createdAt: '2026-10-25T00:00:00.000Z',
  };
}

function setActivity(activity: ReturnType<typeof entry>) {
  state.activity = {
    data: { data: [activity], total: 1, page: 1, limit: 20 },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  };
}

function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

beforeEach(() => {
  state.activity = undefined;
});

afterEach(() => {
  cleanup();
  if (originalClipboard) {
    Object.defineProperty(navigator, 'clipboard', originalClipboard);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

describe('AuditLog event ID copy', () => {
  it('shows the validated event UUID and copies that exact ID only after a user action', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);
    setActivity(entry(eventId));

    render(<AuditLog taskId={taskId} />);

    expect(screen.getByText('Event ID:')).toBeInTheDocument();
    expect(screen.getByText(eventId)).toBeInTheDocument();
    const copyButton = screen.getByRole('button', { name: `Copy activity event ID ${eventId}` });
    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(eventId);
  });

  it('shows generic failure feedback when the clipboard rejects the copy', async () => {
    installClipboard(vi.fn().mockRejectedValue(new Error('private clipboard detail')));
    setActivity(entry(eventId));

    render(<AuditLog taskId={taskId} />);
    fireEvent.click(screen.getByRole('button', { name: `Copy activity event ID ${eventId}` }));

    const failure = await screen.findByRole('alert');
    expect(failure).toHaveTextContent('Could not copy activity event ID. Try copying it manually.');
    expect(failure).not.toHaveTextContent('private clipboard detail');
  });

  it('prevents duplicate copy requests and suppresses late feedback after a task switch', async () => {
    let resolveCopy!: () => void;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { resolveCopy = resolve; }));
    installClipboard(writeText);
    setActivity(entry(eventId));
    const view = render(<AuditLog taskId={taskId} />);

    const copyButton = screen.getByRole('button', { name: `Copy activity event ID ${eventId}` });
    fireEvent.click(copyButton);
    expect(copyButton).toBeDisabled();
    fireEvent.click(copyButton);
    expect(writeText).toHaveBeenCalledOnce();

    setActivity(entry(otherEventId, otherTaskId));
    view.rerender(<AuditLog taskId={otherTaskId} />);
    expect(screen.getByRole('button', { name: `Copy activity event ID ${otherEventId}` })).toBeInTheDocument();

    await act(async () => { resolveCopy(); });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(eventId)).not.toBeInTheDocument();
  });
});
