import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskGitRefs } from './TaskGitRefs';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ default: api }));

const taskId = '11111111-1111-4111-8111-111111111111';
const nextTaskId = '22222222-2222-4222-8222-222222222222';
const firstUrl = 'https://github.com/example/first/tree/release/one';
const secondUrl = 'https://github.com/example/second/tree/release/two';
const repoUrl = 'https://github.com/example/repository';
const refs = [
  {
    id: '33333333-3333-4333-8333-333333333333', taskId, type: 'branch',
    url: firstUrl, ref: 'release/one', createdAt: '2026-11-01T00:00:00.000Z',
  },
  {
    id: '44444444-4444-4444-8444-444444444444', taskId, type: 'branch',
    url: secondUrl, ref: 'release/two', createdAt: '2026-11-02T00:00:00.000Z',
  },
  {
    id: '55555555-5555-4555-8555-555555555555', taskId, type: 'branch',
    url: firstUrl, ref: 'release/one-copy', createdAt: '2026-11-03T00:00:00.000Z',
  },
  {
    id: '66666666-6666-4666-8666-666666666666', taskId, type: 'repo',
    url: repoUrl, ref: null, createdAt: '2026-11-04T00:00:00.000Z',
  },
  {
    id: '77777777-7777-4777-8777-777777777777', taskId, type: 'commit',
    url: 'javascript:private-url-marker', ref: 'private-ref-marker',
    createdAt: '2026-11-05T00:00:00.000Z',
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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
      ? [{ ...refs[0], id: '88888888-8888-4888-8888-888888888888', taskId: nextTaskId,
        ref: 'next/release', url: 'https://github.com/example/next/tree/release/current' }]
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

describe('copying available loaded Git reference links', () => {
  it('copies safe links after kind and search filtering, in displayed order, retaining duplicates', async () => {
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    renderRefs();

    const button = await screen.findByRole('button', { name: 'Copy 4 available Git reference links' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Git reference kind' }), {
      target: { value: 'branch' },
    });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded Git references' }), {
      target: { value: 'release' },
    });

    expect(screen.getByText('Showing 3 of 5 loaded Git references.')).toBeInTheDocument();
    const copyButton = screen.getByRole('button', { name: 'Copy 3 available Git reference links' });
    expect(copyButton).toBeEnabled();
    expect(writeText).not.toHaveBeenCalled();

    fireEvent.click(copyButton);

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(`${firstUrl}\n${secondUrl}\n${firstUrl}`);
    expect(await screen.findByRole('status')).toHaveTextContent('Available Git reference links copied.');
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('disables the batch action at zero safe visible links without exposing rejected values', async () => {
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    renderRefs();

    fireEvent.change(await screen.findByRole('combobox', { name: 'Git reference kind' }), {
      target: { value: 'commit' },
    });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded Git references' }), {
      target: { value: 'Reference link unavailable' },
    });

    expect(screen.getByText('Showing 1 of 5 loaded Git references.')).toBeInTheDocument();
    expect(screen.getByText('Reference link unavailable')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('private-url-marker');
    expect(document.body).not.toHaveTextContent('private-ref-marker');
    const copyButton = screen.getByRole('button', { name: 'Copy 0 available Git reference links' });
    expect(copyButton).toBeDisabled();

    fireEvent.click(copyButton);
    expect(writeText).not.toHaveBeenCalled();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('keeps the empty-list message and exposes a disabled zero-link action', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ data: [] } as never);
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    renderRefs();

    expect(await screen.findByText('No Git references.')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Copy 0 available Git reference links' });
    expect(button).toBeDisabled();

    fireEvent.click(button);
    expect(writeText).not.toHaveBeenCalled();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('shows success only after clipboard completion and blocks synchronous reentry', async () => {
    let finishCopy: (() => void) | undefined;
    const writeText = installClipboard(vi.fn(() => new Promise<void>((resolve) => {
      finishCopy = resolve;
    })));
    renderRefs();

    const button = await screen.findByRole('button', { name: 'Copy 4 available Git reference links' });
    fireEvent.click(button);

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith(`${firstUrl}\n${secondUrl}\n${firstUrl}\n${repoUrl}`);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy 4 available Git reference links' })).toBeDisabled();

    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledOnce();

    await act(async () => finishCopy?.());
    expect(await screen.findByRole('status')).toHaveTextContent('Available Git reference links copied.');
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('reports clipboard rejection generically and recovers for a retry', async () => {
    const writeText = installClipboard(vi.fn()
      .mockRejectedValueOnce(new Error('Synthetic private clipboard detail'))
      .mockResolvedValueOnce(undefined));
    renderRefs();

    const button = await screen.findByRole('button', { name: 'Copy 4 available Git reference links' });
    fireEvent.click(button);

    const alert = await screen.findByText('Could not copy available Git reference links. Try again.');
    expect(alert).toHaveTextContent('Could not copy available Git reference links. Try again.');
    expect(alert).not.toHaveTextContent('Synthetic private clipboard detail');
    expect(writeText).toHaveBeenCalledTimes(1);

    fireEvent.click(button);
    expect(await screen.findByRole('status')).toHaveTextContent('Available Git reference links copied.');
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it('reports an unavailable clipboard generically', async () => {
    Reflect.deleteProperty(navigator, 'clipboard');
    renderRefs();

    fireEvent.click(await screen.findByRole('button', { name: 'Copy 4 available Git reference links' }));

    const alert = await screen.findByText('Could not copy available Git reference links. Try again.');
    expect(alert).toHaveTextContent('Could not copy available Git reference links. Try again.');
    expect(alert).not.toHaveTextContent('private-url-marker');
  });

  it('clears settled feedback when the visible filters change', async () => {
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    renderRefs();

    fireEvent.click(await screen.findByRole('button', { name: 'Copy 4 available Git reference links' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Available Git reference links copied.');

    fireEvent.change(screen.getByRole('combobox', { name: 'Git reference kind' }), {
      target: { value: 'repo' },
    });

    expect(screen.getByRole('button', { name: 'Copy 1 available Git reference links' })).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(writeText).toHaveBeenCalledOnce();
  });

  it('discards a late success across an A-B-A filter change', async () => {
    let finishCopy: (() => void) | undefined;
    const writeText = installClipboard(vi.fn(() => new Promise<void>((resolve) => {
      finishCopy = resolve;
    })));
    renderRefs();
    const kind = await screen.findByRole('combobox', { name: 'Git reference kind' });

    fireEvent.click(screen.getByRole('button', { name: 'Copy 4 available Git reference links' }));
    fireEvent.change(kind, { target: { value: 'repo' } });
    expect(screen.getByRole('button', { name: 'Copy 1 available Git reference links' })).toBeEnabled();
    fireEvent.change(kind, { target: { value: 'all' } });
    expect(screen.getByRole('button', { name: 'Copy 4 available Git reference links' })).toBeEnabled();

    await act(async () => finishCopy?.());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy 4 available Git reference links' })).toBeEnabled();
    expect(writeText).toHaveBeenCalledOnce();
  });

  it('discards a late rejection after loaded references change for the same task', async () => {
    let rejectCopy: ((reason?: unknown) => void) | undefined;
    const writeText = installClipboard(vi.fn(() => new Promise<void>((_, reject) => {
      rejectCopy = reject;
    })));
    const view = renderRefs();
    const button = await screen.findByRole('button', { name: 'Copy 4 available Git reference links' });
    fireEvent.click(button);

    view.client.setQueryData(['tasks', taskId, 'git-refs'], [
      { ...refs[0], url: 'https://github.com/example/replaced/tree/main', ref: 'main' },
    ]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy 1 available Git reference links' })).toBeEnabled());

    await act(async () => rejectCopy?.(new Error('Synthetic private rejection')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy 1 available Git reference links' })).toBeEnabled();
    expect(writeText).toHaveBeenCalledOnce();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('discards a late result after switching tasks and binds the next copy to the new loaded refs', async () => {
    let finishCopy: (() => void) | undefined;
    const writeText = installClipboard(vi.fn(() => new Promise<void>((resolve) => {
      finishCopy = resolve;
    })));
    const view = renderRefs();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy 4 available Git reference links' }));

    view.rerenderTask(nextTaskId);
    const nextButton = await screen.findByRole('button', { name: 'Copy 1 available Git reference links' });
    await act(async () => finishCopy?.());

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(nextButton).toBeEnabled();
    fireEvent.click(nextButton);
    expect(writeText).toHaveBeenNthCalledWith(2, 'https://github.com/example/next/tree/release/current');
    await act(async () => finishCopy?.());
    expect(await screen.findByRole('status')).toHaveTextContent('Available Git reference links copied.');
    expect(api.get).toHaveBeenCalledTimes(2);
  });
});
