import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@/lib/api/tasks';
import { KanbanBoard } from './KanbanBoard';

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
const dnd = vi.hoisted(() => ({ onDragEnd: null as null | ((event: unknown) => void) }));

vi.mock('@/lib/api/client', () => ({ default: api }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null }) }));
vi.mock('@/lib/ws/kanban', () => ({
  createKanbanWsClient: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
}));
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: ({
      children,
      onDragEnd,
    }: {
      children: React.ReactNode;
      onDragEnd: (event: unknown) => void;
    }) => {
      dnd.onDragEnd = onDragEnd;
      return <>{children}</>;
    },
  };
});

const projectId = '11111111-1111-4111-8111-111111111111';
const otherProjectId = '22222222-2222-4222-8222-222222222222';
const todoTaskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherTaskId = '88888888-8888-4888-8888-888888888888';
const ALERT_TEXT = 'Could not change the task status. Try again.';

function task(id: string, title: string, status: Task['status'], taskProjectId = projectId): Task {
  return {
    id,
    title,
    status,
    priority: 'medium',
    projectId: taskProjectId,
    actorType: 'human',
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z',
  };
}

function renderBoard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (id: string, ws: string, proj: string) => (
    <QueryClientProvider client={queryClient}>
      <KanbanBoard projectId={id} wsSlug={ws} projSlug={proj} />
    </QueryClientProvider>
  );
  const view = render(tree(projectId, 'workspace', 'project'));
  return {
    rerenderBoard: (id: string, ws: string, proj: string) => view.rerender(tree(id, ws, proj)),
  };
}

async function dropTodoOnColumn(taskId: string, column: string) {
  await act(async () => {
    dnd.onDragEnd?.({ active: { id: taskId }, over: { id: column } });
  });
}

beforeEach(() => {
  dnd.onDragEnd = null;
  api.patch.mockReset();
  api.get.mockReset().mockImplementation(async (url: string) => {
    const requested = new URL(url, 'http://muneral.test').searchParams.get('projectId');
    const items =
      requested === otherProjectId
        ? [task(otherTaskId, 'Other project task', 'todo', otherProjectId)]
        : [task(todoTaskId, 'First todo', 'todo')];
    return { data: { items, total: items.length, limit: 50, offset: 0 } };
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Kanban status-change error feedback', () => {
  it('(a) shows a status error scoped to the current project visit when a status change fails', async () => {
    api.patch.mockRejectedValue(new Error('server detail that must not be shown'));
    renderBoard();
    await screen.findByRole('link', { name: 'First todo' });

    await dropTodoOnColumn(todoTaskId, 'in_progress');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(ALERT_TEXT);
    expect(alert).not.toHaveTextContent('server detail that must not be shown');
    expect(api.patch).toHaveBeenCalledWith(`/tasks/${todoTaskId}/status`, { status: 'in_progress' });
  });

  it('(b) clears a visible status error when the project changes', async () => {
    api.patch.mockRejectedValue(new Error('boom'));
    const view = renderBoard();
    await screen.findByRole('link', { name: 'First todo' });
    await dropTodoOnColumn(todoTaskId, 'in_progress');
    expect(await screen.findByRole('alert')).toHaveTextContent(ALERT_TEXT);

    view.rerenderBoard(otherProjectId, 'other-workspace', 'other-project');
    await screen.findByRole('link', { name: 'Other project task' });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('(c) suppresses a late status error that arrives after the project changed', async () => {
    let rejectPatch: ((reason: Error) => void) | undefined;
    api.patch.mockImplementation(
      () => new Promise((_resolve, reject) => {
        rejectPatch = reject;
      }),
    );
    const view = renderBoard();
    await screen.findByRole('link', { name: 'First todo' });
    await dropTodoOnColumn(todoTaskId, 'in_progress');
    expect(rejectPatch).toBeDefined();

    view.rerenderBoard(otherProjectId, 'other-workspace', 'other-project');
    await screen.findByRole('link', { name: 'Other project task' });

    await act(async () => rejectPatch?.(new Error('late failure')));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
