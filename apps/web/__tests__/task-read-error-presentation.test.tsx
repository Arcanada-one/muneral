import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskDependencies } from '@/components/task/TaskDependencies';
import { BlockersList } from '@/components/dashboard/BlockersList';

const queries = vi.hoisted(() => ({
  dependencies: { data: undefined as unknown, isLoading: false, isError: false },
  tasks: { data: undefined as unknown, isLoading: false, isError: false },
}));

vi.mock('@/lib/api/tasks', () => ({
  useDependencies: () => queries.dependencies,
  useTasks: () => queries.tasks,
}));

const edge = {
  id: 'synthetic-edge', type: 'blocks',
  fromTaskId: 'synthetic-root', toTaskId: 'synthetic-other',
};
const task = { id: 'synthetic-task', title: 'Synthetic blocker', dueDate: null };
const blockers = () => render(
  <BlockersList projectId="synthetic-project" wsSlug="synthetic-ws" projSlug="synthetic-project" />,
);

beforeEach(() => {
  queries.dependencies = { data: undefined, isLoading: false, isError: false };
  queries.tasks = { data: undefined, isLoading: false, isError: false };
});
afterEach(cleanup);

describe('task read error presentation', () => {
  it('shows unavailable dependencies for a denied read', () => {
    queries.dependencies.isError = true;
    render(<TaskDependencies taskId="synthetic-root" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Dependencies are unavailable');
  });

  it('suppresses cached dependency rows when a later read fails', () => {
    queries.dependencies = { data: [edge], isLoading: false, isError: true };
    render(<TaskDependencies taskId="synthetic-root" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Dependencies are unavailable');
    expect(screen.queryByText('Blocks')).not.toBeInTheDocument();
    expect(screen.queryByText('syntheti')).not.toBeInTheDocument();
  });

  it('preserves a successful populated dependency list', () => {
    queries.dependencies.data = [edge];
    render(<TaskDependencies taskId="synthetic-root" />);
    expect(screen.getByText('Dependencies')).toBeInTheDocument();
    expect(screen.getByText('Blocks')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps successful empty dependencies distinct from errors', () => {
    queries.dependencies.data = [];
    const { container } = render(<TaskDependencies taskId="synthetic-root" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('does not render empty-success wording for a denied blockers read', () => {
    queries.tasks.isError = true;
    blockers();
    expect(screen.getByRole('alert')).toHaveTextContent('Blockers are unavailable');
    expect(screen.queryByText(/No blockers/)).not.toBeInTheDocument();
  });

  it('suppresses cached blocker rows and counts when a later read fails', () => {
    queries.tasks = { data: { data: [task] }, isLoading: false, isError: true };
    blockers();
    expect(screen.getByRole('alert')).toHaveTextContent('Blockers are unavailable');
    expect(screen.queryByText('Synthetic blocker')).not.toBeInTheDocument();
    expect(screen.queryByText('1')).not.toBeInTheDocument();
  });

  it('distinguishes loading blockers from a successful empty response', () => {
    queries.tasks.isLoading = true;
    blockers();
    expect(screen.getByText('Loading blockers...')).toBeInTheDocument();
    expect(screen.queryByText(/No blockers/)).not.toBeInTheDocument();
  });

  it('preserves successful empty blockers wording', () => {
    queries.tasks.data = { data: [] };
    blockers();
    expect(screen.getByText(/No blockers/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('preserves a successful populated blockers list', () => {
    queries.tasks.data = { data: [task] };
    blockers();
    expect(screen.getByText('Synthetic blocker')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
