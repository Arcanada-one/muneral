import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readTask } from '@/lib/api/read-contract';
import { TaskDetail } from './TaskDetail';

const state = vi.hoisted(() => ({ patch: vi.fn() }));

vi.mock('@/lib/api/client', () => ({ default: { patch: state.patch } }));
vi.mock('./TaskChecklist', () => ({ TaskChecklist: () => null }));
vi.mock('./TaskDependencies', () => ({ TaskDependencies: () => null }));
vi.mock('./AuditLog', () => ({ AuditLog: () => null }));
vi.mock('./TaskGitRefs', () => ({ TaskGitRefs: () => null }));

const taskId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const parentId = '33333333-3333-4333-8333-333333333333';

const baseTask = {
  id: taskId,
  title: 'Child task',
  status: 'todo',
  priority: 'medium',
  projectId,
  actorType: 'human',
  createdAt: '2026-10-24T05:00:00.000Z',
  updatedAt: '2026-10-24T05:00:00.000Z',
};

afterEach(() => {
  cleanup();
  state.patch.mockReset();
});

function renderTask(value: unknown) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TaskDetail task={readTask(value)} />
    </QueryClientProvider>,
  );
}

describe('TaskDetail parent reference', () => {
  it('shows the parent task reference returned by the existing task read', () => {
    renderTask({ ...baseTask, parentId });

    expect(
      screen.getByText((_, node) => node?.textContent === `Parent task: ${parentId}`),
    ).toBeInTheDocument();
  });

  it('does not show a parent section for a root task', () => {
    renderTask({ ...baseTask, parentId: null });

    expect(screen.queryByText('Parent task')).not.toBeInTheDocument();
  });
});
