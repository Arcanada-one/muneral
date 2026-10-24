import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectPage from './page';

const fixtures = vi.hoisted(() => ({
  projectQuery: {
    data: undefined as unknown,
    isLoading: false,
    isError: true,
  },
  setCurrentProject: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ wsSlug: 'workspace', projSlug: 'project' }),
}));

vi.mock('@/lib/api/projects', () => ({
  useProject: () => fixtures.projectQuery,
}));

vi.mock('@/lib/api/tasks', () => ({
  useTasks: () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
}));

vi.mock('@/store/project', () => ({
  useProjectStore: () => ({ setCurrentProject: fixtures.setCurrentProject }),
}));

vi.mock('@/components/kanban/KanbanBoard', () => ({ KanbanBoard: () => null }));
vi.mock('@/components/project/ProjectRepository', () => ({ ProjectRepository: () => null }));

beforeEach(() => {
  fixtures.projectQuery = { data: undefined, isLoading: false, isError: true };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('project read failure feedback', () => {
  it('shows an unavailable alert after the project query fails instead of loading forever', () => {
    render(<ProjectPage />);

    expect(screen.getByRole('alert')).toHaveTextContent(/project.*unavailable/i);
    expect(screen.queryByText('Loading project...')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Example project' })).not.toBeInTheDocument();
  });

  it('keeps the loading state while the project query is pending', () => {
    fixtures.projectQuery = { data: undefined, isLoading: true, isError: false };
    render(<ProjectPage />);

    expect(screen.getByText('Loading project...')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
