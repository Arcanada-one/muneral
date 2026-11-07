import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskGitRefs } from './TaskGitRefs';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ default: api }));

const taskId = '11111111-1111-4111-8111-111111111111';
const nextTaskId = '22222222-2222-4222-8222-222222222222';
const branchUrl = 'https://github.com/example/repo/tree/release/long-feature-name';
const nextBranchUrl = 'https://github.com/example/repo/tree/release/current-feature';
const branchRef = 'release/long-feature-name';
const branch = {
  id: '33333333-3333-4333-8333-333333333333',
  taskId,
  type: 'branch',
  url: branchUrl,
  ref: branchRef,
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
function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

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
        url: nextBranchUrl, ref: 'release/current-feature' }]
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

describe('task Git reference link copying', () => {
  it('copies the exact already-loaded safe URL while preserving its external link attributes', async () => {
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    renderRefs();

    const copyLinkButton = await screen.findByRole('button', {
      name: `Copy Git reference link for branch ${branchRef}`,
    });
    const referenceLink = screen.getByRole('link', { name: branchRef });
    expect(referenceLink).toHaveAttribute('href', branchUrl);
    expect(referenceLink).toHaveAttribute('target', '_blank');
    expect(referenceLink).toHaveAttribute('rel', 'noopener noreferrer');
    expect(writeText).not.toHaveBeenCalled();

    fireEvent.click(copyLinkButton);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(branchUrl);
    expect(await screen.findByRole('status')).toHaveTextContent('Git reference link copied.');
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('omits a redundant link-copy action when reference text already equals the URL or falls back to it', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      data: [
        { ...branch, ref: branchUrl },
        { ...repository, ref: '' },
      ],
    } as never);
    renderRefs();

    expect(await screen.findByRole('button', { name: `Copy branch reference ${branchUrl}` }))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Copy repository reference ${repository.url}` }))
      .toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy Git reference link/ }))
      .not.toBeInTheDocument();
  });

  it('does not offer copying for rejected URLs, loading data, errors, or an empty list', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      data: [{ ...branch, url: 'javascript:alert(1)' }],
    } as never);
    const rejectedUrlView = renderRefs();

    expect(await screen.findByText('Reference link unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy Git reference link/ })).not.toBeInTheDocument();
    rejectedUrlView.unmount();

    let rejectRequest: ((reason: Error) => void) | undefined;
    vi.mocked(api.get).mockReset().mockImplementationOnce(() => new Promise((_, reject) => {
      rejectRequest = reject;
    }));
    renderRefs();

    expect(screen.getByText('Loading Git references…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy Git reference link/ })).not.toBeInTheDocument();
    await act(async () => rejectRequest?.(new Error('synthetic request failure')));
    expect(await screen.findByText('Git references are unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy Git reference link/ })).not.toBeInTheDocument();

    cleanup();
    vi.mocked(api.get).mockReset().mockResolvedValueOnce({ data: [] } as never);
    renderRefs();
    expect(await screen.findByText('No Git references.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy Git reference link/ })).not.toBeInTheDocument();
  });

  it('reports a generic failure when clipboard access is absent or rejected', async () => {
    Reflect.deleteProperty(navigator, 'clipboard');
    renderRefs();

    fireEvent.click(await screen.findByRole('button', {
      name: `Copy Git reference link for branch ${branchRef}`,
    }));
    const missingClipboardAlert = await screen.findByRole('alert');
    expect(missingClipboardAlert).toHaveTextContent(
      'Could not copy Git reference link. Try copying the link manually.',
    );

    cleanup();
    installClipboard(vi.fn().mockRejectedValue(new Error('Synthetic permission detail')));
    renderRefs();
    fireEvent.click(await screen.findByRole('button', {
      name: `Copy Git reference link for branch ${branchRef}`,
    }));
    const rejectedClipboardAlert = await screen.findByRole('alert');
    expect(rejectedClipboardAlert).toHaveTextContent(
      'Could not copy Git reference link. Try copying the link manually.',
    );
    expect(rejectedClipboardAlert).not.toHaveTextContent('Synthetic permission detail');
  });

  it('blocks a duplicate click while the permalink copy is pending', async () => {
    let finishCopy: (() => void) | undefined;
    const writeText = installClipboard(vi.fn(() => new Promise<void>((resolve) => {
      finishCopy = resolve;
    })));
    renderRefs();

    const button = await screen.findByRole('button', {
      name: `Copy Git reference link for branch ${branchRef}`,
    });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(branchUrl);

    await act(async () => finishCopy?.());
    expect(await screen.findByRole('status')).toHaveTextContent('Git reference link copied.');
  });

  it.each([
    {
      identity: 'reference',
      replace: (view: ReturnType<typeof renderRefs>) => view.client.setQueryData(
        ['tasks', taskId, 'git-refs'],
        [{ ...branch, id: '66666666-6666-4666-8666-666666666666' }, repository],
      ),
      nextLabel: `Copy Git reference link for branch ${branchRef}`,
      nextUrl: branchUrl,
    },
    {
      identity: 'URL',
      replace: (view: ReturnType<typeof renderRefs>) => view.client.setQueryData(
        ['tasks', taskId, 'git-refs'],
        [{ ...branch, url: nextBranchUrl }, repository],
      ),
      nextLabel: `Copy Git reference link for branch ${branchRef}`,
      nextUrl: nextBranchUrl,
    },
    {
      identity: 'task',
      replace: (view: ReturnType<typeof renderRefs>) => view.rerenderTask(nextTaskId),
      nextLabel: 'Copy Git reference link for branch release/current-feature',
      nextUrl: nextBranchUrl,
    },
  ])('discards a late completion after the $identity identity changes and copies current data next', async ({
    replace,
    nextLabel,
    nextUrl,
  }) => {
    const pendingCopies: Array<() => void> = [];
    const writeText = installClipboard(vi.fn(() => new Promise<void>((resolve) => {
      pendingCopies.push(resolve);
    })));
    const view = renderRefs();

    fireEvent.click(await screen.findByRole('button', {
      name: `Copy Git reference link for branch ${branchRef}`,
    }));
    expect(writeText).toHaveBeenNthCalledWith(1, branchUrl);

    await act(async () => replace(view));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: nextLabel })).toBeEnabled();
    });
    await act(async () => pendingCopies[0]?.());

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    const currentButton = screen.getByRole('button', { name: nextLabel });
    expect(currentButton).toBeEnabled();
    fireEvent.click(currentButton);
    expect(writeText).toHaveBeenNthCalledWith(2, nextUrl);
    expect(api.get).toHaveBeenCalledTimes(nextLabel.includes('current-feature') ? 2 : 1);

    await act(async () => pendingCopies[1]?.());
    expect(await screen.findByRole('status')).toHaveTextContent('Git reference link copied.');
  });
});
