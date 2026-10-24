import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectPage from './page';

const fixtures = vi.hoisted(() => ({
  dueDate: '2026-10-08',
  setCurrentProject: vi.fn(),
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
  useTasks: () => ({
    data: {
      data: [{
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Calendar-date task',
        status: 'todo',
        priority: 'medium',
        dueDate: fixtures.dueDate,
      }],
    },
  }),
}));

vi.mock('@/store/project', () => ({
  useProjectStore: () => ({ setCurrentProject: fixtures.setCurrentProject }),
}));

vi.mock('@/components/kanban/KanbanBoard', () => ({ KanbanBoard: () => null }));
vi.mock('@/components/project/ProjectRepository', () => ({ ProjectRepository: () => null }));

let previousTimeZone: string | undefined;

beforeEach(() => {
  previousTimeZone = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  fixtures.dueDate = '2026-10-08';
});

afterEach(() => {
  cleanup();
  if (previousTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = previousTimeZone;
  vi.clearAllMocks();
});

async function dueCellText() {
  await userEvent.click(screen.getByRole('tab', { name: 'Backlog (1)' }));
  const taskLink = screen.getByRole('link', { name: 'Calendar-date task' });
  return taskLink.closest('tr')?.querySelector('td:nth-child(4)')?.textContent;
}

describe('project backlog due date', () => {
  it('keeps a date-only API value on the same calendar day west of UTC', async () => {
    render(<ProjectPage />);

    const expected = new Date('2026-10-08T00:00:00.000Z').toLocaleDateString(undefined, {
      timeZone: 'UTC',
    });
    expect(await dueCellText()).toBe(expected);
  });

  it('keeps timestamp values on their existing local calendar day', async () => {
    const timestamp = '2026-10-08T00:30:00.000Z';
    fixtures.dueDate = timestamp;
    render(<ProjectPage />);

    expect(await dueCellText()).toBe(new Date(timestamp).toLocaleDateString());
  });
});
