import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskGitRefs } from './TaskGitRefs';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ default: api }));

const taskId = '11111111-1111-4111-8111-111111111111';
const refs = [
  { id: '33333333-3333-4333-8333-333333333333', taskId, type: 'repo', url: 'https://github.com/example/repo', ref: 'example/repo', createdAt: '2026-11-01T00:00:00.000Z' },
  { id: '44444444-4444-4444-8444-444444444444', taskId, type: 'branch', url: 'https://user:secret@example.com/private', ref: 'private/credential-ref', createdAt: '2026-11-01T00:01:00.000Z' },
  { id: '55555555-5555-4555-8555-555555555555', taskId, type: 'commit', url: 'https://', ref: 'missing-ref', createdAt: '2026-11-01T00:02:00.000Z' },
  { id: '66666666-6666-4666-8666-666666666666', taskId, type: 'branch', url: 'javascript:alert(1)', ref: 'unsafe-ref', createdAt: '2026-11-01T00:03:00.000Z' },
  { id: '99999999-9999-4999-8999-999999999999', taskId, type: 'branch', url: 'https://user:secret@example.com/private', ref: 'private/credential-ref', createdAt: '2026-11-01T00:03:30.000Z' },
  { id: '77777777-7777-4777-8777-777777777777', taskId, type: 'branch', url: 'https://github.com/example/repo/tree/feature/safe', ref: 'feature/safe', createdAt: '2026-11-01T00:04:00.000Z' },
  { id: '88888888-8888-4888-8888-888888888888', taskId, type: 'branch', url: 'https://github.com/example/repo/tree/feature/safe', ref: 'feature/safe', createdAt: '2026-11-01T00:05:00.000Z' },
];

function renderRefs() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <TaskGitRefs taskId={taskId} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

beforeEach(() => {
  api.get.mockReset().mockResolvedValue({ data: refs });
  for (const method of [api.post, api.put, api.patch, api.delete]) method.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('task Git reference unavailable-only view', () => {
  it('filters only the loaded rows rejected by the existing safe URL guard without exposing their data', async () => {
    renderRefs();
    const unavailable = await screen.findByRole('checkbox', { name: 'Show unavailable links only' });
    expect(unavailable).not.toBeChecked();
    expect(screen.getByText('Showing 7 of 7 loaded Git references.')).toBeInTheDocument();

    fireEvent.click(unavailable);
    expect(screen.getByText('Showing 4 of 7 loaded Git references.')).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Visible reference kinds' })).toHaveTextContent('Repositories 0; Branches 3; Commits 1');
    expect(screen.getAllByRole('alert').map((item) => item.textContent)).toEqual([
      'Reference link unavailable', 'Reference link unavailable', 'Reference link unavailable', 'Reference link unavailable',
    ]);
    expect(screen.queryByText(/credential-ref|secret|unsafe-ref|missing-ref/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy 0 available Git reference links' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copy 0 available Git reference values' })).toBeDisabled();

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.post).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('safely excludes an empty URL in a changed loaded cache snapshot', async () => {
    const view = renderRefs();
    await screen.findByRole('checkbox', { name: 'Show unavailable links only' });
    await act(async () => {
      view.client.setQueryData(['tasks', taskId, 'git-refs'], [
        ...refs,
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', taskId, type: 'commit', url: '', ref: 'empty-url-ref', createdAt: '2026-11-01T00:06:00.000Z' },
      ]);
    });
    await waitFor(() => expect(screen.getByText('Showing 8 of 8 loaded Git references.')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show unavailable links only' }));
    expect(screen.getByText('Showing 5 of 8 loaded Git references.')).toBeInTheDocument();
    expect(screen.queryByText('empty-url-ref')).not.toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.post).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('keeps availability filters exclusive and reset clears filters while preserving view preferences', async () => {
    renderRefs();
    const unavailable = await screen.findByRole('checkbox', { name: 'Show unavailable links only' });
    const available = screen.getByRole('checkbox', { name: 'Show available links only' });
    const reverse = screen.getByRole('checkbox', { name: 'Reverse loaded order' });
    const wrap = screen.getByRole('checkbox', { name: 'Wrap Git reference text' });
    const kind = screen.getByRole('combobox', { name: 'Git reference kind' });

    fireEvent.click(unavailable);
    expect(available).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Reset Git reference filters' })).toBeEnabled();
    fireEvent.click(available);
    expect(unavailable).not.toBeChecked();
    fireEvent.change(kind, { target: { value: 'branch' } });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded Git references' }), { target: { value: 'feature' } });
    fireEvent.click(reverse);
    fireEvent.click(wrap);

    fireEvent.click(screen.getByRole('button', { name: 'Reset Git reference filters' }));
    expect(kind).toHaveValue('all');
    expect(screen.getByRole('searchbox', { name: 'Search loaded Git references' })).toHaveValue('');
    expect(available).not.toBeChecked();
    expect(unavailable).not.toBeChecked();
    expect(reverse).toBeChecked();
    expect(wrap).toBeChecked();
    expect(screen.getByRole('button', { name: 'Reset Git reference filters' })).toBeDisabled();
  });

  it('composes kind, search and reverse over unavailable rows in loaded order and retains duplicate rows', async () => {
    renderRefs();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Show unavailable links only' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Git reference kind' }), { target: { value: 'branch' } });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded Git references' }), { target: { value: 'unavailable' } });
    expect(screen.getByText('Showing 3 of 7 loaded Git references.')).toBeInTheDocument();
    expect(screen.getAllByRole('alert')).toHaveLength(3);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Reverse loaded order' }));
    expect(screen.getAllByRole('alert')).toHaveLength(3);
    expect(screen.getByText('Showing 3 of 7 loaded Git references.')).toBeInTheDocument();
  });

  it('clears stale batch feedback on selection changes and follows refresh, empty and A-B-A views', async () => {
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const view = renderRefs();
    const copy = await screen.findByRole('button', { name: 'Copy 3 available Git reference links' });
    fireEvent.click(copy);
    expect(await screen.findByText('Available Git reference links copied.')).toBeInTheDocument();
    const unavailable = screen.getByRole('checkbox', { name: 'Show unavailable links only' });
    fireEvent.click(unavailable);
    expect(screen.queryByText('Available Git reference links copied.')).not.toBeInTheDocument();
    fireEvent.click(unavailable);
    expect(screen.getByRole('button', { name: 'Copy 3 available Git reference links' })).toBeInTheDocument();
    fireEvent.click(unavailable);

    await waitFor(() => expect(view.client.getQueryState(['tasks', taskId, 'git-refs'])?.status).toBe('success'));
    await act(async () => {
      view.client.setQueryData(['tasks', taskId, 'git-refs'], []);
    });
    expect(await screen.findByText('No Git references.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy 0 available Git reference links' })).toBeDisabled();
    await act(async () => {
      view.client.setQueryData(['tasks', taskId, 'git-refs'], refs);
    });
    expect(await screen.findByRole('checkbox', { name: 'Show unavailable links only' })).toBeChecked();
    expect(screen.getByText('Showing 4 of 7 loaded Git references.')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledTimes(1);

    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
  });
});
