import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import apiClient from '@/lib/api/client';
import { TaskReadiness } from './TaskReadiness';

vi.mock('./TaskChecklist', () => ({ TaskChecklist: () => null }));
vi.mock('./TaskDependencies', () => ({ TaskDependencies: () => null }));
vi.mock('./AuditLog', () => ({ AuditLog: () => null }));
vi.mock('./TaskGitRefs', () => ({ TaskGitRefs: () => null }));

const taskId = '11111111-1111-4111-8111-111111111111';
const firstBlockerId = '22222222-2222-4222-8222-222222222222';
const secondBlockerId = '99999999-9999-4999-8999-999999999999';
const firstEdgeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secondEdgeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const queryClients: QueryClient[] = [];

function renderReadiness() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClients.push(queryClient);
  return render(
    <QueryClientProvider client={queryClient}>
      <TaskReadiness taskId={taskId} />
    </QueryClientProvider>,
  );
}

function readiness(overrides: Record<string, unknown> = {}) {
  return { taskId, dependencyCount: 0, blockedBy: [], ready: true, ...overrides };
}

function blocker(overrides: Record<string, unknown> = {}) {
  return {
    id: firstEdgeId,
    type: 'depends_on',
    direction: 'outgoing',
    fromTaskId: taskId,
    toTaskId: firstBlockerId,
    otherTaskId: firstBlockerId,
    otherTaskTitle: 'Release prerequisite',
    otherTaskStatus: 'in_progress',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  queryClients.splice(0).forEach((queryClient) => queryClient.clear());
  vi.restoreAllMocks();
});

describe('TaskReadiness local search over loaded blockers', () => {
  it('filters already-loaded readiness blockers by title without a new request', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness({
        ready: false,
        dependencyCount: 2,
        blockedBy: [
          blocker(),
          blocker({
            id: secondEdgeId,
            toTaskId: secondBlockerId,
            otherTaskId: secondBlockerId,
            otherTaskTitle: 'Database migration gate',
            otherTaskStatus: 'todo',
          }),
        ],
      }),
    } as never);

    renderReadiness();

    expect(await screen.findByText('Release prerequisite')).toBeInTheDocument();
    expect(screen.getByText('Database migration gate')).toBeInTheDocument();
    expect(screen.getByText('Showing 2 of 2 loaded readiness blockers.')).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('Search loaded blockers'), {
      target: { value: 'migration' },
    });

    expect(screen.queryByText('Release prerequisite')).not.toBeInTheDocument();
    expect(screen.getByText('Database migration gate')).toBeInTheDocument();
    expect(screen.getByText('Showing 1 of 2 loaded readiness blockers.')).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('matches loaded blocker task IDs and status labels', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness({
        ready: false,
        dependencyCount: 2,
        blockedBy: [
          blocker(),
          blocker({
            id: secondEdgeId,
            toTaskId: secondBlockerId,
            otherTaskId: secondBlockerId,
            otherTaskTitle: 'Database migration gate',
            otherTaskStatus: 'todo',
          }),
        ],
      }),
    } as never);

    renderReadiness();
    await screen.findByText('Release prerequisite');

    fireEvent.change(screen.getByLabelText('Search loaded blockers'), {
      target: { value: secondBlockerId },
    });
    expect(screen.getByText('Database migration gate')).toBeInTheDocument();
    expect(screen.queryByText('Release prerequisite')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search loaded blockers'), {
      target: { value: 'To Do' },
    });
    expect(screen.getByText('Database migration gate')).toBeInTheDocument();
    expect(screen.queryByText('Release prerequisite')).not.toBeInTheDocument();
  });

  it('shows an empty-match state and clears search with Escape', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness({
        ready: false,
        dependencyCount: 1,
        blockedBy: [blocker()],
      }),
    } as never);

    renderReadiness();
    const search = await screen.findByLabelText('Search loaded blockers');

    fireEvent.change(search, { target: { value: 'does-not-match' } });
    expect(screen.getByText('No matching readiness blockers in the loaded list. Clear search to show more.')).toBeInTheDocument();
    expect(screen.queryByText('Release prerequisite')).not.toBeInTheDocument();

    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');
    expect(await screen.findByText('Release prerequisite')).toBeInTheDocument();
    expect(screen.getByText('Showing 1 of 1 loaded readiness blockers.')).toBeInTheDocument();
  });

  it('does not render the search control when readiness is ready', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness({ dependencyCount: 2 }),
    } as never);

    renderReadiness();
    expect(await screen.findByText('Ready: no blocking dependencies among 2 dependency links.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Search loaded blockers')).not.toBeInTheDocument();
  });
});
