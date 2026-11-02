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
const firstUrl = 'https://github.com/example/repo/tree/release/one';
const secondUrl = 'https://github.com/example/repo/tree/release/two';
const repositoryUrl = 'https://github.com/example/repository';
const privateMarker = 'private-reverse-order-marker';

const taskARefs = [
  {
    id: '33333333-3333-4333-8333-333333333333', taskId: taskA, type: 'branch',
    url: firstUrl, ref: 'refs/heads/release/one', createdAt: '2026-11-03T00:00:00.000Z',
  },
  {
    id: '44444444-4444-4444-8444-444444444444', taskId: taskA, type: 'repo',
    url: repositoryUrl, ref: 'example/repository', createdAt: '2026-11-01T00:00:00.000Z',
  },
  {
    id: '55555555-5555-4555-8555-555555555555', taskId: taskA, type: 'branch',
    url: secondUrl, ref: 'refs/heads/release/two', createdAt: '2026-11-02T00:00:00.000Z',
  },
  {
    id: '66666666-6666-4666-8666-666666666666', taskId: taskA, type: 'branch',
    url: firstUrl, ref: null, createdAt: '2026-11-04T00:00:00.000Z',
  },
  {
    id: '77777777-7777-4777-8777-777777777777', taskId: taskA, type: 'commit',
    url: `https://user:${privateMarker}@example.test/repo`, ref: privateMarker,
    createdAt: '2026-11-05T00:00:00.000Z',
  },
];
const taskBRefs = [{
  id: '88888888-8888-4888-8888-888888888888', taskId: taskB, type: 'repo',
  url: 'https://github.com/other/project', ref: 'other/project', createdAt: '2026-11-06T00:00:00.000Z',
}];

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

function renderedLinks() {
  return screen.getAllByRole('link').map((link) => link.textContent);
}

function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

beforeEach(() => {
  api.get.mockReset().mockImplementation(async (url: string) => ({
    data: url === `/projects/tasks/${taskB}/git-refs` ? taskBRefs : taskARefs,
  }));
  for (const method of [api.post, api.put, api.patch, api.delete]) method.mockReset();
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

describe('reverse loaded Git reference order', () => {
  it('defaults to server order, reverses a copy, and restores the same loaded order', async () => {
    const sourceOrder = taskARefs.map((ref) => ref.id);
    const view = renderRefs();
    const reverse = await screen.findByRole('checkbox', { name: 'Reverse loaded order' });

    expect(reverse.tagName).toBe('INPUT');
    expect(reverse).not.toBeChecked();
    expect(renderedLinks()).toEqual([
      'refs/heads/release/one', 'example/repository', 'refs/heads/release/two', firstUrl,
    ]);
    expect(screen.getByText('Showing 5 of 5 loaded Git references.')).toBeInTheDocument();

    fireEvent.click(reverse);
    expect(reverse).toBeChecked();
    expect(renderedLinks()).toEqual([
      firstUrl, 'refs/heads/release/two', 'example/repository', 'refs/heads/release/one',
    ]);
    expect(screen.getByText('Reference link unavailable')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(privateMarker);
    expect(screen.getAllByRole('button', { name: 'Show link destination' })).toHaveLength(4);
    expect(taskARefs.map((ref) => ref.id)).toEqual(sourceOrder);

    fireEvent.click(reverse);
    expect(reverse).not.toBeChecked();
    expect(renderedLinks()).toEqual([
      'refs/heads/release/one', 'example/repository', 'refs/heads/release/two', firstUrl,
    ]);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.post).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
    view.unmount();
  });

  it('composes with filters and copies the reversed available rows, dropping deferred old feedback', async () => {
    let resolveFirstCopy!: () => void;
    const writeText = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirstCopy = resolve; }))
      .mockResolvedValue(undefined);
    installClipboard(writeText);
    renderRefs();

    fireEvent.change(await screen.findByRole('combobox', { name: 'Git reference kind' }), {
      target: { value: 'branch' },
    });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded Git references' }), {
      target: { value: 'release' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show available links only' }));
    const reverse = screen.getByRole('checkbox', { name: 'Reverse loaded order' });
    fireEvent.click(reverse);

    expect(screen.getByText('Showing 3 of 5 loaded Git references.')).toBeInTheDocument();
    expect(renderedLinks()).toEqual([
      firstUrl, 'refs/heads/release/two', 'refs/heads/release/one',
    ]);
    expect(screen.queryByText('Reference link unavailable')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy 3 available Git reference links' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Copy 3 available Git reference values' })).toBeEnabled();

    const linksButton = screen.getByRole('button', { name: 'Copy 3 available Git reference links' });
    fireEvent.click(linksButton);
    expect(writeText).toHaveBeenCalledWith([firstUrl, secondUrl, firstUrl].join('\n'));
    expect(linksButton).toBeDisabled();
    fireEvent.click(linksButton);
    expect(writeText).toHaveBeenCalledTimes(1);

    fireEvent.click(reverse);
    expect(reverse).not.toBeChecked();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await act(async () => resolveFirstCopy());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(reverse);
    fireEvent.click(screen.getByRole('button', { name: 'Copy 3 available Git reference values' }));
    expect(writeText).toHaveBeenLastCalledWith([
      firstUrl, 'refs/heads/release/two', 'refs/heads/release/one',
    ].join('\n'));
    expect(await screen.findByRole('status')).toHaveTextContent('Available Git reference values copied.');
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('keeps the choice through same-task refresh and an empty-list roundtrip, using new rows', async () => {
    const view = renderRefs();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Reverse loaded order' }));

    const refreshedRefs = [
      { ...taskARefs[0], id: '99999999-9999-4999-8999-999999999991', ref: 'fresh/first' },
      { ...taskARefs[2], id: '99999999-9999-4999-8999-999999999992', ref: 'fresh/last' },
    ];
    view.client.setQueryData(['tasks', taskA, 'git-refs'], refreshedRefs);
    await waitFor(() => expect(renderedLinks()).toEqual(['fresh/last', 'fresh/first']));
    expect(screen.getByRole('checkbox', { name: 'Reverse loaded order' })).toBeChecked();

    view.client.setQueryData(['tasks', taskA, 'git-refs'], []);
    expect(await screen.findByText('No Git references.')).toBeInTheDocument();
    view.client.setQueryData(['tasks', taskA, 'git-refs'], refreshedRefs);
    expect(await screen.findByRole('checkbox', { name: 'Reverse loaded order' })).toBeChecked();
    expect(renderedLinks()).toEqual(['fresh/last', 'fresh/first']);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('resets the view choice for A-B-A task switches without extra view requests', async () => {
    const view = renderRefs();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Reverse loaded order' }));
    expect(screen.getByRole('checkbox', { name: 'Reverse loaded order' })).toBeChecked();

    view.rerenderTask(taskB);
    expect(await screen.findByRole('checkbox', { name: 'Reverse loaded order' })).not.toBeChecked();
    expect(renderedLinks()).toEqual(['other/project']);

    view.rerenderTask(taskA);
    expect(await screen.findByRole('checkbox', { name: 'Reverse loaded order' })).not.toBeChecked();
    expect(renderedLinks()).toEqual([
      'refs/heads/release/one', 'example/repository', 'refs/heads/release/two', firstUrl,
    ]);
  });

  it('keeps the independent choice through Clear search, Escape, and filter reset', async () => {
    renderRefs();
    const reverse = await screen.findByRole('checkbox', { name: 'Reverse loaded order' });
    fireEvent.click(reverse);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded Git references' }), {
      target: { value: 'release/two' },
    });
    const search = screen.getByRole('searchbox', { name: 'Search loaded Git references' });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(reverse).toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(reverse).toBeChecked();
    fireEvent.change(screen.getByRole('combobox', { name: 'Git reference kind' }), {
      target: { value: 'branch' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reset Git reference filters' }));

    expect(reverse).toBeChecked();
    expect(renderedLinks()).toEqual([
      firstUrl, 'refs/heads/release/two', 'example/repository', 'refs/heads/release/one',
    ]);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.post).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });
});
