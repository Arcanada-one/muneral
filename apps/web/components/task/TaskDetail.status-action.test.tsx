import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TASK_STATUSES, TASK_TRANSITIONS, type TaskStatus } from '@muneral/types';
import type { Task } from '@/lib/api/tasks';
import { TaskDetail } from './TaskDetail';

const state = vi.hoisted(() => ({
  patch: vi.fn(),
}));

vi.mock('@/lib/api/client', () => ({ default: { patch: state.patch } }));
vi.mock('./TaskChecklist', () => ({ TaskChecklist: () => null }));
vi.mock('./TaskDependencies', () => ({ TaskDependencies: () => null }));
vi.mock('./AuditLog', () => ({ AuditLog: () => null }));
vi.mock('./TaskGitRefs', () => ({ TaskGitRefs: () => null }));

const task: Task = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Status transition task',
  status: 'todo',
  priority: 'medium',
  projectId: '22222222-2222-4222-8222-222222222222',
  actorType: 'human',
  createdAt: '2026-10-24T05:00:00.000Z',
  updatedAt: '2026-10-24T05:00:00.000Z',
};
const queryClients: QueryClient[] = [];

const statusLabels: Record<TaskStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
  archived: 'Archived',
};

beforeEach(() => {
  state.patch.mockReset();
});

afterEach(() => {
  cleanup();
  queryClients.splice(0).forEach((queryClient) => queryClient.clear());
});

function renderTaskDetail(value: Task, onReloadCurrentTask?: () => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClients.push(queryClient);
  const result = render(
    <QueryClientProvider client={queryClient}>
      <TaskDetail task={value} onReloadCurrentTask={onReloadCurrentTask} />
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

describe('TaskDetail status action', () => {
  it.each(TASK_STATUSES)(
    'offers only the shared allowed targets from %s',
    (status) => {
      renderTaskDetail({ ...task, status });

      const control = screen.getByRole('combobox', { name: 'Change task status' });
      const options = Array.from((control as HTMLSelectElement).options).map((option) => option.value);
      expect(options).toEqual([status, ...TASK_TRANSITIONS[status]]);
      expect((control as HTMLSelectElement).options[0]?.textContent).toBe(
        `Current: ${statusLabels[status]}`,
      );
    },
  );

  it('shows the source-shaped missing action on task detail', () => {
    renderTaskDetail(task);

    expect(screen.getByRole('combobox', { name: 'Change task status' })).toBeInTheDocument();
    expect(screen.getByText('To Do')).toBeInTheDocument();
  });

  it('submits only the selected target to the existing PATCH and invalidates task queries', async () => {
    const updatedTask = { ...task, status: 'in_progress' as const };
    state.patch.mockResolvedValue({ data: updatedTask });
    const { queryClient } = renderTaskDetail(task);
    queryClient.setQueryData(['tasks', task.id], task);
    queryClient.setQueryData(['tasks', 'project'], [task]);

    fireEvent.change(screen.getByRole('combobox', { name: 'Change task status' }), {
      target: { value: 'in_progress' },
    });

    await screen.findByText('Updating status…');
    await vi.waitFor(() => expect(state.patch).toHaveBeenCalledWith(
      `/tasks/${task.id}/status`,
      { status: 'in_progress' },
    ));
    await vi.waitFor(() => expect(screen.getByRole('combobox', { name: 'Change task status' })).toHaveValue('in_progress'));
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.queryByText('Updating status…')).not.toBeInTheDocument();
    expect(queryClient.getQueryState(['tasks', task.id])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['tasks', 'project'])?.isInvalidated).toBe(true);
    expect(state.patch.mock.calls[0]?.[1]).not.toHaveProperty('from');
  });

  it('disables the control while pending and prevents a duplicate request', async () => {
    state.patch.mockReturnValue(new Promise(() => {}));
    renderTaskDetail(task);
    const control = screen.getByRole('combobox', { name: 'Change task status' });

    fireEvent.change(control, { target: { value: 'in_progress' } });
    expect(control).toBeDisabled();
    expect(screen.getByText('Updating status…')).toBeInTheDocument();
    fireEvent.change(control, { target: { value: 'cancelled' } });
    await vi.waitFor(() => expect(state.patch).toHaveBeenCalledTimes(1));
  });

  it('shows a generic failure and leaves the displayed status at its last confirmed value', async () => {
    state.patch.mockRejectedValue(new Error('private server response detail'));
    renderTaskDetail(task);

    fireEvent.change(screen.getByRole('combobox', { name: 'Change task status' }), {
      target: { value: 'in_progress' },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not update status. Reload the task to confirm its current status before trying again.',
    );
    expect(screen.queryByText('private server response detail')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Change task status' })).toHaveValue('todo');
  });

  it('offers a user-triggered read action after a rejected PATCH without resending it', async () => {
    state.patch.mockRejectedValue(new Error('private server response detail'));
    const reload = vi.fn();
    renderTaskDetail(task, reload);

    fireEvent.change(screen.getByRole('combobox', { name: 'Change task status' }), {
      target: { value: 'in_progress' },
    });
    expect(await screen.findByRole('button', { name: 'Reload task' })).toBeInTheDocument();
    expect(state.patch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reload task' }));

    expect(reload).toHaveBeenCalledTimes(1);
    expect(state.patch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not update status. Reload the task to confirm its current status before trying again.',
    );
  });

  it('does not carry a late error from one task visit into another task', async () => {
    let rejectRequest: ((reason: Error) => void) | undefined;
    state.patch.mockReturnValue(new Promise((_resolve, reject) => { rejectRequest = reject; }));
    const { rerender, queryClient } = renderTaskDetail(task);

    fireEvent.change(screen.getByRole('combobox', { name: 'Change task status' }), {
      target: { value: 'in_progress' },
    });
    const otherTask = { ...task, id: '33333333-3333-4333-8333-333333333333', status: 'review' as const };
    rerender(
      <QueryClientProvider client={queryClient}>
        <TaskDetail task={otherTask} />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Change task status' })).toHaveValue('review');

    await act(async () => {
      rejectRequest?.(new Error('private server response detail'));
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Change task status' })).toHaveValue('review');
  });

  it('does not carry a late success into another task visit', async () => {
    let resolveRequest: ((response: { data: Task }) => void) | undefined;
    state.patch.mockReturnValue(new Promise((resolve) => { resolveRequest = resolve; }));
    const { rerender, queryClient } = renderTaskDetail(task);

    fireEvent.change(screen.getByRole('combobox', { name: 'Change task status' }), {
      target: { value: 'in_progress' },
    });
    await vi.waitFor(() => expect(state.patch).toHaveBeenCalledTimes(1));
    const otherTask = { ...task, id: '33333333-3333-4333-8333-333333333333', status: 'review' as const };
    rerender(
      <QueryClientProvider client={queryClient}>
        <TaskDetail task={otherTask} />
      </QueryClientProvider>,
    );

    await act(async () => {
      resolveRequest?.({ data: { ...task, status: 'in_progress' } });
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Change task status' })).toHaveValue('review');
  });

  it('resets prior error feedback when the same task status changes externally', async () => {
    state.patch.mockRejectedValue(new Error('private server response detail'));
    const { rerender, queryClient } = renderTaskDetail(task);

    fireEvent.change(screen.getByRole('combobox', { name: 'Change task status' }), {
      target: { value: 'in_progress' },
    });
    await screen.findByRole('alert');
    const refreshedTask = { ...task, status: 'in_progress' as const, updatedAt: '2026-10-24T05:01:00.000Z' };
    rerender(
      <QueryClientProvider client={queryClient}>
        <TaskDetail task={refreshedTask} />
      </QueryClientProvider>,
    );

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Change task status' })).toHaveValue('in_progress');
  });

  it('confirms the current transition graph has a target for every supported status', () => {
    expect(TASK_STATUSES.every((status) => TASK_TRANSITIONS[status].length > 0)).toBe(true);
  });
});
