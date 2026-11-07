import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import apiClient from '@/lib/api/client';
import { TaskDependencies } from './TaskDependencies';

const taskId = '11111111-1111-4111-8111-111111111111';

type DependencyFixture = {
  id: string;
  type: string;
  direction: 'incoming' | 'outgoing';
  fromTaskId: string;
  toTaskId: string;
  otherTaskId: string;
  otherTaskTitle: string;
  otherTaskStatus: string;
};

function dependency(
  id: string,
  otherTaskId: string,
  title: string,
  status: string,
  direction: 'incoming' | 'outgoing' = 'incoming',
): DependencyFixture {
  return {
    id,
    type: 'depends_on',
    direction,
    fromTaskId: direction === 'outgoing' ? taskId : otherTaskId,
    toTaskId: direction === 'outgoing' ? otherTaskId : taskId,
    otherTaskId,
    otherTaskTitle: title,
    otherTaskStatus: status,
  };
}

function mountDependencies(rows: DependencyFixture[], onParentKeyDown = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(['tasks', taskId, 'dependency-graph'], rows);
  const view = render(
    <div onKeyDown={onParentKeyDown}>
      <QueryClientProvider client={queryClient}>
        <TaskDependencies taskId={taskId} />
      </QueryClientProvider>
    </div>,
  );
  return { ...view, queryClient, onParentKeyDown };
}

function loadedRows() {
  return [
    dependency('dep-alpha', '22222222-2222-4222-8222-222222222222', 'Alpha', 'todo'),
    dependency('dep-beta', '33333333-3333-4333-8333-333333333333', 'Beta', 'done', 'outgoing'),
    dependency('dep-gamma', '44444444-4444-4444-8444-444444444444', 'Gamma', 'todo', 'outgoing'),
    dependency('dep-delta', '55555555-5555-4555-8555-555555555555', 'Delta', 'todo', 'outgoing'),
  ];
}

function searchInput() {
  return screen.getByRole('textbox', { name: 'Search loaded dependencies' });
}

function idCopyButton(count: number) {
  return screen.getByRole('button', { name: `Copy visible dependency task IDs (${count})` });
}

function titleCopyButton(count: number) {
  return screen.getByRole('button', { name: `Copy available dependency titles (${count})` });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

beforeEach(() => {
  vi.spyOn(apiClient, 'get').mockResolvedValue({ data: [] } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

describe('Escape in the loaded dependency search', () => {
  it('clears a nonempty query, keeps focus, and stops the same key from reaching a parent handler', () => {
    mountDependencies(loadedRows());
    const search = searchInput();
    expect(search).toHaveAttribute('aria-keyshortcuts', 'Escape');
    expect(search).toHaveAccessibleDescription('Press Escape to clear search.');
    expect(screen.getByText('Press Escape to clear search.')).toBeVisible();

    fireEvent.change(search, { target: { value: 'Alpha' } });
    search.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });

    let dispatchResult = true;
    act(() => {
      dispatchResult = search.dispatchEvent(event);
    });
    expect(dispatchResult).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(searchInput()).toBe(search);
    expect(search).toHaveValue('');
    expect(document.activeElement).toBe(search);
    expect(screen.getByText('Showing 4 of 4 loaded dependencies.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Show all loaded dependencies' })).toBeDisabled();
  });

  it('clears whitespace in the raw query while preserving the other filters, row order, and row disclosure', () => {
    const rows = loadedRows();
    const { queryClient } = mountDependencies(rows);
    fireEvent.change(screen.getByRole('combobox', { name: 'Dependency direction' }), {
      target: { value: 'outgoing' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide completed dependencies' }));
    const search = searchInput();
    fireEvent.change(search, { target: { value: 'Gamma' } });
    const gammaRow = screen.getByText('Gamma').closest('li');
    expect(gammaRow).not.toBeNull();
    fireEvent.click(within(gammaRow as HTMLElement).getByRole('button', { name: 'Show full task ID' }));
    search.focus();

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      search.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(search).toHaveValue('');
    expect(document.activeElement).toBe(search);
    expect(screen.getByRole('combobox', { name: 'Dependency direction' })).toHaveValue('outgoing');
    expect(screen.getByRole('checkbox', { name: 'Hide completed dependencies' })).toBeChecked();
    expect(screen.getByText('Showing 2 of 4 loaded dependencies.')).toBeInTheDocument();
    const list = screen.getByRole('list');
    const listText = list.textContent ?? '';
    expect(listText.indexOf('Gamma')).toBeLessThan(listText.indexOf('Delta'));
    expect(within(list).queryByText('Alpha')).not.toBeInTheDocument();
    expect(within(list).queryByText('Beta')).not.toBeInTheDocument();
    expect(within(gammaRow as HTMLElement).getByText('44444444-4444-4444-8444-444444444444')).toBeInTheDocument();
    expect(within(gammaRow as HTMLElement).getByRole('button', { name: 'Hide full task ID' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(gammaRow as HTMLElement).getByRole('button', {
      name: 'Copy task ID 44444444-4444-4444-8444-444444444444',
    })).toBeInTheDocument();
    expect(queryClient.getQueryData(['tasks', taskId, 'dependency-graph'])).toBe(rows);
  });

  it('clears a whitespace-only raw query even though it currently matches every loaded row', () => {
    mountDependencies(loadedRows());
    const search = searchInput();
    fireEvent.change(search, { target: { value: '   ' } });
    expect(search).toHaveValue('   ');

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      search.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(search).toHaveValue('');
    expect(screen.getByText('Showing 4 of 4 loaded dependencies.')).toBeInTheDocument();
  });

  it.each([
    ['empty query', '', {}],
    ['IME composition', 'Alpha', { isComposing: true }],
    ['Shift modifier', 'Alpha', { shiftKey: true }],
    ['Control modifier', 'Alpha', { ctrlKey: true }],
    ['Alt modifier', 'Alpha', { altKey: true }],
    ['Meta modifier', 'Alpha', { metaKey: true }],
    ['unrelated key', 'Alpha', { key: 'Enter' }],
  ])('does not intercept %s', (_case, query, options) => {
    const onParentKeyDown = vi.fn();
    mountDependencies(loadedRows(), onParentKeyDown);
    const search = searchInput();
    fireEvent.change(search, { target: { value: query } });
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
      ...options,
    });

    act(() => {
      search.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(onParentKeyDown).toHaveBeenCalledTimes(1);
    expect(search).toHaveValue(query);
  });

  it('does not intercept Escape outside the search input or add request and browser side effects', () => {
    const onParentKeyDown = vi.fn();
    mountDependencies(loadedRows(), onParentKeyDown);
    const search = searchInput();
    fireEvent.change(search, { target: { value: 'Alpha' } });
    const get = vi.mocked(apiClient.get);
    get.mockClear();
    const mutations = [
      vi.spyOn(apiClient, 'post'),
      vi.spyOn(apiClient, 'put'),
      vi.spyOn(apiClient, 'patch'),
      vi.spyOn(apiClient, 'delete'),
    ];
    mutations.forEach((mutation) => mutation.mockClear());
    const fetchCall = vi.fn();
    vi.stubGlobal('fetch', fetchCall);
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const storageSet = vi.spyOn(Storage.prototype, 'setItem');
    const storageRemove = vi.spyOn(Storage.prototype, 'removeItem');
    const navigation = vi.spyOn(history, 'pushState');
    const outside = screen.getByRole('button', { name: 'Clear search' });
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });

    outside.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(onParentKeyDown).toHaveBeenCalledTimes(1);
    expect(search).toHaveValue('Alpha');
    expect(get).not.toHaveBeenCalled();
    expect(mutations.every((mutation) => mutation.mock.calls.length === 0)).toBe(true);
    expect(fetchCall).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();
    expect(storageRemove).not.toHaveBeenCalled();
    expect(navigation).not.toHaveBeenCalled();
  });

  it('invalidates both pending bulk-copy results when Escape clears a query, including an ABA return', async () => {
    const oldIdWrite = deferred<void>();
    const oldTitleWrite = deferred<void>();
    const writeText = vi.fn()
      .mockReturnValueOnce(oldIdWrite.promise)
      .mockReturnValueOnce(oldTitleWrite.promise)
      .mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mountDependencies([
      dependency('dep-alpha', '22222222-2222-4222-8222-222222222222', 'Alpha title', 'todo'),
      dependency('dep-beta', '33333333-3333-4333-8333-333333333333', 'Beta title', 'todo'),
    ]);
    const search = searchInput();
    fireEvent.change(search, { target: { value: 'Alpha' } });
    fireEvent.click(idCopyButton(1));
    fireEvent.click(titleCopyButton(1));
    expect(idCopyButton(1)).toBeDisabled();
    expect(titleCopyButton(1)).toBeDisabled();
    expect(writeText).toHaveBeenNthCalledWith(1, '22222222-2222-4222-8222-222222222222');
    expect(writeText).toHaveBeenNthCalledWith(2, 'Alpha title');

    search.focus();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      search.dispatchEvent(event);
    });
    expect(search).toHaveValue('');
    fireEvent.change(search, { target: { value: 'Alpha' } });
    expect(idCopyButton(1)).toBeEnabled();
    expect(titleCopyButton(1)).toBeEnabled();

    await act(async () => {
      oldIdWrite.resolve();
      oldTitleWrite.reject(new Error('stale private clipboard failure'));
      await Promise.allSettled([oldIdWrite.promise, oldTitleWrite.promise]);
    });
    expect(screen.queryByText('Dependency task IDs copied.')).not.toBeInTheDocument();
    expect(screen.queryByText('Dependency titles copied.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(idCopyButton(1));
    fireEvent.click(titleCopyButton(1));
    await waitFor(() => {
      expect(screen.getByText('Dependency task IDs copied.')).toBeInTheDocument();
      expect(screen.getByText('Dependency titles copied.')).toBeInTheDocument();
    }, { timeout: 10000 });
    expect(writeText).toHaveBeenCalledTimes(4);
  }, 20000);

  it('also suppresses a rejected ID copy and successful title copy resolved after Escape', async () => {
    const oldIdWrite = deferred<void>();
    const oldTitleWrite = deferred<void>();
    const writeText = vi.fn()
      .mockReturnValueOnce(oldIdWrite.promise)
      .mockReturnValueOnce(oldTitleWrite.promise)
      .mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mountDependencies([
      dependency('dep-alpha', '22222222-2222-4222-8222-222222222222', 'Alpha title', 'todo'),
      dependency('dep-beta', '33333333-3333-4333-8333-333333333333', 'Beta title', 'todo'),
    ]);
    const search = searchInput();
    fireEvent.change(search, { target: { value: 'Beta' } });
    fireEvent.click(idCopyButton(1));
    fireEvent.click(titleCopyButton(1));

    search.focus();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      search.dispatchEvent(event);
    });
    fireEvent.change(search, { target: { value: 'Beta' } });

    await act(async () => {
      oldIdWrite.reject(new Error('stale private clipboard failure'));
      oldTitleWrite.resolve();
      await Promise.allSettled([oldIdWrite.promise, oldTitleWrite.promise]);
    });
    expect(screen.queryByText('Dependency task IDs copied.')).not.toBeInTheDocument();
    expect(screen.queryByText('Dependency titles copied.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(idCopyButton(1));
    fireEvent.click(titleCopyButton(1));
    await waitFor(() => {
      expect(screen.getByText('Dependency task IDs copied.')).toBeInTheDocument();
      expect(screen.getByText('Dependency titles copied.')).toBeInTheDocument();
    }, { timeout: 10000 });
    expect(writeText).toHaveBeenCalledTimes(4);
  }, 20000);
});
