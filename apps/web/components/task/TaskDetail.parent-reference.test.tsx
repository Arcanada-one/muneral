import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readTask } from '@/lib/api/read-contract';
import { useTask } from '@/lib/api/tasks';
import { TaskDetail } from './TaskDetail';

const state = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));

vi.mock('@/lib/api/client', () => ({ default: { get: state.get, patch: state.patch } }));
vi.mock('./TaskChecklist', () => ({ TaskChecklist: () => null }));
vi.mock('./TaskDependencies', () => ({ TaskDependencies: () => null }));
vi.mock('./AuditLog', () => ({ AuditLog: () => null }));
vi.mock('./TaskGitRefs', () => ({ TaskGitRefs: () => null }));

const taskId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const parentId = '33333333-3333-4333-8333-333333333333';
const otherParentId = '44444444-4444-4444-8444-444444444444';
const otherTaskId = '55555555-5555-4555-8555-555555555555';
const queryClients = new Set<QueryClient>();
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

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
  queryClients.forEach((queryClient) => queryClient.clear());
  queryClients.clear();
  onlineManager.setOnline(true);
  state.get.mockReset();
  state.patch.mockReset();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return writeText;
}

function makeQueryClient() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  queryClients.add(queryClient);
  return queryClient;
}

function renderTask(value: unknown, queryClient = makeQueryClient()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <TaskDetail task={readTask(value)} />
    </QueryClientProvider>,
  );
}

function ParentTaskProbe({ id }: { id: string }) {
  const query = useTask(id);
  return <span>{query.data?.title ?? 'Parent task unavailable'}</span>;
}

function parentText(value: string) {
  return screen.getByText((_, node) => node?.textContent === `Parent task: ${value}`);
}

describe('TaskDetail parent reference', () => {
  it('copies the full parent UUID only after a user action', () => {
    state.get.mockReturnValue(new Promise(() => undefined));
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    renderTask({ ...baseTask, parentId });

    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: `Copy parent task ID ${parentId}` }));

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(parentId);
  });

  it.each([
    ['successful title', { data: { ...baseTask, id: parentId, title: 'Parent title' } }, undefined],
    ['withheld title', undefined, 403],
    ['missing title', undefined, 404],
    ['failed title read', undefined, undefined],
  ])('copies the exact parent UUID when the title is %s', async (_label, response, status) => {
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    if (response) {
      state.get.mockResolvedValue(response);
    } else {
      const error = Object.assign(new Error('private server detail'), {
        response: status === undefined ? undefined : { status },
      });
      state.get.mockRejectedValue(error);
    }
    renderTask({ ...baseTask, parentId });

    const copyButton = await screen.findByRole('button', { name: `Copy parent task ID ${parentId}` });
    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(parentId);
    expect(screen.queryByText('private server detail')).not.toBeInTheDocument();
  });

  it('shows generic copy failure feedback without server or clipboard details', async () => {
    installClipboard(vi.fn().mockRejectedValue(new Error('private clipboard detail')));
    state.get.mockReturnValue(new Promise(() => undefined));
    renderTask({ ...baseTask, parentId });

    fireEvent.click(screen.getByRole('button', { name: `Copy parent task ID ${parentId}` }));

    const failure = await screen.findByRole('alert');
    expect(failure).toHaveTextContent('Could not copy parent task ID. Try copying it manually.');
    expect(failure).not.toHaveTextContent('private clipboard detail');
  });

  it('disables duplicate parent UUID copies while the clipboard request is pending', async () => {
    let resolveClipboard!: () => void;
    const writeText = installClipboard(vi.fn(() => new Promise<void>((resolve) => {
      resolveClipboard = resolve;
    })));
    state.get.mockReturnValue(new Promise(() => undefined));
    renderTask({ ...baseTask, parentId });
    const copyButton = screen.getByRole('button', { name: `Copy parent task ID ${parentId}` });

    fireEvent.click(copyButton);
    expect(copyButton).toBeDisabled();
    fireEvent.click(copyButton);
    expect(writeText).toHaveBeenCalledOnce();

    await act(async () => resolveClipboard());
    expect(await screen.findByRole('status')).toHaveTextContent('Parent task ID copied.');
  });

  it.each([
    ['parent ID', { ...baseTask, parentId: otherParentId }],
    ['current task ID', { ...baseTask, id: otherTaskId, parentId }],
  ])('does not show a late copy result after the %s changes', async (_label, nextTask) => {
    let resolveClipboard!: () => void;
    installClipboard(vi.fn(() => new Promise<void>((resolve) => {
      resolveClipboard = resolve;
    })));
    state.get.mockReturnValue(new Promise(() => undefined));
    const queryClient = makeQueryClient();
    const renderValue = (value: unknown) => (
      <QueryClientProvider client={queryClient}>
        <TaskDetail task={readTask(value)} />
      </QueryClientProvider>
    );
    const view = render(renderValue({ ...baseTask, parentId }));

    fireEvent.click(screen.getByRole('button', { name: `Copy parent task ID ${parentId}` }));
    view.rerender(renderValue(nextTask));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => resolveClipboard());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('uses the existing task GET/read contract for a successful parent title', async () => {
    const parentTask = { ...baseTask, id: parentId, title: 'Parent title from API' };
    state.get.mockResolvedValue({ data: parentTask });
    const queryClient = makeQueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <ParentTaskProbe id={parentId} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Parent title from API')).toBeInTheDocument();
    expect(state.get).toHaveBeenCalledWith(`/tasks/${parentId}`);
  });

  it('shows the successful title only when the existing read returns the exact parent ID', async () => {
    state.get.mockResolvedValue({
      data: { ...baseTask, id: parentId, title: 'Parent title from API' },
    });
    const queryClient = makeQueryClient();

    renderTask({ ...baseTask, parentId }, queryClient);

    expect(await screen.findByText((_, node) => node?.textContent === 'Parent task: Parent title from API')).toBeInTheDocument();
    expect(state.get).toHaveBeenCalledWith(`/tasks/${parentId}`);
  });

  it('keeps the full parent UUID while the parent read is unresolved', () => {
    state.get.mockReturnValue(new Promise(() => undefined));

    renderTask({ ...baseTask, parentId });

    expect(
      parentText(parentId),
    ).toBeInTheDocument();
    expect(screen.queryByText('Parent title from API')).not.toBeInTheDocument();
  });

  it('keeps the full parent UUID when the parent read is paused offline', () => {
    onlineManager.setOnline(false);

    renderTask({ ...baseTask, parentId });

    expect(
      parentText(parentId),
    ).toBeInTheDocument();
    expect(state.get).not.toHaveBeenCalledWith(`/tasks/${parentId}`);
  });

  it.each([
    ['unauthorized', 401],
    ['forbidden', 403],
    ['missing', 404],
    ['network failure', undefined],
  ])('keeps the UUID after a %s parent-read failure', async (_label, status) => {
    const error = Object.assign(new Error('private server detail'), {
      response: status === undefined ? undefined : { status },
    });
    state.get.mockRejectedValue(error);

    renderTask({ ...baseTask, parentId });

    expect(
      await screen.findByText((_, node) => node?.textContent === `Parent task: ${parentId}`),
    ).toBeInTheDocument();
    expect(screen.queryByText('private server detail')).not.toBeInTheDocument();
  });

  it('keeps the UUID when the successful response belongs to a different task', async () => {
    state.get.mockResolvedValue({
      data: { ...baseTask, id: otherParentId, title: 'Unrelated task title' },
    });

    renderTask({ ...baseTask, parentId });

    expect(
      await screen.findByText((_, node) => node?.textContent === `Parent task: ${parentId}`),
    ).toBeInTheDocument();
    expect(screen.queryByText('Unrelated task title')).not.toBeInTheDocument();
  });

  it('does not render a cached title whose task ID differs from the requested parent', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
    });
    queryClients.add(queryClient);
    queryClient.setQueryData(['tasks', parentId], {
      ...baseTask,
      id: otherParentId,
      title: 'Cached unrelated title',
    });

    renderTask({ ...baseTask, parentId }, queryClient);

    expect(parentText(parentId)).toBeInTheDocument();
    expect(screen.queryByText('Cached unrelated title')).not.toBeInTheDocument();
    expect(state.get).not.toHaveBeenCalledWith(`/tasks/${parentId}`);
  });

  it('renders a parent title as text rather than interpreting markup', async () => {
    const title = '<img src=x onerror=alert(1)>';
    state.get.mockResolvedValue({ data: { ...baseTask, id: parentId, title } });

    renderTask({ ...baseTask, parentId });

    expect(
      await screen.findByText((_, node) => node?.textContent === `Parent task: ${title}`),
    ).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('keeps the UUID when the parent response is malformed', async () => {
    state.get.mockResolvedValue({ data: { id: parentId, title: 42 } });

    renderTask({ ...baseTask, parentId });

    expect(
      await screen.findByText((_, node) => node?.textContent === `Parent task: ${parentId}`),
    ).toBeInTheDocument();
  });

  it('does not show an old parent title after the child changes parent while reads are in flight', async () => {
    let resolveFirst!: (value: { data: unknown }) => void;
    let resolveSecond!: (value: { data: unknown }) => void;
    state.get.mockImplementation((url: string) => {
      if (url === `/tasks/${parentId}`) {
        return new Promise((resolve) => { resolveFirst = resolve; });
      }
      if (url === `/tasks/${otherParentId}`) {
        return new Promise((resolve) => { resolveSecond = resolve; });
      }
      return new Promise(() => undefined);
    });
    const queryClient = makeQueryClient();
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <TaskDetail task={readTask({ ...baseTask, parentId })} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(state.get).toHaveBeenCalledWith(`/tasks/${parentId}`));
    rerender(
      <QueryClientProvider client={queryClient}>
        <TaskDetail task={readTask({ ...baseTask, parentId: otherParentId })} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(state.get).toHaveBeenCalledWith(`/tasks/${otherParentId}`));

    resolveFirst({ data: { ...baseTask, id: parentId, title: 'Old parent title' } });
    await waitFor(() => expect(screen.queryByText('Old parent title')).not.toBeInTheDocument());
    expect(
      parentText(otherParentId),
    ).toBeInTheDocument();

    resolveSecond({ data: { ...baseTask, id: otherParentId, title: 'Current parent title' } });
    expect(
      await screen.findByText((_, node) => node?.textContent === 'Parent task: Current parent title'),
    ).toBeInTheDocument();
  });

  it.each([
    ['null', { ...baseTask, parentId: null }],
    ['omitted', baseTask],
  ])('does not show a parent section or copy action when the parent ID is %s', (_label, task) => {
    renderTask(task);

    expect(screen.queryByText('Parent task')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy parent task ID/ })).not.toBeInTheDocument();
    expect(state.get).not.toHaveBeenCalledWith(`/tasks/${taskId}`);
  });
});
