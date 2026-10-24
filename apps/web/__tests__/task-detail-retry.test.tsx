import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TaskPage from '@/app/(app)/workspaces/[wsSlug]/projects/[projSlug]/tasks/[taskId]/page';
import { TaskDetailSessionProvider } from '@/lib/api/task-detail-session';

const state = vi.hoisted(() => ({
  session: { data: { accessToken: 'synthetic-session' } as { accessToken: string } | null, status: 'authenticated' },
  route: { wsSlug: 'own', projSlug: 'project', taskId: '33333333-3333-4333-8333-333333333333' },
  push: vi.fn(),
  get: vi.fn(),
}));

vi.mock('next-auth/react', () => ({ useSession: () => state.session }));
vi.mock('next/navigation', () => ({ useParams: () => state.route, useRouter: () => ({ push: state.push }) }));
vi.mock('@/lib/api/client', () => ({ default: { get: state.get } }));
vi.mock('@/components/task/TaskDetail', () => ({ TaskDetail: ({ task }: { task: { title: string } }) => <h1>{task.title}</h1> }));

const workspaceId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const taskId = state.route.taskId;
const nextTaskId = '44444444-4444-4444-8444-444444444444';
const timestamp = '2026-10-08T00:00:00Z';
const workspace = { id: workspaceId, slug: 'own', name: 'Own', createdAt: timestamp };
const project = { id: projectId, workspaceId, slug: 'project', name: 'Project', createdAt: timestamp };
const task = {
  id: taskId,
  projectId,
  title: 'Recovered task',
  status: 'todo',
  priority: 'medium',
  actorType: 'human',
  createdAt: timestamp,
  updatedAt: timestamp,
};

let taskReads: number;
let taskResult: (requestedTaskId: string) => Promise<unknown>;

function httpError(status: number) {
  return new AxiosError('synthetic request failure', 'ERR_BAD_RESPONSE', undefined, undefined, {
    status,
    data: {},
    statusText: 'synthetic',
    headers: {},
    config: {} as never,
  });
}

function renderPage() {
  return render(
    <TaskDetailSessionProvider>
      <TaskPage />
    </TaskDetailSessionProvider>,
  );
}

beforeEach(() => {
  state.session = { data: { accessToken: 'synthetic-session' }, status: 'authenticated' };
  state.route = { wsSlug: 'own', projSlug: 'project', taskId };
  state.push.mockReset();
  taskReads = 0;
  taskResult = async (requestedTaskId) => ({ data: { ...task, id: requestedTaskId } });
  state.get.mockImplementation(async (url: string) => {
    if (url === '/workspaces') return { data: [workspace] };
    if (url === `/projects/workspace/${workspaceId}`) return { data: [project] };
    if (url.startsWith('/tasks/')) {
      taskReads += 1;
      return taskResult(url.slice('/tasks/'.length));
    }
    throw new Error('unexpected synthetic GET');
  });
});

afterEach(() => {
  cleanup();
});

describe('TaskPage transient read recovery', () => {
  it('lets the user retry an unavailable task read and renders the confirmed response', async () => {
    let resolveRetry: ((value: unknown) => void) | undefined;
    taskResult = async () => {
      if (taskReads <= 2) throw httpError(503);
      return new Promise((resolve) => { resolveRetry = resolve; });
    };
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Task is unavailable');
    expect(taskReads).toBe(2);
    await user.click(screen.getByRole('button', { name: 'Retry loading task' }));
    await waitFor(() => expect(taskReads).toBe(3));
    expect(screen.getByText('Loading task...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry loading task' })).not.toBeInTheDocument();

    await act(async () => resolveRetry?.({ data: { ...task, id: taskId } }));
    expect(await screen.findByRole('heading', { name: 'Recovered task' })).toBeInTheDocument();
    expect(state.push).not.toHaveBeenCalled();
  });

  it('does not publish a pending retry result after navigation to another task', async () => {
    let resolveOldRetry: ((value: unknown) => void) | undefined;
    taskResult = async (requestedTaskId) => {
      if (requestedTaskId === taskId && taskReads <= 2) throw httpError(503);
      if (requestedTaskId === taskId) {
        return new Promise((resolve) => { resolveOldRetry = resolve; });
      }
      return { data: { ...task, id: requestedTaskId, title: 'Current task' } };
    };
    const user = userEvent.setup();
    const view = renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Task is unavailable');
    await user.click(screen.getByRole('button', { name: 'Retry loading task' }));
    await waitFor(() => expect(taskReads).toBe(3));

    state.route = { ...state.route, taskId: nextTaskId };
    view.rerender(
      <TaskDetailSessionProvider>
        <TaskPage />
      </TaskDetailSessionProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Current task' })).toBeInTheDocument();

    await act(async () => resolveOldRetry?.({ data: { ...task, title: 'Old task response' } }));
    expect(screen.getByRole('heading', { name: 'Current task' })).toBeInTheDocument();
    expect(screen.queryByText('Old task response')).not.toBeInTheDocument();
  });

  it('does not publish a pending retry result after the session changes', async () => {
    let resolveOldRetry: ((value: unknown) => void) | undefined;
    taskResult = async (requestedTaskId) => {
      if (taskReads <= 2) throw httpError(503);
      if (taskReads === 3) {
        return new Promise((resolve) => { resolveOldRetry = resolve; });
      }
      return { data: { ...task, id: requestedTaskId, title: 'New session task' } };
    };
    const user = userEvent.setup();
    const view = renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Task is unavailable');
    await user.click(screen.getByRole('button', { name: 'Retry loading task' }));
    await waitFor(() => expect(taskReads).toBe(3));

    state.session = { data: { accessToken: 'synthetic-next-session' }, status: 'authenticated' };
    view.rerender(
      <TaskDetailSessionProvider>
        <TaskPage />
      </TaskDetailSessionProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'New session task' })).toBeInTheDocument();

    await act(async () => resolveOldRetry?.({ data: { ...task, title: 'Old session response' } }));
    expect(screen.getByRole('heading', { name: 'New session task' })).toBeInTheDocument();
    expect(screen.queryByText('Old session response')).not.toBeInTheDocument();
  });

  it.each([401, 403, 404])('does not offer retry for HTTP %i', async (status) => {
    taskResult = async () => { throw httpError(status); };
    renderPage();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry loading task' })).not.toBeInTheDocument();
    expect(taskReads).toBe(1);
  });
});
