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

const taskId = '11111111-1111-4111-8111-111111111111';
const nextTaskId = '22222222-2222-4222-8222-222222222222';

const refs = [
  {
    id: '33333333-3333-4333-8333-333333333333', taskId, type: 'branch',
    url: 'https://github.com/example/repo/tree/feature/first', ref: 'feature/first',
    createdAt: '2026-10-28T00:00:00.000Z',
  },
  {
    id: '44444444-4444-4444-8444-444444444444', taskId, type: 'repo',
    url: 'https://github.com/example/repo', ref: 'example/repo',
    createdAt: '2026-10-28T00:01:00.000Z',
  },
  {
    id: '55555555-5555-4555-8555-555555555555', taskId, type: 'branch',
    url: 'https://github.com/example/repo/tree/feature/second', ref: 'feature/second',
    createdAt: '2026-10-28T00:02:00.000Z',
  },
  {
    id: '66666666-6666-4666-8666-666666666666', taskId, type: 'commit',
    url: 'https://github.com/example/repo/commit/0123456', ref: '0123456',
    createdAt: '2026-10-28T00:03:00.000Z',
  },
];

const nextTaskRefs = [
  {
    id: '77777777-7777-4777-8777-777777777777', taskId: nextTaskId, type: 'repo',
    url: 'https://github.com/next/project', ref: 'next/project',
    createdAt: '2026-10-29T00:00:00.000Z',
  },
  {
    id: '88888888-8888-4888-8888-888888888888', taskId: nextTaskId, type: 'commit',
    url: 'https://github.com/next/project/commit/abcdef0', ref: 'abcdef0',
    createdAt: '2026-10-29T00:01:00.000Z',
  },
];

function renderRefs(currentTaskId = taskId) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const renderForTask = (id: string) => (
    <QueryClientProvider client={client}>
      <TaskGitRefs taskId={id} />
    </QueryClientProvider>
  );
  const view = render(renderForTask(currentTaskId));
  return {
    ...view,
    client,
    rerenderTask: (id: string) => view.rerender(renderForTask(id)),
  };
}

function renderedReferenceLabels() {
  return screen.getAllByRole('link').map((link) => link.textContent);
}

beforeEach(() => {
  api.get.mockReset().mockImplementation(async (url: string) => ({
    data: url === `/projects/tasks/${nextTaskId}/git-refs` ? nextTaskRefs : refs,
  }));
  for (const method of [api.post, api.put, api.patch, api.delete]) method.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('task Git reference kind filter', () => {
  it('shows the accessible four-option native selector by default and preserves loaded order', async () => {
    renderRefs();

    const selector = await screen.findByRole('combobox', { name: 'Git reference kind' });
    expect(selector.tagName).toBe('SELECT');
    expect(Array.from((selector as HTMLSelectElement).options).map((option) => option.textContent)).toEqual([
      'All references', 'Repositories', 'Branches', 'Commits',
    ]);
    expect(selector).toHaveValue('all');
    expect(screen.getByText('Showing 4 of 4 loaded Git references.')).toBeInTheDocument();
    expect(renderedReferenceLabels()).toEqual([
      'feature/first', 'example/repo', 'feature/second', '0123456',
    ]);
  });

  it('filters exact kinds, reports subset and full totals, and performs no additional request or mutation', async () => {
    renderRefs();
    const selector = await screen.findByRole('combobox', { name: 'Git reference kind' });

    const cases = [
      { value: 'repo', count: 1, labels: ['example/repo'] },
      { value: 'branch', count: 2, labels: ['feature/first', 'feature/second'] },
      { value: 'commit', count: 1, labels: ['0123456'] },
      { value: 'all', count: 4, labels: ['feature/first', 'example/repo', 'feature/second', '0123456'] },
    ];
    for (const testCase of cases) {
      fireEvent.change(selector, { target: { value: testCase.value } });
      expect(selector).toHaveValue(testCase.value);
      expect(screen.getByText(`Showing ${testCase.count} of 4 loaded Git references.`)).toBeInTheDocument();
      expect(renderedReferenceLabels()).toEqual(testCase.labels);
    }

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith(`/projects/tasks/${taskId}/git-refs`);
    expect(api.post).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('distinguishes a filter-empty subset from loading, read failure, and a loaded-empty response', async () => {
    api.get.mockReset().mockResolvedValueOnce({ data: [refs[1], refs[3]] });
    const view = renderRefs();
    const selector = await screen.findByRole('combobox', { name: 'Git reference kind' });
    fireEvent.change(selector, { target: { value: 'branch' } });
    expect(screen.getByText(
      'No matching Git references in the loaded list. Choose All references to show all.',
    )).toBeInTheDocument();
    expect(selector).toHaveValue('branch');

    view.unmount();
    let resolveLoad: ((response: { data: typeof refs }) => void) | undefined;
    api.get.mockReset().mockImplementationOnce(() => new Promise((resolve) => {
      resolveLoad = resolve;
    }));
    const loadingView = renderRefs();
    expect(screen.getByText('Loading Git references…')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Git reference kind' })).not.toBeInTheDocument();
    await act(async () => resolveLoad?.({ data: refs }));
    expect(await screen.findByRole('combobox', { name: 'Git reference kind' })).toBeInTheDocument();
    loadingView.unmount();

    api.get.mockReset().mockRejectedValueOnce(new Error('Synthetic read failure'));
    const errorView = renderRefs();
    expect(await screen.findByRole('alert')).toHaveTextContent('Git references are unavailable.');
    expect(screen.queryByRole('combobox', { name: 'Git reference kind' })).not.toBeInTheDocument();
    errorView.unmount();

    api.get.mockReset().mockResolvedValueOnce({ data: [] });
    renderRefs();
    expect(await screen.findByText('No Git references.')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Git reference kind' })).not.toBeInTheDocument();
  });

  it('preserves the choice across same-task data refresh and resets it when task identity changes', async () => {
    const view = renderRefs();
    const selector = await screen.findByRole('combobox', { name: 'Git reference kind' });
    await waitFor(() => {
      expect(view.client.getQueryState(['tasks', taskId, 'git-refs'])).toMatchObject({
        status: 'success',
        fetchStatus: 'idle',
      });
    });
    fireEvent.change(selector, { target: { value: 'branch' } });
    expect(renderedReferenceLabels()).toEqual(['feature/first', 'feature/second']);

    const refreshedRefs = [
      { ...refs[0], ref: 'feature/current' },
      { ...refs[1] },
      { ...refs[2], ref: 'feature/new' },
      { ...refs[3] },
    ];
    api.get.mockResolvedValueOnce({ data: refreshedRefs });
    await act(async () => {
      await view.client.refetchQueries({
        queryKey: ['tasks', taskId, 'git-refs'],
        exact: true,
      });
    });

    expect(api.get.mock.calls).toEqual([
      [`/projects/tasks/${taskId}/git-refs`],
      [`/projects/tasks/${taskId}/git-refs`],
    ]);
    expect(view.client.getQueryData(['tasks', taskId, 'git-refs'])).toEqual(refreshedRefs);
    expect(screen.getByRole('combobox', { name: 'Git reference kind' })).toHaveValue('branch');
    expect(screen.getByText('Showing 2 of 4 loaded Git references.')).toBeInTheDocument();
    await waitFor(() => {
      expect(renderedReferenceLabels()).toEqual(['feature/current', 'feature/new']);
    });
    expect(api.get).toHaveBeenCalledTimes(2);

    view.rerenderTask(nextTaskId);
    const nextSelector = await screen.findByRole('combobox', { name: 'Git reference kind' });
    expect(nextSelector).toHaveValue('all');
    expect(renderedReferenceLabels()).toEqual(['next/project', 'abcdef0']);
  });
});
