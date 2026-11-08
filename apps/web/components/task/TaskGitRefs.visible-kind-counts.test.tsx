import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskGitRefs } from './TaskGitRefs';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('@/lib/api/client', () => ({ default: api }));

const taskA = '11111111-1111-4111-8111-111111111111';
const taskB = '22222222-2222-4222-8222-222222222222';
const taskAKey = ['tasks', taskA, 'git-refs'];

type FixtureRef = {
  id: string;
  taskId: string;
  type: string;
  url: string;
  ref: string | null;
  createdAt: string;
};

function makeRef(id: string, taskId: string, type: string, ref: string, url: string): FixtureRef {
  return { id, taskId, type, ref, url, createdAt: '2026-11-08T00:00:00.000Z' };
}

const initialA = [
  makeRef('33333333-3333-4333-8333-333333333333', taskA, 'repo', 'example/repo', 'https://github.com/example/repo'),
  makeRef('44444444-4444-4444-8444-444444444444', taskA, 'branch', 'release/current', 'https://github.com/example/repo/tree/release/current'),
  makeRef('55555555-5555-4555-8555-555555555555', taskA, 'branch', 'release/next', 'https://github.com/example/repo/tree/release/next'),
  makeRef('66666666-6666-4666-8666-666666666666', taskA, 'commit', '0123456', 'https://github.com/example/repo/commit/0123456'),
];
const initialB = [
  makeRef('77777777-7777-4777-8777-777777777777', taskB, 'repo', 'next/project', 'https://github.com/next/project'),
  makeRef('88888888-8888-4888-8888-888888888888', taskB, 'commit', 'abcdef0', 'https://github.com/next/project/commit/abcdef0'),
];

function renderRefs(currentTaskId = taskA) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const renderForTask = (taskId: string) => (
    <QueryClientProvider client={client}>
      <TaskGitRefs taskId={taskId} />
    </QueryClientProvider>
  );
  const view = render(renderForTask(currentTaskId));
  return {
    ...view,
    client,
    rerenderTask: (taskId: string) => view.rerender(renderForTask(taskId)),
  };
}

function summaryText() {
  return screen.getByRole('status', { name: 'Visible reference kinds' });
}

function expectNoMutations() {
  expect(api.post).not.toHaveBeenCalled();
  expect(api.put).not.toHaveBeenCalled();
  expect(api.patch).not.toHaveBeenCalled();
  expect(api.delete).not.toHaveBeenCalled();
}

beforeEach(() => {
  api.get.mockReset().mockImplementation(async (url: string) => ({
    data: url === `/projects/tasks/${taskB}/git-refs` ? initialB : initialA,
  }));
  for (const method of [api.post, api.put, api.patch, api.delete]) method.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('visible Git reference kind counts', () => {
  it('counts each visible known and unknown row, including duplicate rows, without reflecting kind values', async () => {
    const view = renderRefs();
    await screen.findByRole('combobox', { name: 'Git reference kind' });
    const rows = [
      makeRef('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', taskA, 'repo', 'example/repo', 'https://github.com/example/repo'),
      makeRef('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', taskA, 'branch', 'main', 'https://github.com/example/repo/tree/main'),
      makeRef('cccccccc-cccc-4ccc-8ccc-cccccccccccc', taskA, 'branch', 'main', 'https://github.com/example/repo/tree/main'),
      makeRef('dddddddd-dddd-4ddd-8ddd-dddddddddddd', taskA, 'commit', '0123456', 'https://github.com/example/repo/commit/0123456'),
      makeRef('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', taskA, 'tag', 'release-tag', 'https://github.com/example/repo/tree/release-tag'),
    ];
    await act(async () => { view.client.setQueryData(taskAKey, rows); });

    await waitFor(() => expect(screen.getByText('Showing 5 of 5 loaded Git references.')).toBeInTheDocument());
    await waitFor(() => expect(summaryText()).toHaveTextContent(
      'Visible reference kinds for current loaded rows: Repositories 1; Branches 2; Commits 1; Other 1.',
    ));
    expect(summaryText()).not.toHaveTextContent('tag');
    expect(screen.getByRole('link', { name: /release-tag/ })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
    expectNoMutations();
  });

  it('intersects kind, search, and available-only filters; reverse control absent so order invariance is not measured here', async () => {
    const view = renderRefs();
    await screen.findByRole('combobox', { name: 'Git reference kind' });
    expect(screen.queryByRole('checkbox', { name: 'Reverse loaded order' })).not.toBeInTheDocument();
    const rows = [
      makeRef('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', taskA, 'repo', 'example/repo', 'https://github.com/example/repo'),
      makeRef('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', taskA, 'branch', 'release/current', 'https://github.com/example/repo/tree/release/current'),
      makeRef('cccccccc-cccc-4ccc-8ccc-cccccccccccc', taskA, 'branch', 'release/private', 'https://user:private@example.test/repo'),
      makeRef('dddddddd-dddd-4ddd-8ddd-dddddddddddd', taskA, 'commit', '0123456', 'https://github.com/example/repo/commit/0123456'),
      makeRef('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', taskA, 'tag', 'release-tag', 'https://github.com/example/repo/tree/release-tag'),
    ];
    await act(async () => { view.client.setQueryData(taskAKey, rows); });
    await waitFor(() => expect(summaryText()).toHaveTextContent('Repositories 1; Branches 2; Commits 1; Other 1.'));

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded Git references' }), {
      target: { value: 'release' },
    });
    await waitFor(() => expect(summaryText()).toHaveTextContent('Repositories 0; Branches 1; Commits 0; Other 1.'));

    fireEvent.change(screen.getByRole('combobox', { name: 'Git reference kind' }), {
      target: { value: 'branch' },
    });
    await waitFor(() => expect(summaryText()).toHaveTextContent('Repositories 0; Branches 1; Commits 0.'));

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(summaryText()).toHaveTextContent('Repositories 0; Branches 2; Commits 0.'));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show available links only' }));
    await waitFor(() => expect(summaryText()).toHaveTextContent('Repositories 0; Branches 1; Commits 0.'));
    expect(screen.getByText('Showing 1 of 5 loaded Git references.')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
    expectNoMutations();
  });

  it('updates after same-task refresh and empty recovery, and follows task A-B-A without stale counts', async () => {
    let currentA: FixtureRef[] = initialA;
    api.get.mockImplementation(async (url: string) => ({
      data: url === `/projects/tasks/${taskB}/git-refs` ? initialB : currentA,
    }));
    const view = renderRefs();
    await screen.findByRole('combobox', { name: 'Git reference kind' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Git reference kind' }), {
      target: { value: 'branch' },
    });
    expect(summaryText()).toHaveTextContent('Repositories 0; Branches 2; Commits 0.');

    const refreshedA = [
      makeRef('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', taskA, 'repo', 'updated/repo', 'https://github.com/updated/repo'),
      makeRef('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', taskA, 'branch', 'updated/main', 'https://github.com/updated/repo/tree/main'),
      makeRef('cccccccc-cccc-4ccc-8ccc-cccccccccccc', taskA, 'commit', '7654321', 'https://github.com/updated/repo/commit/7654321'),
      makeRef('dddddddd-dddd-4ddd-8ddd-dddddddddddd', taskA, 'commit', '7654322', 'https://github.com/updated/repo/commit/7654322'),
    ];
    currentA = refreshedA;
    let resolveRefresh: ((result: { data: FixtureRef[] }) => void) | undefined;
    api.get.mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    let refresh = Promise.resolve();
    await act(async () => {
      refresh = view.client.refetchQueries({ queryKey: taskAKey, exact: true });
      await Promise.resolve();
    });
    await waitFor(() => expect(view.client.getQueryState(taskAKey)?.fetchStatus).toBe('fetching'));
    expect(screen.queryByRole('status', { name: 'Visible reference kinds' })).not.toBeInTheDocument();
    await act(async () => {
      resolveRefresh?.({ data: refreshedA });
      await refresh;
    });
    await waitFor(() => expect(summaryText()).toHaveTextContent('Repositories 0; Branches 1; Commits 0.'));

    await act(async () => { view.client.setQueryData(taskAKey, []); });
    await waitFor(() => expect(screen.getByText('No Git references.')).toBeInTheDocument());
    await waitFor(() => expect(summaryText()).toHaveTextContent(
      'Visible reference kinds for current loaded rows: Repositories 0; Branches 0; Commits 0.',
    ));
    await act(async () => { view.client.setQueryData(taskAKey, refreshedA); });
    await waitFor(() => expect(summaryText()).toHaveTextContent('Repositories 0; Branches 1; Commits 0.'));

    view.rerenderTask(taskB);
    expect(await screen.findByRole('status', { name: 'Visible reference kinds' })).toHaveTextContent(
      'Repositories 1; Branches 0; Commits 1.',
    );
    view.rerenderTask(taskA);
    expect(await screen.findByRole('status', { name: 'Visible reference kinds' })).toHaveTextContent(
      'Repositories 1; Branches 1; Commits 2.',
    );
    expect(api.get.mock.calls).toEqual([
      [`/projects/tasks/${taskA}/git-refs`],
      [`/projects/tasks/${taskA}/git-refs`],
      [`/projects/tasks/${taskB}/git-refs`],
      [`/projects/tasks/${taskA}/git-refs`],
    ]);
    expectNoMutations();
  });

  it('hides counts during loading and after a failed refresh rather than exposing cached rows', async () => {
    let resolveInitial: ((result: { data: FixtureRef[] }) => void) | undefined;
    api.get.mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve; }));
    const view = renderRefs();
    expect(screen.getByText('Loading Git references…')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Visible reference kinds' })).not.toBeInTheDocument();
    await act(async () => { resolveInitial?.({ data: initialA }); });
    await screen.findByRole('combobox', { name: 'Git reference kind' });
    expect(summaryText()).toHaveTextContent('Repositories 1; Branches 2; Commits 1.');

    let rejectRefresh: ((reason: Error) => void) | undefined;
    api.get.mockImplementationOnce(() => new Promise((_, reject) => { rejectRefresh = reject; }));
    let refresh = Promise.resolve();
    await act(async () => {
      refresh = view.client.refetchQueries({ queryKey: taskAKey, exact: true });
      await Promise.resolve();
    });
    await waitFor(() => expect(view.client.getQueryState(taskAKey)?.fetchStatus).toBe('fetching'));
    expect(screen.queryByRole('status', { name: 'Visible reference kinds' })).not.toBeInTheDocument();
    await act(async () => {
      rejectRefresh?.(new Error('Synthetic refresh failure'));
      await refresh;
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Git references are unavailable.');
    expect(screen.queryByRole('status', { name: 'Visible reference kinds' })).not.toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(2);
    expectNoMutations();
  });
});
