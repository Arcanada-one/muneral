import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AuditLog } from './AuditLog';

const state = vi.hoisted(() => ({ data: [] as Array<Record<string, unknown>> }));

vi.mock('@/lib/api/tasks', () => ({
  useActivity: (_taskId: string, _page: number) => ({
    data: { data: state.data, total: state.data.length, page: 1, limit: 20 },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));

const taskId = '11111111-1111-4111-8111-111111111111';
const otherTaskId = '99999999-9999-4999-8999-999999999999';
const exactTimestamp = '2026-10-23T08:15:30.123-04:00';
const replacementTimestamp = '2026-10-23T08:16:30.123+02:00';
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function activityEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'activity-1',
    taskId,
    actorId: '33333333-3333-4333-8333-333333333333',
    actorType: 'human',
    actorName: 'Task owner',
    action: 'comment',
    payload: null,
    createdAt: exactTimestamp,
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
  state.data = [activityEntry()];
});

afterEach(() => {
  cleanup();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

describe('AuditLog exact activity timestamps', () => {
  it('copies the unchanged returned timestamp only after an explicit click', async () => {
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    const { container } = render(<AuditLog taskId={taskId} />);

    const time = container.querySelector('time');
    expect(time).toHaveAttribute('datetime', exactTimestamp);
    expect(writeText).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Copy recorded activity timestamp' }));

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(exactTimestamp);
    expect(await screen.findByRole('status')).toHaveTextContent('Timestamp copied.');
  });

  it('reports clipboard failure without exposing browser details', async () => {
    const writeText = installClipboard(vi.fn().mockRejectedValue(new Error('clipboard detail')));
    render(<AuditLog taskId={taskId} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy recorded activity timestamp' }));

    const failure = await screen.findByRole('alert');
    expect(failure).toHaveTextContent('Could not copy timestamp. Try copying it manually.');
    expect(failure).not.toHaveTextContent('clipboard detail');
    expect(writeText).toHaveBeenCalledWith(exactTimestamp);
  });

  it('disables duplicate copies while the exact value is pending', async () => {
    let resolveClipboard!: () => void;
    const writeText = installClipboard(vi.fn(() => new Promise<void>((resolve) => {
      resolveClipboard = resolve;
    })));
    render(<AuditLog taskId={taskId} />);
    const button = screen.getByRole('button', { name: 'Copy recorded activity timestamp' });

    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledOnce();

    await act(async () => resolveClipboard());
    expect(await screen.findByRole('status')).toHaveTextContent('Timestamp copied.');
  });

  it('does not show a pending result after the event timestamp changes', async () => {
    let resolveClipboard!: () => void;
    installClipboard(vi.fn(() => new Promise<void>((resolve) => {
      resolveClipboard = resolve;
    })));
    const view = render(<AuditLog taskId={taskId} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy recorded activity timestamp' }));
    state.data = [activityEntry({ createdAt: replacementTimestamp })];
    view.rerender(<AuditLog taskId={taskId} />);

    await act(async () => resolveClipboard());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not show a pending result after the event changes', async () => {
    let resolveClipboard!: () => void;
    installClipboard(vi.fn(() => new Promise<void>((resolve) => {
      resolveClipboard = resolve;
    })));
    const view = render(<AuditLog taskId={taskId} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy recorded activity timestamp' }));
    state.data = [activityEntry({ id: 'activity-2' })];
    view.rerender(<AuditLog taskId={taskId} />);

    await act(async () => resolveClipboard());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not show a pending result after the task changes', async () => {
    let resolveClipboard!: () => void;
    installClipboard(vi.fn(() => new Promise<void>((resolve) => {
      resolveClipboard = resolve;
    })));
    const view = render(<AuditLog taskId={taskId} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy recorded activity timestamp' }));
    state.data = [activityEntry({ taskId: otherTaskId })];
    view.rerender(<AuditLog taskId={otherTaskId} />);

    await act(async () => resolveClipboard());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
