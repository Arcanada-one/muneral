import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
const otherActorId = '44444444-4444-4444-8444-444444444444';
const taskId = '11111111-1111-4111-8111-111111111111';
const otherTaskId = '99999999-9999-4999-8999-999999999999';

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

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

function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

beforeEach(() => {
  activityState.data = [];
});

afterEach(() => {
  cleanup();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

describe('AuditLog actor identity', () => {
  it('shows the returned actor name when one is available', () => {
    activityState.data = [activityEntry()];

    render(<AuditLog taskId={taskId} />);

    expect(screen.getByText('Task owner')).toBeInTheDocument();
    expect(screen.queryByText(`Actor ID: ${actorId}`)).not.toBeInTheDocument();
    expect(screen.getByText('human')).toBeInTheDocument();
  });

  it('shows the full recorded actor ID when the response has no actor name', () => {
    activityState.data = [activityEntry({ actorName: undefined })];

    render(<AuditLog taskId={taskId} />);

    expect(screen.getByText(`Actor ID: ${actorId}`)).toBeInTheDocument();
  });

  it.each([
    ['an actor name is present', { actorName: 'Task owner' }],
    ['the actor name is absent', { actorName: undefined }],
  ])('copies the exact recorded actor ID when %s', async (_case, overrides) => {
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    activityState.data = [activityEntry(overrides)];

    render(<AuditLog taskId={taskId} />);

    const copyButton = screen.getByRole('button', { name: 'Copy recorded actor ID' });
    expect(copyButton).toBeInTheDocument();
    expect(copyButton).not.toHaveAccessibleName(actorId);
    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(actorId);
    expect(await screen.findByRole('status')).toHaveTextContent('Actor ID copied.');
  });

  it('reports clipboard failure without exposing browser details', async () => {
    const writeText = installClipboard(vi.fn().mockRejectedValue(new Error('clipboard detail')));
    activityState.data = [activityEntry()];
    render(<AuditLog taskId={taskId} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy recorded actor ID' }));

    const failure = await screen.findByRole('alert');
    expect(failure).toHaveTextContent('Could not copy actor ID. Try copying it manually.');
    expect(failure).not.toHaveTextContent('clipboard detail');
    expect(writeText).toHaveBeenCalledWith(actorId);
  });

  it('disables duplicate copy requests while one clipboard call is pending', async () => {
    let resolveClipboard!: () => void;
    const writeText = installClipboard(vi.fn(() => new Promise<void>((resolve) => {
      resolveClipboard = resolve;
    })));
    activityState.data = [activityEntry()];
    render(<AuditLog taskId={taskId} />);
    const copyButton = screen.getByRole('button', { name: 'Copy recorded actor ID' });

    fireEvent.click(copyButton);
    expect(copyButton).toBeDisabled();
    fireEvent.click(copyButton);
    expect(writeText).toHaveBeenCalledOnce();

    await act(async () => resolveClipboard());
    expect(await screen.findByRole('status')).toHaveTextContent('Actor ID copied.');
  });

  it('does not show an old event copy result after that event is replaced', async () => {
    let resolveClipboard!: () => void;
    installClipboard(vi.fn(() => new Promise<void>((resolve) => {
      resolveClipboard = resolve;
    })));
    activityState.data = [activityEntry()];
    const view = render(<AuditLog taskId={taskId} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy recorded actor ID' }));
    activityState.data = [activityEntry({ id: 'activity-2', actorId: otherActorId })];
    view.rerender(<AuditLog taskId={taskId} />);
    expect(screen.getByRole('button', { name: 'Copy recorded actor ID' })).toBeInTheDocument();

    await act(async () => resolveClipboard());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not show an old task copy result after the task changes', async () => {
    let resolveClipboard!: () => void;
    installClipboard(vi.fn(() => new Promise<void>((resolve) => {
      resolveClipboard = resolve;
    })));
    activityState.data = [activityEntry()];
    const view = render(<AuditLog taskId={taskId} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy recorded actor ID' }));
    activityState.data = [activityEntry({ taskId: otherTaskId, actorId: otherActorId })];
    view.rerender(<AuditLog taskId={otherTaskId} />);

    await act(async () => resolveClipboard());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
