import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readTask } from '@/lib/api/read-contract';
import { TaskDetail } from './TaskDetail';

const state = vi.hoisted(() => ({ patch: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ default: { patch: state.patch, get: vi.fn() } }));
vi.mock('./TaskChecklist', () => ({ TaskChecklist: () => null }));
vi.mock('./TaskDependencies', () => ({ TaskDependencies: () => null }));
vi.mock('./TaskReadiness', () => ({ TaskReadiness: () => null }));
vi.mock('./AuditLog', () => ({ AuditLog: () => null }));
vi.mock('./TaskGitRefs', () => ({ TaskGitRefs: () => null }));

const taskId = '11111111-1111-4111-8111-111111111111';
const otherTaskId = '99999999-9999-4999-8999-999999999999';
const task = {
  id: taskId,
  title: 'Current task',
  status: 'todo',
  priority: 'medium',
  projectId: '22222222-2222-4222-8222-222222222222',
  actorType: 'human',
  createdAt: '2026-10-24T05:00:00.000Z',
  updatedAt: '2026-10-24T05:00:00.000Z',
};
const queryClients: QueryClient[] = [];
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

function renderTaskDetail(value: unknown) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClients.push(queryClient);
  const renderValue = (next: unknown) => (
    <QueryClientProvider client={queryClient}>
      <TaskDetail task={readTask(next)} />
    </QueryClientProvider>
  );
  const view = render(renderValue(value));
  return { ...view, rerenderTask: (next: unknown) => view.rerender(renderValue(next)) };
}

beforeEach(() => state.patch.mockReset());
afterEach(() => {
  cleanup();
  queryClients.splice(0).forEach((queryClient) => queryClient.clear());
  vi.restoreAllMocks();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

describe('TaskDetail current task ID', () => {
  it('copies the full validated current task ID only after a user action', async () => {
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    renderTaskDetail(task);

    expect(screen.getByText(taskId)).toBeInTheDocument();
    const copyButton = screen.getByRole('button', { name: `Copy current task ID ${taskId}` });
    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(taskId);
    expect(await screen.findByRole('status')).toHaveTextContent('Task ID copied.');
  });

  it('shows a generic failure when the browser clipboard rejects the copy', async () => {
    const writeText = installClipboard(vi.fn().mockRejectedValue(new Error('private browser detail')));
    renderTaskDetail(task);

    fireEvent.click(screen.getByRole('button', { name: `Copy current task ID ${taskId}` }));

    const failure = await screen.findByRole('alert');
    expect(failure).toHaveTextContent('Could not copy task ID. Try copying it manually.');
    expect(failure).not.toHaveTextContent('private browser detail');
    expect(writeText).toHaveBeenCalledWith(taskId);
  });

  it('disables duplicate copies while one clipboard request is pending', async () => {
    let resolveClipboard!: () => void;
    const writeText = installClipboard(vi.fn(() => new Promise<void>((resolve) => {
      resolveClipboard = resolve;
    })));
    renderTaskDetail(task);
    const copyButton = screen.getByRole('button', { name: `Copy current task ID ${taskId}` });

    fireEvent.click(copyButton);
    expect(copyButton).toBeDisabled();
    fireEvent.click(copyButton);
    expect(writeText).toHaveBeenCalledOnce();

    await act(async () => resolveClipboard());
    expect(await screen.findByRole('status')).toHaveTextContent('Task ID copied.');
  });

  it('does not show an old task copy result after the current task changes', async () => {
    let resolveClipboard!: () => void;
    installClipboard(vi.fn(() => new Promise<void>((resolve) => {
      resolveClipboard = resolve;
    })));
    const view = renderTaskDetail(task);

    fireEvent.click(screen.getByRole('button', { name: `Copy current task ID ${taskId}` }));
    view.rerenderTask({ ...task, id: otherTaskId, title: 'Next task' });
    expect(screen.getByText(otherTaskId)).toBeInTheDocument();
    expect(screen.queryByText(taskId)).not.toBeInTheDocument();

    await act(async () => resolveClipboard());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('rejects malformed task IDs before the detail component can render', () => {
    expect(() => renderTaskDetail({ ...task, id: 'not-a-uuid' })).toThrow(/invalid response shape/);
  });
});
