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
const taskRef = {
  id: '33333333-3333-4333-8333-333333333333',
  taskId,
  type: 'branch',
  url: 'https://github.com/example/repo/tree/current-branch',
  ref: 'current-branch',
  createdAt: '2026-10-25T00:00:00.000Z',
};
const nextTaskRef = {
  ...taskRef,
  id: '44444444-4444-4444-8444-444444444444',
  taskId: nextTaskId,
  url: 'https://github.com/example/other/tree/next-branch',
  ref: 'next-branch',
};

function renderRefs(currentTaskId = taskId) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  const view = render(<TaskGitRefs taskId={currentTaskId} />, { wrapper: Wrapper });
  return {
    ...view,
    rerenderTask: (id: string) => view.rerender(<TaskGitRefs taskId={id} />),
  };
}

beforeEach(() => api.get.mockReset());

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('task Git reference read recovery', () => {
  it('retries the same task-scoped read and renders its validated response', async () => {
    api.get.mockRejectedValueOnce(new Error('Synthetic private server detail'));
    api.get.mockResolvedValueOnce({ data: [taskRef] });
    renderRefs();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Git references are unavailable.');
    expect(alert).not.toHaveTextContent('Synthetic private server detail');
    fireEvent.click(screen.getByRole('button', { name: 'Retry Git references' }));

    expect(api.get).toHaveBeenLastCalledWith(`/projects/tasks/${taskId}/git-refs`);
    expect(await screen.findByText('current-branch')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the existing loading state during refetch and prevents duplicate requests', async () => {
    let resolveRetry: ((response: { data: (typeof taskRef)[] }) => void) | undefined;
    api.get.mockRejectedValueOnce(new Error('Synthetic read failure'));
    api.get.mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }));
    renderRefs();

    await screen.findByRole('alert');
    const retry = screen.getByRole('button', { name: 'Retry Git references' });
    fireEvent.click(retry);

    expect(await screen.findByText('Loading Git references…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry Git references' })).not.toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(2);

    await act(async () => resolveRetry?.({ data: [taskRef] }));
    expect(await screen.findByText('current-branch')).toBeInTheDocument();
  });

  it('does not render a late retry result after switching to another task', async () => {
    let resolveOldRetry: ((response: { data: (typeof taskRef)[] }) => void) | undefined;
    api.get.mockRejectedValueOnce(new Error('Synthetic read failure'));
    api.get.mockImplementationOnce(() => new Promise((resolve) => { resolveOldRetry = resolve; }));
    api.get.mockResolvedValueOnce({ data: [nextTaskRef] });
    const view = renderRefs();

    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Retry Git references' }));
    view.rerenderTask(nextTaskId);

    expect(await screen.findByText('next-branch')).toBeInTheDocument();
    await act(async () => resolveOldRetry?.({ data: [taskRef] }));
    expect(screen.queryByText('current-branch')).not.toBeInTheDocument();
    expect(screen.getByText('next-branch')).toBeInTheDocument();
    expect(api.get).toHaveBeenNthCalledWith(3, `/projects/tasks/${nextTaskId}/git-refs`);
  });

  it('keeps a successful empty response distinct from a read error', async () => {
    api.get.mockResolvedValueOnce({ data: [] });
    renderRefs();

    expect(await screen.findByText('No Git references.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry Git references' })).not.toBeInTheDocument();
  });
});
