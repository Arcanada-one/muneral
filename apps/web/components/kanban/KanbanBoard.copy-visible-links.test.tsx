import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@/lib/api/tasks';
import { KanbanBoard } from './KanbanBoard';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ default: api }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null }) }));
vi.mock('@/lib/ws/kanban', () => ({
  createKanbanWsClient: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
}));

const projectId = '11111111-1111-4111-8111-111111111111';
const otherProjectId = '22222222-2222-4222-8222-222222222222';
const taskIds = {
  firstTodo: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  duplicateTodo: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  inProgress: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  review: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  done: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  hiddenBlocked: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  hiddenArchived: '99999999-9999-4999-8999-999999999999',
  otherProject: '88888888-8888-4888-8888-888888888888',
};

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function task(
  id: string,
  title: string,
  status: Task['status'],
  taskProjectId = projectId,
): Task {
  return {
    id,
    title,
    status,
    priority: 'medium',
    projectId: taskProjectId,
    actorType: 'human',
    createdAt: '2026-10-27T00:00:00.000Z',
    updatedAt: '2026-10-27T00:00:00.000Z',
  };
}

const visibleTasks = [
  task(taskIds.review, 'Review task', 'review'),
  task(taskIds.firstTodo, 'First todo', 'todo'),
  task(taskIds.duplicateTodo, 'Duplicate first occurrence', 'todo'),
  task(taskIds.firstTodo, 'Duplicate later occurrence in another column', 'review'),
  task(taskIds.inProgress, 'In progress task', 'in_progress'),
  task(taskIds.done, 'Done task', 'done'),
  task(taskIds.hiddenBlocked, 'Blocked task is not on this board', 'blocked'),
  task(taskIds.hiddenArchived, 'Archived task is not on this board', 'archived'),
];

function page(items: Task[]) {
  return { items, total: items.length, limit: 50, offset: 0 };
}

function renderBoard(currentProjectId = projectId, wsSlug = 'workspace', projSlug = 'project') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const renderForProject = (nextProjectId: string, nextWsSlug: string, nextProjSlug: string) => (
    <QueryClientProvider client={queryClient}>
      <KanbanBoard projectId={nextProjectId} wsSlug={nextWsSlug} projSlug={nextProjSlug} />
    </QueryClientProvider>
  );
  const view = render(renderForProject(currentProjectId, wsSlug, projSlug));
  return {
    ...view,
    queryClient,
    rerenderBoard: (nextProjectId: string, nextWsSlug: string, nextProjSlug: string) =>
      view.rerender(renderForProject(nextProjectId, nextWsSlug, nextProjSlug)),
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
  api.get.mockReset().mockImplementation(async (url: string) => {
    const requestedProjectId = new URL(url, 'http://muneral.test').searchParams.get('projectId');
    return {
      data: page(requestedProjectId === otherProjectId
        ? [task(taskIds.otherProject, 'Other project task', 'todo', otherProjectId)]
        : visibleTasks),
    };
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

describe('visible task link copying', () => {
  it('copies canonical links in rendered column/card order, keeping the first duplicate and excluding hidden statuses', async () => {
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    renderBoard();

    const copyButton = await screen.findByRole('button', { name: 'Copy visible task links' });
    expect(await screen.findByRole('link', { name: 'First todo' })).toHaveAttribute(
      'href',
      `/workspaces/workspace/projects/project/tasks/${taskIds.firstTodo}`,
    );
    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith([
      `http://localhost:3000/workspaces/workspace/projects/project/tasks/${taskIds.firstTodo}`,
      `http://localhost:3000/workspaces/workspace/projects/project/tasks/${taskIds.duplicateTodo}`,
      `http://localhost:3000/workspaces/workspace/projects/project/tasks/${taskIds.inProgress}`,
      `http://localhost:3000/workspaces/workspace/projects/project/tasks/${taskIds.review}`,
      `http://localhost:3000/workspaces/workspace/projects/project/tasks/${taskIds.done}`,
    ].join('\n'));
    expect(await screen.findByText('Task links copied.')).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('link', { name: 'Blocked task is not on this board' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Archived task is not on this board' })).not.toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('disables copying and explains why when no task cards are visible', async () => {
    api.get.mockResolvedValueOnce({ data: page([]) });
    renderBoard();

    const copyButton = await screen.findByRole('button', { name: 'Copy visible task links' });
    expect(copyButton).toBeDisabled();
    expect(copyButton).toHaveAccessibleDescription('There are no visible task cards to copy.');
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('does not report success when clipboard access is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    renderBoard();

    await screen.findByRole('link', { name: 'First todo' });
    fireEvent.click(await screen.findByRole('button', { name: 'Copy visible task links' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not copy task links. Try again or copy a task link manually.',
    );
    expect(screen.queryByText('Task links copied.')).not.toBeInTheDocument();
  });

  it('reports clipboard rejection without exposing browser error details', async () => {
    installClipboard(vi.fn().mockRejectedValue(new Error('browser permission detail')));
    renderBoard();

    await screen.findByRole('link', { name: 'First todo' });
    fireEvent.click(await screen.findByRole('button', { name: 'Copy visible task links' }));

    const failure = await screen.findByRole('alert');
    expect(failure).toHaveTextContent('Could not copy task links. Try again or copy a task link manually.');
    expect(failure).not.toHaveTextContent('browser permission detail');
    expect(screen.queryByText('Task links copied.')).not.toBeInTheDocument();
  });

  it('guards duplicate clicks and suppresses an old clipboard completion after switching projects', async () => {
    let finishCopy: (() => void) | undefined;
    const writeText = installClipboard(vi.fn(() => new Promise<void>((resolve) => {
      finishCopy = resolve;
    })));
    const view = renderBoard();

    await screen.findByRole('link', { name: 'First todo' });
    const copyButton = await screen.findByRole('button', { name: 'Copy visible task links' });
    fireEvent.click(copyButton);
    expect(copyButton).toBeDisabled();
    fireEvent.click(copyButton);
    expect(writeText).toHaveBeenCalledTimes(1);

    view.rerenderBoard(otherProjectId, 'other-workspace', 'other-project');
    expect(await screen.findByRole('link', { name: 'Other project task' })).toHaveAttribute(
      'href',
      `/workspaces/other-workspace/projects/other-project/tasks/${taskIds.otherProject}`,
    );
    expect(screen.getByRole('button', { name: 'Copy visible task links' })).toBeEnabled();

    await act(async () => finishCopy?.());
    expect(screen.queryByText('Task links copied.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
