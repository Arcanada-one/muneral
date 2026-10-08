import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskDependencies } from '@/components/task/TaskDependencies';
import { BlockersList } from '@/components/dashboard/BlockersList';
import { TaskDetail } from '@/components/task/TaskDetail';
import { TaskChecklist } from '@/components/task/TaskChecklist';
import { AuditLog } from '@/components/task/AuditLog';
import type { Task } from '@/lib/api/tasks';

const queries = vi.hoisted(() => ({
  dependencies: { data: undefined as unknown, isLoading: false, isError: false },
  tasks: { data: undefined as unknown, isLoading: false, isError: false },
  checklist: { data: undefined as unknown, isLoading: false, isError: false },
  activity: { data: undefined as unknown, isLoading: false, isError: false },
}));

vi.mock('@/lib/api/tasks', () => ({
  useDependencies: () => queries.dependencies,
  useTasks: () => queries.tasks,
  useChecklist: () => queries.checklist,
  useActivity: () => queries.activity,
  useToggleChecklistItem: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/components/task/TaskGitRefs', () => ({ TaskGitRefs: () => null }));

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
  queries.checklist = { data: undefined, isLoading: false, isError: false };
  queries.activity = { data: undefined, isLoading: false, isError: false };
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


describe('persisted task and additional read boundaries', () => {
  const persisted: Task = { id: 'synthetic-full-task', projectId: 'synthetic-project', title: 'Synthetic full task', status: 'todo', priority: 'medium', actorType: 'human', createdAt: '2026-10-08T00:00:00Z', updatedAt: '2026-10-08T00:00:00Z' };
  it('renders real task scalar projection without optional tags', () => {
    render(<TaskDetail task={persisted} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(persisted.title);
  });
  it('preserves decimal estimate and source date text without inventing a null actor', () => {
    render(<TaskDetail task={{ ...persisted, estimateHours: '1.25', dueDate: 'source due text', actorType: null }} />);
    expect(screen.getByText('1.25h')).toBeInTheDocument();
    expect(screen.getByText('Due source due text')).toBeInTheDocument();
    expect(screen.getByText('Actor not specified')).toBeInTheDocument();
    expect(screen.queryByText('Human task')).not.toBeInTheDocument();
  });
  it('preserves actual present tags', () => {
    render(<TaskDetail task={{ ...persisted, tags: ['Actual tag'] }} />);
    expect(screen.getByText('Actual tag')).toBeInTheDocument();
  });
  it('shows checklist read failure instead of absent checklist', () => {
    queries.checklist.isError = true; render(<TaskChecklist taskId={persisted.id} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Checklist is unavailable');
  });
  it('suppresses stale checklist labels on failed refetch', () => {
    queries.checklist = { data: [{ id: 'check', label: 'Stale label', checked: false }], isLoading: false, isError: true };
    render(<TaskChecklist taskId={persisted.id} />);
    expect(screen.queryByText('Stale label')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Checklist is unavailable');
  });
  it('preserves successful populated checklist label', () => {
    queries.checklist.data = [{ id: 'check', label: 'Real label', checked: false }];
    render(<TaskChecklist taskId={persisted.id} />); expect(screen.getByLabelText('Real label')).toBeInTheDocument();
  });
  it('shows activity failure instead of successful empty activity', () => {
    queries.activity.isError = true; render(<AuditLog taskId={persisted.id} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Activity is unavailable');
  });
  it('suppresses stale activity rows on failed refetch', () => {
    queries.activity = { data: { data: [{ id: 'entry', actorName: 'Stale actor', actorType: 'human', action: 'comment', createdAt: '2026-10-08T00:00:00Z' }] }, isLoading: false, isError: true };
    render(<AuditLog taskId={persisted.id} />); expect(screen.queryByText('Stale actor')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Activity is unavailable');
  });
  it('preserves successful populated activity action', () => {
    queries.activity.data = { data: [{ id: 'entry', actorType: 'human', action: 'comment', createdAt: '2026-10-08T00:00:00Z' }] };
    render(<AuditLog taskId={persisted.id} />); expect(screen.getByText('comment')).toBeInTheDocument();
  });
});
