import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import apiClient from '@/lib/api/client';
import { TaskReadiness } from './TaskReadiness';

vi.mock('./TaskChecklist', () => ({ TaskChecklist: () => null }));
vi.mock('./TaskDependencies', () => ({ TaskDependencies: () => null }));
vi.mock('./AuditLog', () => ({ AuditLog: () => null }));
vi.mock('./TaskGitRefs', () => ({ TaskGitRefs: () => null }));

const taskId = '11111111-1111-4111-8111-111111111111';
const otherTaskId = '22222222-2222-4222-8222-222222222222';
const secondTaskId = '99999999-9999-4999-8999-999999999999';
const thirdTaskId = '33333333-3333-4333-8333-333333333333';
const edgeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secondEdgeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const thirdEdgeId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const duplicateEdgeId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const queryClients: QueryClient[] = [];
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function renderReadiness(id = taskId) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClients.push(queryClient);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TaskReadiness taskId={id} />
    </QueryClientProvider>,
  );
  return {
    ...view,
    queryClient,
    rerenderTask: (nextId: string) => view.rerender(
      <QueryClientProvider client={queryClient}>
        <TaskReadiness taskId={nextId} />
      </QueryClientProvider>,
    ),
  };
}

function readiness(overrides: Record<string, unknown> = {}) {
  return { taskId, dependencyCount: 0, blockedBy: [], ready: true, ...overrides };
}

function blocker(overrides: Record<string, unknown> = {}) {
  return {
    id: edgeId,
    type: 'depends_on',
    direction: 'outgoing',
    fromTaskId: taskId,
    toTaskId: otherTaskId,
    otherTaskId,
    otherTaskTitle: 'Release prerequisite',
    otherTaskStatus: 'in_progress',
    ...overrides,
  };
}

function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

afterEach(() => {
  cleanup();
  queryClients.splice(0).forEach((queryClient) => queryClient.clear());
  vi.restoreAllMocks();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

describe('TaskReadiness local search over loaded blockers', () => {
  it('trims and case-insensitively matches title and task ID only', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness({
        ready: false,
        dependencyCount: 2,
        blockedBy: [
          blocker(),
          blocker({
            id: secondEdgeId,
            toTaskId: secondTaskId,
            otherTaskId: secondTaskId,
            otherTaskTitle: 'Database Migration Gate',
            otherTaskStatus: 'todo',
          }),
        ],
      }),
    } as never);

    renderReadiness();
    expect(await screen.findByText('Release prerequisite')).toBeInTheDocument();
    expect(screen.getByText('Database Migration Gate')).toBeInTheDocument();
    expect(screen.getByText('Showing 2 of 2 loaded blocking dependencies.')).toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('Search loaded blockers'), {
      target: { value: '  MiGrAtIoN  ' },
    });
    expect(screen.queryByText('Release prerequisite')).not.toBeInTheDocument();
    expect(screen.getByText('Database Migration Gate')).toBeInTheDocument();
    expect(screen.getByText('Showing 1 of 2 loaded blocking dependencies.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search loaded blockers'), {
      target: { value: secondTaskId.toUpperCase() },
    });
    expect(screen.getByText('Database Migration Gate')).toBeInTheDocument();
    expect(screen.queryByText('Release prerequisite')).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('does not match status labels or withheld raw titles', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness({
        ready: false,
        dependencyCount: 2,
        blockedBy: [
          blocker({ otherTaskStatus: 'todo' }),
          blocker({
            id: secondEdgeId,
            toTaskId: secondTaskId,
            otherTaskId: secondTaskId,
            otherTaskTitle: 'Secret withheld title',
            otherTaskTitleWithheld: true,
            otherTaskStatus: 'in_progress',
          }),
        ],
      }),
    } as never);

    renderReadiness();
    expect(await screen.findByText('Release prerequisite')).toBeInTheDocument();
    expect(screen.getByText(secondTaskId)).toBeInTheDocument();
    expect(screen.queryByText('Secret withheld title')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search loaded blockers'), {
      target: { value: 'To Do' },
    });
    expect(screen.getByText('No matching readiness blockers in the loaded list. Clear search to show more.')).toBeInTheDocument();
    expect(screen.queryByText('Release prerequisite')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search loaded blockers'), {
      target: { value: 'Secret withheld title' },
    });
    expect(screen.getByText('No matching readiness blockers in the loaded list. Clear search to show more.')).toBeInTheDocument();
    expect(screen.queryByText(secondTaskId)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search loaded blockers'), {
      target: { value: secondTaskId },
    });
    expect(screen.getByText(secondTaskId)).toBeInTheDocument();
    expect(screen.queryByText('Secret withheld title')).not.toBeInTheDocument();
  });

  it('preserves loaded order and duplicate edges while filtering', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness({
        ready: false,
        dependencyCount: 4,
        blockedBy: [
          blocker({ otherTaskTitle: 'Alpha gate' }),
          blocker({
            id: secondEdgeId,
            toTaskId: secondTaskId,
            otherTaskId: secondTaskId,
            otherTaskTitle: 'Beta gate',
          }),
          blocker({
            id: duplicateEdgeId,
            otherTaskTitle: 'Alpha gate again',
          }),
          blocker({
            id: thirdEdgeId,
            toTaskId: thirdTaskId,
            otherTaskId: thirdTaskId,
            otherTaskTitle: 'Gamma gate',
          }),
        ],
      }),
    } as never);

    renderReadiness();
    await screen.findByText('Alpha gate');

    fireEvent.change(screen.getByLabelText('Search loaded blockers'), {
      target: { value: otherTaskId },
    });

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Alpha gate');
    expect(items[1]).toHaveTextContent('Alpha gate again');
    expect(screen.getByText('Showing 2 of 4 loaded blocking dependencies.')).toBeInTheDocument();
  });

  it('clears search accessibly and keeps disclosure meaningful', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(search).toHaveValue('');
    expect(await screen.findByText('Release prerequisite')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'Release' } });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: 'Hide blocking tasks' }));
    expect(screen.getByText('Release prerequisite')).not.toBeVisible();
    expect(search).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Show blocking tasks' }));
    expect(screen.getByText('Release prerequisite')).toBeVisible();
  });

  it('persists the query across same-task readiness refresh and resets on task switch', async () => {
    const get = vi.spyOn(apiClient, 'get');
    get.mockResolvedValueOnce({
      data: readiness({
        ready: false,
        dependencyCount: 1,
        blockedBy: [blocker()],
      }),
    } as never);

    const { queryClient, rerenderTask } = renderReadiness();
    const search = await screen.findByLabelText('Search loaded blockers');
    fireEvent.change(search, { target: { value: 'Release' } });
    expect(search).toHaveValue('Release');

    get.mockResolvedValueOnce({
      data: readiness({
        ready: false,
        dependencyCount: 2,
        blockedBy: [
          blocker(),
          blocker({
            id: secondEdgeId,
            toTaskId: secondTaskId,
            otherTaskId: secondTaskId,
            otherTaskTitle: 'Other current blocker',
          }),
        ],
      }),
    } as never);

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['tasks', taskId, 'readiness'] });
    });
    expect(await screen.findByText('Showing 1 of 2 loaded blocking dependencies.')).toBeInTheDocument();
    expect(screen.getByLabelText('Search loaded blockers')).toHaveValue('Release');
    expect(screen.getByText('Release prerequisite')).toBeInTheDocument();
    expect(screen.queryByText('Other current blocker')).not.toBeInTheDocument();

    const nextTaskId = '44444444-4444-4444-8444-444444444444';
    get.mockResolvedValueOnce({
      data: readiness({
        taskId: nextTaskId,
        ready: false,
        dependencyCount: 1,
        blockedBy: [blocker({
          fromTaskId: nextTaskId,
          otherTaskTitle: 'Next task blocker',
        })],
      }),
    } as never);
    rerenderTask(nextTaskId);
    expect(await screen.findByText('Next task blocker')).toBeInTheDocument();
    expect(screen.getByLabelText('Search loaded blockers')).toHaveValue('');
  });

  it('copies the complete loaded unique ID batch regardless of search and disclosure', async () => {
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness({
        ready: false,
        dependencyCount: 3,
        blockedBy: [
          blocker(),
          blocker({
            id: duplicateEdgeId,
            otherTaskTitle: 'Duplicate edge same id',
          }),
          blocker({
            id: secondEdgeId,
            toTaskId: secondTaskId,
            otherTaskId: secondTaskId,
            otherTaskTitle: 'Second blocker',
          }),
        ],
      }),
    } as never);

    renderReadiness();
    await screen.findByText('Release prerequisite');
    fireEvent.change(screen.getByLabelText('Search loaded blockers'), {
      target: { value: 'Second' },
    });
    expect(screen.queryByText('Release prerequisite')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide blocking tasks' }));

    fireEvent.click(screen.getByRole('button', { name: 'Copy loaded blocker IDs' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(`${otherTaskId}\n${secondTaskId}`);
  });

  it('copies per-row IDs only for rendered rows and does not fetch on search or clear', async () => {
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    const get = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness({
        ready: false,
        dependencyCount: 2,
        blockedBy: [
          blocker(),
          blocker({
            id: secondEdgeId,
            toTaskId: secondTaskId,
            otherTaskId: secondTaskId,
            otherTaskTitle: 'Second blocker',
          }),
        ],
      }),
    } as never);

    renderReadiness();
    await screen.findByText('Release prerequisite');
    fireEvent.change(screen.getByLabelText('Search loaded blockers'), {
      target: { value: 'Second' },
    });
    expect(screen.queryByRole('button', { name: `Copy blocker task ID ${otherTaskId}` })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `Copy blocker task ID ${secondTaskId}` }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(secondTaskId));

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(get).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('does not render search or batch copy controls outside nonempty blocked readiness', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness({ dependencyCount: 2 }),
    } as never);

    renderReadiness();
    expect(await screen.findByText('Ready: no blocking dependencies among 2 dependency links.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Search loaded blockers')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy loaded blocker IDs' })).not.toBeInTheDocument();
  });
});
