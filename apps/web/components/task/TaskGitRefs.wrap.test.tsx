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
const branchRef = 'feature/a-very-long-branch-name-that-needs-line-wrapping-in-the-task-view';
const commitRef = '0123456789abcdef0123456789abcdef01234567';
const repositoryUrl = 'https://github.com/example/repository-with-a-long-name';

const refs = [
  {
    id: '33333333-3333-4333-8333-333333333333', taskId, type: 'branch',
    url: `https://github.com/example/repo/tree/${branchRef}`, ref: branchRef,
    createdAt: '2026-10-29T00:00:00.000Z',
  },
  {
    id: '44444444-4444-4444-8444-444444444444', taskId, type: 'commit',
    url: `https://github.com/example/repo/commit/${commitRef}`, ref: commitRef,
    createdAt: '2026-10-29T00:01:00.000Z',
  },
  {
    id: '55555555-5555-4555-8555-555555555555', taskId, type: 'repo',
    url: repositoryUrl, ref: null,
    createdAt: '2026-10-29T00:02:00.000Z',
  },
];

const nextTaskRefs = [
  {
    id: '66666666-6666-4666-8666-666666666666', taskId: nextTaskId, type: 'branch',
    url: 'https://github.com/next/project/tree/next-task-branch', ref: 'next-task-branch',
    createdAt: '2026-10-29T00:03:00.000Z',
  },
];

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const writeText = vi.fn();

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
    data: url === `/projects/tasks/${nextTaskId}/git-refs` ? nextTaskRefs : refs,
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

describe('task Git reference text wrapping', () => {
  it('defaults to compact text and exposes a labelled checkbox that wraps full ref and URL fallback text', async () => {
    writeText.mockReset();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const view = renderRefs();
    const checkbox = await screen.findByRole('checkbox', { name: 'Wrap Git reference text' });
    expect(checkbox).not.toBeChecked();

    const branchLink = screen.getByRole('link', { name: new RegExp(branchRef) });
    const branchText = screen.getByText(branchRef);
    expect(branchText).toHaveClass('truncate');
    expect(branchLink).toHaveAttribute('href', refs[0].url);
    expect(branchLink).toHaveAttribute('target', '_blank');
    expect(branchLink).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('button', { name: `Copy branch reference ${branchRef}` })).toBeInTheDocument();
    expect(screen.getByText(commitRef)).toHaveClass('truncate');
    expect(screen.getByText(repositoryUrl)).toHaveClass('truncate');

    fireEvent.click(checkbox);

    expect(checkbox).toBeChecked();
    for (const fullText of [branchRef, commitRef, repositoryUrl]) {
      const text = screen.getByText(fullText);
      expect(text).toHaveTextContent(fullText);
      expect(text).toHaveClass('whitespace-normal', 'break-all');
      expect(text).not.toHaveClass('truncate');
    }
    expect(screen.getByRole('link', { name: new RegExp(branchRef) })).toHaveAttribute('href', refs[0].url);
    expect(screen.getByRole('button', { name: `Copy repository reference ${repositoryUrl}` })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith(`/projects/tasks/${taskId}/git-refs`);
    for (const method of [api.post, api.put, api.patch, api.delete]) expect(method).not.toHaveBeenCalled();
    expect(view.client.getQueryState(['tasks', taskId, 'git-refs'])?.fetchStatus).toBe('idle');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('preserves wrapping across same-task refresh and kind filtering, then resets it for a different task', async () => {
    const view = renderRefs();
    const checkbox = await screen.findByRole('checkbox', { name: 'Wrap Git reference text' });
    fireEvent.click(checkbox);
    const kindSelect = screen.getByRole('combobox', { name: 'Git reference kind' });
    fireEvent.change(kindSelect, { target: { value: 'branch' } });

    expect(checkbox).toBeChecked();
    expect(screen.getByText(`Showing 1 of 3 loaded Git references.`)).toBeInTheDocument();
    expect(screen.getByText(branchRef)).toHaveClass('break-all');
    expect(screen.queryByText(commitRef)).not.toBeInTheDocument();

    const refreshedRefs = [
      { ...refs[0], ref: 'feature/refreshed-branch-with-current-data' },
      refs[1],
      refs[2],
    ];
    api.get.mockResolvedValueOnce({ data: refreshedRefs });
    await act(async () => {
      await view.client.refetchQueries({ queryKey: ['tasks', taskId, 'git-refs'], exact: true });
    });

    expect(api.get).toHaveBeenCalledTimes(2);
    expect(checkbox).toBeChecked();
    expect(kindSelect).toHaveValue('branch');
    await waitFor(() => {
      expect(screen.getByText('feature/refreshed-branch-with-current-data')).toHaveClass('break-all');
      expect(screen.queryByText(branchRef)).not.toBeInTheDocument();
      expect(screen.getByText('Showing 1 of 3 loaded Git references.')).toBeInTheDocument();
    });

    view.rerenderTask(nextTaskId);
    const nextCheckbox = await screen.findByRole('checkbox', { name: 'Wrap Git reference text' });
    expect(nextCheckbox).not.toBeChecked();
    expect(screen.getByText('next-task-branch')).toHaveClass('truncate');
    expect(screen.getByText('Showing 1 of 1 loaded Git references.')).toBeInTheDocument();
  });

  it('keeps the control out of loading, error, and loaded-empty states', async () => {
    let resolveRead: ((response: { data: typeof refs }) => void) | undefined;
    api.get.mockReset().mockImplementationOnce(() => new Promise((resolve) => {
      resolveRead = resolve;
    }));
    const loading = renderRefs();
    expect(screen.getByText('Loading Git references…')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Wrap Git reference text' })).not.toBeInTheDocument();
    await act(async () => resolveRead?.({ data: refs }));
    expect(await screen.findByRole('checkbox', { name: 'Wrap Git reference text' })).toBeInTheDocument();
    loading.unmount();

    api.get.mockReset().mockRejectedValueOnce(new Error('Synthetic read failure'));
    const failed = renderRefs();
    expect(await screen.findByRole('alert')).toHaveTextContent('Git references are unavailable.');
    expect(screen.queryByRole('checkbox', { name: 'Wrap Git reference text' })).not.toBeInTheDocument();
    failed.unmount();

    api.get.mockReset().mockResolvedValueOnce({ data: [] });
    renderRefs();
    expect(await screen.findByText('No Git references.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Wrap Git reference text' })).not.toBeInTheDocument();
  });

  it('keeps the wrapping control available for a loaded list with no rows matching the selected kind', async () => {
    api.get.mockResolvedValueOnce({ data: [refs[0]] });
    renderRefs();
    const checkbox = await screen.findByRole('checkbox', { name: 'Wrap Git reference text' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Git reference kind' }), {
      target: { value: 'commit' },
    });

    expect(checkbox).toBeInTheDocument();
    expect(screen.getByText('Showing 0 of 1 loaded Git references.')).toBeInTheDocument();
    expect(screen.getByText(
      'No matching Git references in the loaded list. Choose All references to show more.',
    )).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});
