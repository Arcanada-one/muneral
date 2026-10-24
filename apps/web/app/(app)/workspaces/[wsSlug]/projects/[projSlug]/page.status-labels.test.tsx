import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProjectPage from './page';

const fixtures = vi.hoisted(() => ({
  setCurrentProject: vi.fn(),
  tasks: [
    { id: 'task-todo', title: 'Task todo', status: 'todo', priority: 'medium' },
    { id: 'task-in-progress', title: 'Task in progress', status: 'in_progress', priority: 'medium' },
    { id: 'task-review', title: 'Task review', status: 'review', priority: 'medium' },
    { id: 'task-blocked', title: 'Task blocked', status: 'blocked', priority: 'medium' },
    { id: 'task-done', title: 'Task done', status: 'done', priority: 'medium' },
    { id: 'task-cancelled', title: 'Task cancelled', status: 'cancelled', priority: 'medium' },
    { id: 'task-archived', title: 'Task archived', status: 'archived', priority: 'medium' },
  ],
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ wsSlug: 'workspace', projSlug: 'project' }),
}));

vi.mock('@/lib/api/projects', () => ({
  useProject: () => ({
    data: {
      id: '22222222-2222-4222-8222-222222222222',
      slug: 'project',
      name: 'Example project',
      workspaceId: '33333333-3333-4333-8333-333333333333',
      repoUrl: null,
      status: 'active',
      createdAt: '2026-10-01T00:00:00.000Z',
    },
    isLoading: false,
  }),
}));

vi.mock('@/lib/api/tasks', () => ({
  useTasks: () => ({ data: { data: fixtures.tasks } }),
}));

vi.mock('@/store/project', () => ({
  useProjectStore: () => ({ setCurrentProject: fixtures.setCurrentProject }),
}));

vi.mock('@/components/kanban/KanbanBoard', () => ({ KanbanBoard: () => null }));
vi.mock('@/components/project/ProjectRepository', () => ({ ProjectRepository: () => null }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('project backlog status labels', () => {
  it('uses the shared human-readable label for every task status', async () => {
    render(<ProjectPage />);
    await userEvent.click(screen.getByRole('tab', { name: 'Backlog (7)' }));

    const cases = [
      ['todo', 'To Do'],
      ['in_progress', 'In Progress'],
      ['review', 'Review'],
      ['blocked', 'Blocked'],
      ['done', 'Done'],
      ['cancelled', 'Cancelled'],
      ['archived', 'Archived'],
    ];

    for (const [status, label] of cases) {
      const row = screen.getByRole('link', { name: `Task ${status.replace('_', ' ')}` }).closest('tr');
      expect(row).not.toBeNull();
      expect(within(row as HTMLElement).getByText(label)).toBeInTheDocument();
      expect(within(row as HTMLElement).queryByText(status)).not.toBeInTheDocument();
    }
  });
});
