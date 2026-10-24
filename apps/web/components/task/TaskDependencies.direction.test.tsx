import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import apiClient from '@/lib/api/client';
import { TaskDependencies } from './TaskDependencies';

const taskId = '11111111-1111-4111-8111-111111111111';
const otherIds = [
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555',
  '66666666-6666-4666-8666-666666666666',
  '77777777-7777-4777-8777-777777777777',
];

const graph = [
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    type: 'depends_on',
    direction: 'outgoing',
    fromTaskId: taskId,
    toTaskId: otherIds[0],
    otherTaskId: otherIds[0],
    otherTaskTitle: 'Prerequisite task',
    otherTaskStatus: 'in_progress',
  },
  {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    type: 'depends_on',
    direction: 'incoming',
    fromTaskId: otherIds[1],
    toTaskId: taskId,
    otherTaskId: otherIds[1],
    otherTaskTitle: 'Dependent task',
    otherTaskStatus: 'todo',
  },
  {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    type: 'blocks',
    direction: 'outgoing',
    fromTaskId: taskId,
    toTaskId: otherIds[2],
    otherTaskId: otherIds[2],
    otherTaskTitle: 'Blocked task',
    otherTaskStatus: 'todo',
  },
  {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    type: 'blocks',
    direction: 'incoming',
    fromTaskId: otherIds[3],
    toTaskId: taskId,
    otherTaskId: otherIds[3],
    otherTaskTitle: 'Blocking task',
    otherTaskStatus: 'in_progress',
  },
  {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    type: 'related_to',
    direction: 'incoming',
    fromTaskId: otherIds[4],
    toTaskId: taskId,
    otherTaskId: otherIds[4],
    otherTaskTitle: 'Related task',
    otherTaskStatus: 'todo',
  },
  {
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    type: 'duplicates',
    direction: 'outgoing',
    fromTaskId: taskId,
    toTaskId: otherIds[5],
    otherTaskId: otherIds[5],
    otherTaskTitle: 'Duplicate task',
    otherTaskStatus: 'todo',
  },
];

function renderDependencies() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TaskDependencies taskId={taskId} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(apiClient, 'get').mockResolvedValue({ data: graph } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('task dependency directions', () => {
  it('reads the complete graph and describes each directed relation from the current task', async () => {
    renderDependencies();

    expect(await screen.findAllByText('Depends on')).toHaveLength(1);
    expect(screen.getByText('Required by')).toBeInTheDocument();
    expect(screen.getByText('Blocks')).toBeInTheDocument();
    expect(screen.getByText('Blocked by')).toBeInTheDocument();
    expect(screen.getByText('Related to')).toBeInTheDocument();
    expect(screen.getByText('Duplicates')).toBeInTheDocument();

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith(`/tasks/${taskId}/dependency-graph`);
    });
    for (const id of otherIds) {
      expect(screen.getByText(id.slice(0, 8))).toBeInTheDocument();
    }
    expect(screen.getByText('Required by').closest('li')).toHaveTextContent(otherIds[1].slice(0, 8));
    expect(screen.getByText('Blocked by').closest('li')).toHaveTextContent(otherIds[3].slice(0, 8));
  });

  it('rejects a graph row that is not bound to the requested task', async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce({
      data: [{ ...graph[0], fromTaskId: otherIds[2], toTaskId: otherIds[3] }],
    } as never);
    renderDependencies();

    expect(await screen.findByRole('alert')).toHaveTextContent('Dependencies are unavailable');
    expect(screen.queryByText('Depends on')).not.toBeInTheDocument();
  });
});
