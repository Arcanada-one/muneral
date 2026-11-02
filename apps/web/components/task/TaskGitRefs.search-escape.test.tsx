import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskGitRefs } from './TaskGitRefs';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ default: api }));

const taskId = '11111111-1111-4111-8111-111111111111';
const branchUrl = 'https://github.com/example/repo/tree/release/long-feature-name';
const rows = [
  {
    id: '33333333-3333-4333-8333-333333333333',
    taskId,
    type: 'branch',
    url: branchUrl,
    ref: 'release/long-feature-name',
    createdAt: '2026-10-24T00:00:00.000Z',
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    taskId,
    type: 'repo',
    url: 'https://github.com/example/repo',
    ref: null,
    createdAt: '2026-10-23T00:00:00.000Z',
  },
];

function renderRefs(onParentKeyDown = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <div onKeyDown={onParentKeyDown}>
        <TaskGitRefs taskId={taskId} />
      </div>
    </QueryClientProvider>,
  );
  return { ...view, onParentKeyDown };
}

let originalClipboard: PropertyDescriptor | undefined;

beforeEach(() => {
  api.get.mockReset().mockResolvedValue({ data: rows });
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
});

afterEach(() => {
  cleanup();
  if (originalClipboard) {
    Object.defineProperty(navigator, 'clipboard', originalClipboard);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
  originalClipboard = undefined;
  vi.restoreAllMocks();
});

describe('TaskGitRefs search Escape recovery', () => {
  it('clears a nonempty query only, keeps focus and other filters, and performs no extra I/O', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const view = renderRefs();
    const search = await screen.findByRole('searchbox', { name: 'Search loaded Git references' });
    expect(search).toHaveAttribute('aria-keyshortcuts', 'Escape');
    expect(search).toHaveAccessibleDescription('Press Escape to clear search.');
    fireEvent.change(screen.getByRole('combobox', { name: 'Git reference kind' }), {
      target: { value: 'repo' },
    });
    fireEvent.change(search, { target: { value: 'long-feature-name' } });
    expect(screen.getByText('Showing 0 of 2 loaded Git references.')).toBeInTheDocument();
    search.focus();

    const handled = fireEvent.keyDown(search, { key: 'Escape' });

    expect(handled).toBe(false);
    expect(view.onParentKeyDown).not.toHaveBeenCalled();
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(screen.getByRole('combobox', { name: 'Git reference kind' })).toHaveValue('repo');
    expect(screen.getByText('Showing 1 of 2 loaded Git references.')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith(`/projects/tasks/${taskId}/git-refs`);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('clears whitespace-only raw input while consuming plain Escape in the input', async () => {
    renderRefs();
    const search = await screen.findByRole('searchbox', { name: 'Search loaded Git references' });
    fireEvent.change(search, { target: { value: '   ' } });
    expect(search).toHaveValue('   ');
    search.focus();

    expect(fireEvent.keyDown(search, { key: 'Escape' })).toBe(false);
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(screen.getByText('Showing 2 of 2 loaded Git references.')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('leaves empty, composing, modified and unrelated Escape events untouched', async () => {
    const view = renderRefs();
    const search = await screen.findByRole('searchbox', { name: 'Search loaded Git references' });

    expect(fireEvent.keyDown(search, { key: 'Escape' })).toBe(true);
    expect(view.onParentKeyDown).toHaveBeenCalledTimes(1);
    fireEvent.change(search, { target: { value: 'release' } });

    view.onParentKeyDown.mockClear();
    expect(fireEvent.keyDown(search, { key: 'Escape', isComposing: true })).toBe(true);
    expect(view.onParentKeyDown).toHaveBeenCalledTimes(1);
    expect(search).toHaveValue('release');

    for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) {
      view.onParentKeyDown.mockClear();
      expect(fireEvent.keyDown(search, { key: 'Escape', [modifier]: true })).toBe(true);
      expect(view.onParentKeyDown).toHaveBeenCalledTimes(1);
      expect(search).toHaveValue('release');
    }

    view.onParentKeyDown.mockClear();
    expect(fireEvent.keyDown(search, { key: 'Enter' })).toBe(true);
    expect(view.onParentKeyDown).toHaveBeenCalledTimes(1);
    view.onParentKeyDown.mockClear();
    expect(fireEvent.keyDown(view.container.querySelector('div')!, { key: 'Escape' })).toBe(true);
    expect(view.onParentKeyDown).toHaveBeenCalledTimes(1);
    expect(search).toHaveValue('release');
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});
