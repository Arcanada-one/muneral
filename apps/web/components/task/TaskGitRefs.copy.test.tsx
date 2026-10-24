import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskGitRefs } from './TaskGitRefs';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ default: api }));

const taskId = '11111111-1111-4111-8111-111111111111';
const nextTaskId = '22222222-2222-4222-8222-222222222222';
const fullBranchRef = 'release/long-feature-name-that-is-clipped-in-the-task-view';
const refs = [
  {
    id: '33333333-3333-4333-8333-333333333333', taskId, type: 'branch',
    url: 'https://github.com/example/repo/tree/release/long-feature-name',
    ref: fullBranchRef,
    createdAt: '2026-10-24T00:00:00.000Z',
  },
  {
    id: '44444444-4444-4444-8444-444444444444', taskId, type: 'repo',
    url: 'https://github.com/example/repo', ref: null,
    createdAt: '2026-10-23T00:00:00.000Z',
  },
];

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
      ? [{ ...refs[0], id: '55555555-5555-4555-8555-555555555555', taskId: nextTaskId, ref: 'next/branch' }]
      : refs,
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

describe('task Git reference copying', () => {
  it('copies the complete branch ref even when its rendered link text is clipped', async () => {
    const fullRef = fullBranchRef;
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    renderRefs();

    const copyButton = await screen.findByRole('button', {
      name: `Copy branch reference ${fullRef}`,
    });
    expect(screen.getByText(fullRef).className).toContain('truncate');
    expect(writeText).not.toHaveBeenCalled();

    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(fullRef);
    expect(await screen.findByRole('status')).toHaveTextContent('Git reference copied.');
  });

  it('copies the exact URL when a repository reference has no separate ref value', async () => {
    const repoUrl = refs[1].url;
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    renderRefs();

    fireEvent.click(await screen.findByRole('button', {
      name: `Copy repository reference ${repoUrl}`,
    }));

    expect(writeText).toHaveBeenCalledWith(repoUrl);
    expect(await screen.findByRole('status')).toHaveTextContent('Git reference copied.');
  });

  it('uses the same URL fallback when the stored ref is an empty string', async () => {
    const repoUrl = refs[1].url;
    vi.mocked(api.get).mockResolvedValueOnce({
      data: [{ ...refs[1], ref: '' }],
    } as never);
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    renderRefs();

    fireEvent.click(await screen.findByRole('button', {
      name: `Copy repository reference ${repoUrl}`,
    }));

    expect(writeText).toHaveBeenCalledWith(repoUrl);
  });

  it('reports clipboard failure without exposing browser details', async () => {
    const writeText = installClipboard(vi.fn().mockRejectedValue(new Error('Synthetic permission detail')));
    renderRefs();

    fireEvent.click(await screen.findByRole('button', {
      name: `Copy branch reference ${refs[0].ref}`,
    }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not copy Git reference. Try copying it manually.');
    expect(alert).not.toHaveTextContent('Synthetic permission detail');
  });

  it('prevents duplicate copy requests while the user-initiated clipboard call is pending', async () => {
    let finishCopy: (() => void) | undefined;
    const writeText = installClipboard(vi.fn(() => new Promise<void>((resolve) => {
      finishCopy = resolve;
    })));
    renderRefs();

    const copyButton = await screen.findByRole('button', {
      name: `Copy branch reference ${refs[0].ref}`,
    });
    fireEvent.click(copyButton);
    expect(copyButton).toBeDisabled();

    fireEvent.click(copyButton);
    expect(writeText).toHaveBeenCalledTimes(1);

    await act(async () => finishCopy?.());
    expect(await screen.findByRole('status')).toHaveTextContent('Git reference copied.');
  });

  it('does not show a late copy result after the same ref identity changes value', async () => {
    let finishCopy: (() => void) | undefined;
    const writeText = installClipboard(vi.fn(() => new Promise<void>((resolve) => {
      finishCopy = resolve;
    })));
    const view = renderRefs();

    fireEvent.click(await screen.findByRole('button', {
      name: `Copy branch reference ${refs[0].ref}`,
    }));
    expect(writeText).toHaveBeenCalledWith(refs[0].ref);

    view.client.setQueryData(['tasks', taskId, 'git-refs'], [
      { ...refs[0], ref: 'release/replaced-ref' },
      refs[1],
    ]);
    expect(await screen.findByRole('button', {
      name: 'Copy branch reference release/replaced-ref',
    })).toBeInTheDocument();

    await act(async () => finishCopy?.());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: 'Copy branch reference release/replaced-ref',
    })).toBeEnabled();
  });

  it('does not show a late copy result after switching to another task', async () => {
    let finishCopy: (() => void) | undefined;
    installClipboard(vi.fn(() => new Promise<void>((resolve) => {
      finishCopy = resolve;
    })));
    const view = renderRefs();

    fireEvent.click(await screen.findByRole('button', {
      name: `Copy branch reference ${refs[0].ref}`,
    }));
    view.rerenderTask(nextTaskId);
    expect(await screen.findByRole('button', { name: 'Copy branch reference next/branch' })).toBeInTheDocument();

    await act(async () => finishCopy?.());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy branch reference next/branch' })).toBeEnabled();
  });

  it('clears copy feedback when the displayed task changes', async () => {
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    const view = renderRefs();

    fireEvent.click(await screen.findByRole('button', {
      name: `Copy branch reference ${refs[0].ref}`,
    }));
    expect(await screen.findByRole('status')).toHaveTextContent('Git reference copied.');

    view.rerenderTask(nextTaskId);

    expect(await screen.findByRole('button', { name: 'Copy branch reference next/branch' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Copy branch reference ${refs[0].ref}` })).not.toBeInTheDocument();
    expect(writeText).toHaveBeenCalledTimes(1);
  });
});
