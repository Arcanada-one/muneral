import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '@/lib/api/tasks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KanbanBoard } from './KanbanBoard';

const state = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));

vi.mock('@/lib/api/client', () => ({ default: { get: state.get, patch: state.patch } }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null }) }));
vi.mock('@/lib/ws/kanban', () => ({
  createKanbanWsClient: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
}));
vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragEnd }: { children: React.ReactNode; onDragEnd: (event: unknown) => void }) => (
    <div>
      <button
        type="button"
        onClick={() => onDragEnd({
          active: { id: '11111111-1111-4111-8111-111111111111' },
          over: { id: 'in_progress' },
        })}
      >
        Move task to In Progress
      </button>
      {children}
    </div>
  ),
  DragOverlay: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PointerSensor: function PointerSensor() {},
  useSensor: (...args: unknown[]) => args[0],
  useSensors: (...args: unknown[]) => args,
}));
vi.mock('./KanbanColumn', () => ({
  KanbanColumn: ({ status, tasks }: { status: string; tasks: Task[] }) => (
    <section aria-label={`${status} tasks`}>
      {tasks.map((task) => <p key={task.id}>{task.title}</p>)}
    </section>
  ),
}));
vi.mock('./KanbanCard', () => ({ KanbanCard: () => null }));

const projectId = '22222222-2222-4222-8222-222222222222';
const task: Task = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Move feedback task',
  status: 'todo',
  priority: 'medium',
  projectId,
  actorType: 'human',
  createdAt: '2026-10-24T05:00:00.000Z',
  updatedAt: '2026-10-24T05:00:00.000Z',
};
const queryClients: QueryClient[] = [];

beforeEach(() => {
  state.get.mockReset();
  state.patch.mockReset();
  state.get.mockResolvedValue({ data: { data: [], total: 0, page: 1, limit: 50 } });
});
afterEach(() => {
  cleanup();
  queryClients.splice(0).forEach((queryClient) => queryClient.clear());
});

function renderBoard(currentProjectId = projectId) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClients.push(queryClient);
  queryClient.setQueryData(['tasks', 'project', currentProjectId, {}], {
    data: [task], total: 1, page: 1, limit: 50,
  });

  const result = render(
    <QueryClientProvider client={queryClient}>
      <KanbanBoard projectId={currentProjectId} wsSlug="workspace" projSlug="project" />
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

describe('KanbanBoard status-move feedback', () => {
  it('shows a generic recovery message when the existing status PATCH rejects', async () => {
    state.patch.mockRejectedValue(new Error('private server response detail'));
    renderBoard();

    fireEvent.click(screen.getByRole('button', { name: 'Move task to In Progress' }));

    await waitFor(() => expect(state.patch).toHaveBeenCalledWith(
      `/tasks/${task.id}/status`,
      { status: 'in_progress' },
    ));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not change the task status. Try again.',
    );
    expect(screen.queryByText('private server response detail')).not.toBeInTheDocument();
  });

  it('does not carry a late move failure into another project board', async () => {
    let rejectRequest: ((reason: Error) => void) | undefined;
    state.patch
      .mockRejectedValueOnce(new Error('first move failed'))
      .mockReturnValueOnce(new Promise((_resolve, reject) => { rejectRequest = reject; }));
    const { rerender, queryClient } = renderBoard();

    fireEvent.click(screen.getByRole('button', { name: 'Move task to In Progress' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not change the task status. Try again.',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Move task to In Progress' }));
    await waitFor(() => expect(state.patch).toHaveBeenCalledTimes(2));

    rerender(
      <QueryClientProvider client={queryClient}>
        <KanbanBoard projectId="33333333-3333-4333-8333-333333333333" wsSlug="workspace" projSlug="other" />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => rejectRequest?.(new Error('private server response detail')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears the failure when a later move starts and remains clear when it succeeds', async () => {
    let confirmMove: ((response: { data: Task }) => void) | undefined;
    state.patch
      .mockRejectedValueOnce(new Error('private server response detail'))
      .mockReturnValueOnce(new Promise((resolve) => { confirmMove = resolve; }));
    renderBoard();

    fireEvent.click(screen.getByRole('button', { name: 'Move task to In Progress' }));
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Move task to In Progress' }));
    await waitFor(() => expect(state.patch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => confirmMove?.({ data: { ...task, status: 'in_progress' } }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('keeps the newer move feedback when an older move fails afterward', async () => {
    let rejectEarlierMove: ((reason: Error) => void) | undefined;
    let rejectLaterMove: ((reason: Error) => void) | undefined;
    state.patch
      .mockReturnValueOnce(new Promise((_resolve, reject) => { rejectEarlierMove = reject; }))
      .mockReturnValueOnce(new Promise((_resolve, reject) => { rejectLaterMove = reject; }));
    renderBoard();

    fireEvent.click(screen.getByRole('button', { name: 'Move task to In Progress' }));
    await waitFor(() => expect(state.patch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Move task to In Progress' }));
    await waitFor(() => expect(state.patch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => rejectLaterMove?.(new Error('newer move failed')));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not change the task status. Try again.',
    );

    await act(async () => rejectEarlierMove?.(new Error('private server response detail')));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not change the task status. Try again.',
    );
  });
});
