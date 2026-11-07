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
const firstBlockerId = '22222222-2222-4222-8222-222222222222';
const secondBlockerId = '33333333-3333-4333-8333-333333333333';
const thirdBlockerId = '44444444-4444-4444-8444-444444444444';
const edgeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secondEdgeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const thirdEdgeId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const duplicateEdgeId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const queryClients: QueryClient[] = [];
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function renderReadiness(id = taskId) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClients.push(queryClient);
  return render(
    <QueryClientProvider client={queryClient}>
      <TaskReadiness taskId={id} />
    </QueryClientProvider>,
  );
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
    toTaskId: firstBlockerId,
    otherTaskId: firstBlockerId,
    otherTaskTitle: 'Alpha blocker',
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

function visibleCopyButton(count: number) {
  return screen.getByRole('button', { name: `Copy visible loaded blocker IDs (${count})` });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

describe('copy visible loaded blocker IDs', () => {
  it('copies only currently visible unique IDs under local search, excluding search-hidden blockers', async () => {
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    const get = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness({
        ready: false,
        dependencyCount: 4,
        blockedBy: [
          blocker(),
          blocker({
            id: duplicateEdgeId,
            otherTaskTitle: 'Alpha duplicate edge',
          }),
          blocker({
            id: secondEdgeId,
            toTaskId: secondBlockerId,
            otherTaskId: secondBlockerId,
            otherTaskTitle: 'Needle blocker',
            otherTaskStatus: 'todo',
          }),
          blocker({
            id: thirdEdgeId,
            toTaskId: thirdBlockerId,
            otherTaskId: thirdBlockerId,
            otherTaskTitle: 'Gamma blocker',
            otherTaskStatus: 'review',
          }),
        ],
      }),
    } as never);

    renderReadiness();
    await screen.findByText('Alpha blocker');
    expect(visibleCopyButton(3)).toBeEnabled();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded blockers' }), {
      target: { value: ' needle ' },
    });
    expect(screen.getByText('Showing 1 of 4 loaded blocking dependencies.')).toBeInTheDocument();
    expect(screen.queryByText('Alpha blocker')).not.toBeInTheDocument();
    expect(screen.queryByText('Gamma blocker')).not.toBeInTheDocument();
    expect(visibleCopyButton(1)).toBeEnabled();

    fireEvent.click(visibleCopyButton(1));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(secondBlockerId);
    expect(writeText.mock.calls[0][0]).not.toContain(firstBlockerId);
    expect(writeText.mock.calls[0][0]).not.toContain(thirdBlockerId);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('keeps the all-loaded copy action available and behaviorally unchanged under search', async () => {
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness({
        ready: false,
        dependencyCount: 3,
        blockedBy: [
          blocker(),
          blocker({
            id: duplicateEdgeId,
            otherTaskTitle: 'Alpha duplicate edge',
          }),
          blocker({
            id: secondEdgeId,
            toTaskId: secondBlockerId,
            otherTaskId: secondBlockerId,
            otherTaskTitle: 'Needle blocker',
          }),
        ],
      }),
    } as never);

    renderReadiness();
    await screen.findByText('Alpha blocker');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded blockers' }), {
      target: { value: 'Needle' },
    });
    expect(screen.queryByText('Alpha blocker')).not.toBeInTheDocument();

    const loadedCopy = screen.getByRole('button', { name: 'Copy loaded blocker IDs' });
    expect(loadedCopy).toBeEnabled();
    fireEvent.click(loadedCopy);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(`${firstBlockerId}\n${secondBlockerId}`);
    expect(await screen.findByRole('status')).toHaveTextContent('Blocker IDs copied.');
  });

  it('disables visible copy for an empty visible set without writing the clipboard', async () => {
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
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
            otherTaskTitle: 'Needle blocker',
          }),
        ],
      }),
    } as never);

    renderReadiness();
    await screen.findByText('Alpha blocker');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded blockers' }), {
      target: { value: 'no-such-blocker' },
    });
    expect(screen.getByText('Showing 0 of 2 loaded blocking dependencies.')).toBeInTheDocument();
    expect(visibleCopyButton(0)).toBeDisabled();
    fireEvent.click(visibleCopyButton(0));
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Copy loaded blocker IDs' })).toBeEnabled();
  });

  it('adds no refetch, mutation, navigation, or storage beyond clipboard for visible copy', async () => {
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
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
            otherTaskTitle: 'Needle blocker',
          }),
        ],
      }),
    } as never);
    const mutations = [
      vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('unexpected mutation')),
      vi.spyOn(apiClient, 'put').mockRejectedValue(new Error('unexpected mutation')),
      vi.spyOn(apiClient, 'patch').mockRejectedValue(new Error('unexpected mutation')),
      vi.spyOn(apiClient, 'delete').mockRejectedValue(new Error('unexpected mutation')),
    ];
    const pushState = vi.spyOn(window.history, 'pushState');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const initialLocation = window.location.href;

    renderReadiness();
    await screen.findByText('Alpha blocker');
    const readsBeforeCopy = get.mock.calls.length;

    fireEvent.click(visibleCopyButton(2));
    expect(await screen.findByRole('status')).toHaveTextContent('Visible blocker IDs copied.');
    expect(writeText).toHaveBeenCalledWith(`${firstBlockerId}\n${secondBlockerId}`);
    expect(get).toHaveBeenCalledTimes(readsBeforeCopy);
    mutations.forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
    expect(window.location.href).toBe(initialLocation);
  });

  it('blocks synchronous re-entry and shows visible success only after clipboard resolves', async () => {
    const pending = deferred<void>();
    const writeText = installClipboard(vi.fn(() => pending.promise));
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness({
        ready: false,
        dependencyCount: 1,
        blockedBy: [blocker()],
      }),
    } as never);

    renderReadiness();
    await screen.findByText('Alpha blocker');
    const button = visibleCopyButton(1);
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(screen.queryByText('Visible blocker IDs copied.')).not.toBeInTheDocument();

    await act(async () => pending.resolve());
    expect(await screen.findByRole('status')).toHaveTextContent('Visible blocker IDs copied.');
    expect(button).toBeEnabled();
  });

  it('clears visible copy feedback when the visible ID set changes via search', async () => {
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
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
            otherTaskTitle: 'Needle blocker',
          }),
        ],
      }),
    } as never);

    renderReadiness();
    await screen.findByText('Alpha blocker');
    fireEvent.click(visibleCopyButton(2));
    expect(await screen.findByRole('status')).toHaveTextContent('Visible blocker IDs copied.');

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded blockers' }), {
      target: { value: 'Needle' },
    });
    expect(screen.queryByText('Visible blocker IDs copied.')).not.toBeInTheDocument();
    expect(visibleCopyButton(1)).toBeEnabled();
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});
