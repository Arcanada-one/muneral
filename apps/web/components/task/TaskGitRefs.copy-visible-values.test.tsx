import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskGitRefs } from './TaskGitRefs';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ default: api }));

const taskA = '11111111-1111-4111-8111-111111111111';
const taskB = '22222222-2222-4222-8222-222222222222';
const safeValues = [
  {
    id: '33333333-3333-4333-8333-333333333333', taskId: taskA, type: 'branch',
    url: 'https://github.com/example/repo/tree/main', ref: 'refs/heads/main', createdAt: '2026-11-02T00:00:00.000Z',
  },
  {
    id: '44444444-4444-4444-8444-444444444444', taskId: taskA, type: 'repo',
    url: 'https://github.com/example/repo', ref: 'example/repo', createdAt: '2026-11-02T00:01:00.000Z',
  },
  {
    id: '55555555-5555-4555-8555-555555555555', taskId: taskA, type: 'branch',
    url: 'https://github.com/example/repo/tree/main', ref: 'refs/heads/main', createdAt: '2026-11-02T00:02:00.000Z',
  },
  {
    id: '66666666-6666-4666-8666-666666666666', taskId: taskA, type: 'branch',
    url: 'https://github.com/example/fallback/tree/release/next', ref: null, createdAt: '2026-11-02T00:03:00.000Z',
  },
];
const rejectedValues = [
  {
    id: '77777777-7777-4777-8777-777777777777', taskId: taskA, type: 'branch',
    url: 'https://user:credential-marker@example.test/repo', ref: 'credential-marker', createdAt: '2026-11-02T00:04:00.000Z',
  },
  {
    id: '88888888-8888-4888-8888-888888888888', taskId: taskA, type: 'commit',
    url: 'https://example.test/repo?token=query-marker', ref: 'query-marker', createdAt: '2026-11-02T00:05:00.000Z',
  },
  {
    id: '99999999-9999-4999-8999-999999999999', taskId: taskA, type: 'commit',
    url: 'https://example.test/repo#fragment-marker', ref: 'fragment-marker', createdAt: '2026-11-02T00:06:00.000Z',
  },
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', taskId: taskA, type: 'branch',
    url: 'javascript:scheme-marker', ref: 'scheme-marker', createdAt: '2026-11-02T00:07:00.000Z',
  },
];
const taskARefs = [...safeValues, ...rejectedValues];
const taskBRefs = [{
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', taskId: taskB, type: 'repo',
  url: 'https://github.com/other/project', ref: 'other/project', createdAt: '2026-11-02T00:08:00.000Z',
}];
const privateMarkers = ['credential-marker', 'query-marker', 'fragment-marker', 'scheme-marker'];
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function renderRefs(initialTaskId = taskA) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const renderTask = (taskId: string) => (
    <QueryClientProvider client={client}>
      <TaskGitRefs taskId={taskId} />
    </QueryClientProvider>
  );
  const view = render(renderTask(initialTaskId));
  return {
    ...view,
    client,
    rerenderTask: (taskId: string) => view.rerender(renderTask(taskId)),
  };
}

function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

function copyValuesButton(count: number) {
  return screen.getByRole('button', { name: `Copy ${count} available Git reference values` });
}

function deferredWriteText() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { writeText: vi.fn(() => promise), resolve, reject };
}

async function settleDeferred(
  deferred: ReturnType<typeof deferredWriteText>,
  outcome: 'resolve' | 'reject',
) {
  await act(async () => {
    if (outcome === 'resolve') deferred.resolve();
    else deferred.reject(new Error('private clipboard error detail'));
  });
}

beforeEach(() => {
  api.get.mockReset().mockImplementation(async (url: string) => ({
    data: url === `/projects/tasks/${taskB}/git-refs` ? taskBRefs : taskARefs,
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalClipboard) {
    Object.defineProperty(navigator, 'clipboard', originalClipboard);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

describe('copy available visible Git reference values', () => {
  it('copies exact eligible row values in visible order, preserving duplicates and URL fallback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);
    renderRefs();

    const button = await screen.findByRole('button', { name: 'Copy 4 available Git reference values' });
    expect(button).toBeEnabled();
    expect(writeText).not.toHaveBeenCalled();
    for (const marker of privateMarkers) expect(document.body).not.toHaveTextContent(marker);

    fireEvent.click(button);

    expect(writeText).toHaveBeenCalledWith([
      'refs/heads/main',
      'example/repo',
      'refs/heads/main',
      'https://github.com/example/fallback/tree/release/next',
    ].join('\n'));
    expect(await screen.findByText('Available Git reference values copied.')).toHaveAttribute('role', 'status');
    for (const marker of privateMarkers) expect(document.body).not.toHaveTextContent(marker);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('intersects kind, search, and available-only filters and disables the zero-value action', async () => {
    renderRefs();
    await screen.findByRole('checkbox', { name: 'Show available links only' });

    fireEvent.change(screen.getByRole('combobox', { name: 'Git reference kind' }), { target: { value: 'branch' } });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded Git references' }), {
      target: { value: 'refs/heads/main' },
    });
    expect(copyValuesButton(2)).toBeEnabled();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show available links only' }));
    expect(copyValuesButton(2)).toBeEnabled();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded Git references' }), {
      target: { value: 'credential-marker' },
    });
    expect(copyValuesButton(0)).toBeDisabled();
    expect(document.body).not.toHaveTextContent('credential-marker');
    expect(document.body).not.toHaveTextContent('query-marker');
    expect(document.body).not.toHaveTextContent('fragment-marker');
    expect(document.body).not.toHaveTextContent('scheme-marker');
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('keeps empty loaded lists explicit and disables copying with zero eligible values', async () => {
    api.get.mockResolvedValueOnce({ data: [] });
    renderRefs();

    expect(await screen.findByText('No Git references.')).toBeInTheDocument();
    expect(copyValuesButton(0)).toBeDisabled();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('guards pending reentry and reports success only after the clipboard promise resolves', async () => {
    const deferred = deferredWriteText();
    installClipboard(deferred.writeText);
    renderRefs();
    const button = await screen.findByRole('button', { name: 'Copy 4 available Git reference values' });

    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Copying available references…')).toBeInTheDocument();
    expect(screen.queryByText('Available Git reference values copied.')).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(deferred.writeText).toHaveBeenCalledTimes(1);

    await settleDeferred(deferred, 'resolve');
    expect(await screen.findByText('Available Git reference values copied.')).toBeInTheDocument();
    expect(button).toBeEnabled();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('shows generic rejection feedback, hides error details, and permits recovery', async () => {
    const writeText = vi.fn()
      .mockRejectedValueOnce(new Error('private clipboard error detail'))
      .mockResolvedValueOnce(undefined);
    installClipboard(writeText);
    renderRefs();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy 4 available Git reference values' }));

    expect(await screen.findByText('Could not copy available Git reference values. Try again.')).toHaveAttribute('role', 'alert');
    expect(document.body).not.toHaveTextContent('private clipboard error detail');
    fireEvent.click(copyValuesButton(4));
    expect(await screen.findByText('Available Git reference values copied.')).toBeInTheDocument();
    expect(screen.queryByText('Could not copy available Git reference values. Try again.')).not.toBeInTheDocument();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('reports an unavailable clipboard generically and recovers if it becomes available', async () => {
    Reflect.deleteProperty(navigator, 'clipboard');
    renderRefs();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy 4 available Git reference values' }));

    expect(await screen.findByText('Could not copy available Git reference values. Try again.')).toBeInTheDocument();
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);
    fireEvent.click(copyValuesButton(4));
    expect(await screen.findByText('Available Git reference values copied.')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'reject'] as const)(
    'does not apply an old deferred %s result after an ABA filter change', async (outcome) => {
      const deferred = deferredWriteText();
      installClipboard(deferred.writeText);
      renderRefs();
      fireEvent.click(await screen.findByRole('button', { name: 'Copy 4 available Git reference values' }));
      const search = screen.getByRole('searchbox', { name: 'Search loaded Git references' });
      fireEvent.change(search, { target: { value: 'refs/heads/main' } });
      fireEvent.change(search, { target: { value: '' } });

      expect(copyValuesButton(4)).toBeEnabled();
      expect(screen.queryByText('Available Git reference values copied.')).not.toBeInTheDocument();
      expect(screen.queryByText('Could not copy available Git reference values. Try again.')).not.toBeInTheDocument();
      await settleDeferred(deferred, outcome);
      expect(screen.queryByText('Available Git reference values copied.')).not.toBeInTheDocument();
      expect(screen.queryByText('Could not copy available Git reference values. Try again.')).not.toBeInTheDocument();
      expect(api.get).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'invalidates an old deferred %s result when the reference changes but its safe URL is equal', async (outcome) => {
      const deferred = deferredWriteText();
      installClipboard(deferred.writeText);
      const view = renderRefs();
      fireEvent.click(await screen.findByRole('button', { name: 'Copy 4 available Git reference values' }));

      const changedRefs = taskARefs.map((ref) => ref.id === safeValues[0].id
        ? { ...ref, ref: 'refs/heads/renamed' }
        : ref);
      view.client.setQueryData(['tasks', taskA, 'git-refs'], changedRefs, { updatedAt: Date.now() + 5_000 });
      await waitFor(() => expect(copyValuesButton(4)).toBeEnabled());
      await settleDeferred(deferred, outcome);

      expect(screen.queryByText('Available Git reference values copied.')).not.toBeInTheDocument();
      expect(screen.queryByText('Could not copy available Git reference values. Try again.')).not.toBeInTheDocument();
      expect(deferred.writeText).toHaveBeenCalledTimes(1);
      expect(api.get).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'invalidates an old deferred %s result after same-task query refresh with identical row values', async (outcome) => {
      const deferred = deferredWriteText();
      installClipboard(deferred.writeText);
      const view = renderRefs();
      fireEvent.click(await screen.findByRole('button', { name: 'Copy 4 available Git reference values' }));
      const queryKey = ['tasks', taskA, 'git-refs'];
      const previousUpdatedAt = view.client.getQueryState(queryKey)?.dataUpdatedAt ?? Date.now();
      view.client.setQueryData(queryKey, taskARefs.map((ref) => ({ ...ref })), { updatedAt: previousUpdatedAt + 5_000 });
      await waitFor(() => expect(copyValuesButton(4)).toBeEnabled());
      await settleDeferred(deferred, outcome);

      expect(screen.queryByText('Available Git reference values copied.')).not.toBeInTheDocument();
      expect(screen.queryByText('Could not copy available Git reference values. Try again.')).not.toBeInTheDocument();
      expect(api.get).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'does not carry an old deferred %s result across task identity', async (outcome) => {
      const deferred = deferredWriteText();
      installClipboard(deferred.writeText);
      const view = renderRefs();
      fireEvent.click(await screen.findByRole('button', { name: 'Copy 4 available Git reference values' }));
      view.rerenderTask(taskB);
      expect(await screen.findByRole('button', { name: 'Copy 1 available Git reference values' })).toBeEnabled();
      await settleDeferred(deferred, outcome);

      expect(screen.queryByText('Available Git reference values copied.')).not.toBeInTheDocument();
      expect(screen.queryByText('Could not copy available Git reference values. Try again.')).not.toBeInTheDocument();
      expect(api.get.mock.calls).toEqual([
        [`/projects/tasks/${taskA}/git-refs`],
        [`/projects/tasks/${taskB}/git-refs`],
      ]);
    },
  );
});
