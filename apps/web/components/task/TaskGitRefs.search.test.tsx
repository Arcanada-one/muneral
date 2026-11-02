import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskGitRefs } from './TaskGitRefs';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ default: api }));

const taskId = '11111111-1111-4111-8111-111111111111';
const nextTaskId = '22222222-2222-4222-8222-222222222222';
const branchUrl = 'https://github.com/example/repo/tree/release/long-feature-name';
const branch = {
  id: '33333333-3333-4333-8333-333333333333',
  taskId,
  type: 'branch',
  url: branchUrl,
  ref: 'release/long-feature-name',
  createdAt: '2026-10-24T00:00:00.000Z',
};
const repository = {
  id: '44444444-4444-4444-8444-444444444444',
  taskId,
  type: 'repo',
  url: 'https://github.com/example/repo',
  ref: null,
  createdAt: '2026-10-23T00:00:00.000Z',
};
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

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

beforeEach(() => {
  api.get.mockReset().mockImplementation(async (url: string) => ({
    data: url === `/projects/tasks/${nextTaskId}/git-refs`
      ? [{ ...branch, id: '55555555-5555-4555-8555-555555555555', taskId: nextTaskId,
        url: 'https://github.com/example/repo/tree/release/current-feature',
        ref: 'release/current-feature' }]
      : [branch, repository],
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

describe('loaded Git reference search', () => {
  it('starts empty, trims and case-folds text, searches safe displayed text and URL, and clears locally', async () => {
    renderRefs();

    const search = await screen.findByRole('searchbox', { name: 'Search loaded Git references' });
    expect(search).toHaveValue('');
    expect(screen.getByText('Showing 2 of 2 loaded Git references.')).toBeInTheDocument();
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href')))
      .toEqual([branchUrl, repository.url]);

    fireEvent.change(search, { target: { value: '  LONG-FEATURE-NAME  ' } });
    expect(await screen.findByText('Showing 1 of 2 loaded Git references.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'release/long-feature-name' })).toHaveAttribute('href', branchUrl);
    expect(screen.queryByRole('link', { name: repository.url })).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'EXAMPLE/REPO' } });
    expect(screen.getByText('Showing 2 of 2 loaded Git references.')).toBeInTheDocument();
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href')))
      .toEqual([branchUrl, repository.url]);

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(search).toHaveValue('');
    expect(screen.getByText('Showing 2 of 2 loaded Git references.')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('combines search with kind, preserves the kind when clearing, and explains loaded-list no matches', async () => {
    renderRefs();

    const search = await screen.findByRole('searchbox', { name: 'Search loaded Git references' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Git reference kind' }), {
      target: { value: 'repo' },
    });
    fireEvent.change(search, { target: { value: 'long-feature-name' } });

    expect(screen.getByText('Showing 0 of 2 loaded Git references.')).toBeInTheDocument();
    expect(screen.getByText(/No matching Git references in the loaded list\./)).toHaveTextContent(
      'Clear search or choose All references to show more.',
    );
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(search).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Git reference kind' })).toHaveValue('repo');
    expect(screen.getByText('Showing 1 of 2 loaded Git references.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: repository.url })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('searches only the generic label for rejected URLs and never renders their raw values', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      data: [{ ...branch, url: 'javascript:private-url-marker', ref: 'private-ref-marker' }],
    } as never);
    renderRefs();

    const search = await screen.findByRole('searchbox', { name: 'Search loaded Git references' });
    expect(screen.getByText('Reference link unavailable')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('private-url-marker');
    expect(document.body).not.toHaveTextContent('private-ref-marker');

    fireEvent.change(search, { target: { value: 'private' } });
    expect(screen.getByText('Showing 0 of 1 loaded Git references.')).toBeInTheDocument();
    expect(screen.queryByText('Reference link unavailable')).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'REFERENCE LINK UNAVAILABLE' } });
    expect(screen.getByText('Showing 1 of 1 loaded Git references.')).toBeInTheDocument();
    expect(screen.getByText('Reference link unavailable')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('private-url-marker');
    expect(document.body).not.toHaveTextContent('private-ref-marker');
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('keeps the query across same-task data refreshes and rematches current rows', async () => {
    const view = renderRefs();
    const search = await screen.findByRole('searchbox', { name: 'Search loaded Git references' });
    fireEvent.change(search, { target: { value: 'release' } });
    expect(screen.getByText('Showing 1 of 2 loaded Git references.')).toBeInTheDocument();

    view.client.setQueryData(['tasks', taskId, 'git-refs'], [
      { ...branch, ref: 'main', url: 'https://github.com/example/repo/tree/main' },
      repository,
    ]);
    await waitFor(() => expect(screen.getByText('Showing 0 of 2 loaded Git references.')).toBeInTheDocument());
    expect(screen.getByRole('searchbox', { name: 'Search loaded Git references' })).toHaveValue('release');

    view.client.setQueryData(['tasks', taskId, 'git-refs'], [
      { ...branch, ref: 'release/current', url: 'https://github.com/example/repo/tree/release/current' },
      repository,
    ]);
    await waitFor(() => expect(screen.getByText('Showing 1 of 2 loaded Git references.')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'release/current' })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('resets search for a task switch and keeps existing copy controls bound to current loaded URLs', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const view = renderRefs();
    const search = await screen.findByRole('searchbox', { name: 'Search loaded Git references' });
    fireEvent.change(search, { target: { value: 'does-not-match' } });
    expect(screen.getByText('Showing 0 of 2 loaded Git references.')).toBeInTheDocument();

    view.rerenderTask(nextTaskId);
    const nextSearch = await screen.findByRole('searchbox', { name: 'Search loaded Git references' });
    expect(nextSearch).toHaveValue('');
    expect(screen.getByText('Showing 1 of 1 loaded Git references.')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', {
      name: 'Copy Git reference link for branch release/current-feature',
    }));
    expect(writeText).toHaveBeenCalledWith(
      'https://github.com/example/repo/tree/release/current-feature',
    );
    expect(await screen.findByText('Git reference link copied.')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});
