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

function mountDependencies(rows: DependencyFixture[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(['tasks', taskId, 'dependency-graph'], rows);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TaskDependencies taskId={taskId} />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

function resetButton() {
  return screen.getByRole('button', { name: 'Show all loaded dependencies' });
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

describe('reset all loaded dependency filters', () => {
  it('restores direction, completed status, raw search, loaded order, and denominator together', () => {
    const rows = [
      dependency('dep-alpha', '22222222-2222-4222-8222-222222222222', 'Alpha', 'todo'),
      dependency('dep-beta', '33333333-3333-4333-8333-333333333333', 'Beta', 'done', 'outgoing'),
      dependency('dep-gamma', '44444444-4444-4444-8444-444444444444', 'Gamma', 'todo', 'outgoing'),
      dependency('dep-delta', '55555555-5555-4555-8555-555555555555', 'Delta', 'done'),
    ];
    const { queryClient } = mountDependencies(rows);

    fireEvent.change(screen.getByRole('textbox', { name: 'Search loaded dependencies' }), {
      target: { value: 'gamma' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Dependency direction' }), {
      target: { value: 'outgoing' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide completed dependencies' }));
    expect(screen.getByText('Showing 1 matching of 4 loaded dependencies.')).toBeInTheDocument();
    expect(within(screen.getByRole('list')).getByText('Gamma')).toBeInTheDocument();
    expect(resetButton()).toBeEnabled();

    fireEvent.click(resetButton());

    expect(screen.getByRole('combobox', { name: 'Dependency direction' })).toHaveValue('all');
    expect(screen.getByRole('checkbox', { name: 'Hide completed dependencies' })).not.toBeChecked();
    expect(screen.getByRole('textbox', { name: 'Search loaded dependencies' })).toHaveValue('');
    expect(screen.getByText('Showing 4 of 4 loaded dependencies.')).toBeInTheDocument();
    const listText = screen.getByRole('list').textContent ?? '';
    expect(listText.indexOf('Alpha')).toBeLessThan(listText.indexOf('Beta'));
    expect(listText.indexOf('Beta')).toBeLessThan(listText.indexOf('Gamma'));
    expect(listText.indexOf('Gamma')).toBeLessThan(listText.indexOf('Delta'));
    expect(queryClient.getQueryData(['tasks', taskId, 'dependency-graph'])).toBe(rows);
  });

  it('keeps the reset available when filters hide every loaded row', () => {
    const rows = [
      dependency('dep-one', '22222222-2222-4222-8222-222222222222', 'First', 'todo'),
      dependency('dep-two', '33333333-3333-4333-8333-333333333333', 'Second', 'done', 'outgoing'),
    ];
    mountDependencies(rows);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search loaded dependencies' }), {
      target: { value: 'missing' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Dependency direction' }), {
      target: { value: 'outgoing' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide completed dependencies' }));

    expect(screen.getByText(/No matching dependencies in the loaded list/)).toBeInTheDocument();
    expect(resetButton()).toBeEnabled();
    fireEvent.click(resetButton());

    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(screen.getByText('Showing 2 of 2 loaded dependencies.')).toBeInTheDocument();
  });

  it('treats a whitespace-only raw search as resettable even though it matches all rows', () => {
    mountDependencies([
      dependency('dep-one', '22222222-2222-4222-8222-222222222222', 'First', 'todo'),
    ]);
    const search = screen.getByRole('textbox', { name: 'Search loaded dependencies' });
    fireEvent.change(search, { target: { value: '   ' } });

    expect(screen.getByText('Showing 1 of 1 loaded dependencies.')).toBeInTheDocument();
    expect(search).toHaveValue('   ');
    expect(resetButton()).toBeEnabled();
    fireEvent.click(resetButton());

    expect(screen.getByRole('textbox', { name: 'Search loaded dependencies' })).toHaveValue('');
    expect(resetButton()).toBeDisabled();
  });

  it('is disabled at defaults and reset itself makes no request, mutation, storage, navigation, or clipboard call', () => {
    const rows = [
      dependency('dep-one', '22222222-2222-4222-8222-222222222222', 'First', 'todo'),
    ];
    mountDependencies(rows);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const mutations = [
      vi.spyOn(apiClient, 'post'),
      vi.spyOn(apiClient, 'put'),
      vi.spyOn(apiClient, 'patch'),
      vi.spyOn(apiClient, 'delete'),
    ];
    const storageWrites = vi.spyOn(Storage.prototype, 'setItem');
    const storageRemovals = vi.spyOn(Storage.prototype, 'removeItem');
    const navigation = vi.spyOn(history, 'pushState');
    const getRequest = vi.spyOn(apiClient, 'get');

    expect(resetButton()).toBeDisabled();
    fireEvent.click(resetButton());
    fireEvent.change(screen.getByRole('combobox', { name: 'Dependency direction' }), {
      target: { value: 'incoming' },
    });
    getRequest.mockClear();
    mutations.forEach((mutation) => mutation.mockClear());
    fetchSpy.mockClear();
    storageWrites.mockClear();
    storageRemovals.mockClear();
    navigation.mockClear();

    fireEvent.click(resetButton());

    expect(screen.getByRole('combobox', { name: 'Dependency direction' })).toHaveValue('all');
    expect(apiClient.get).not.toHaveBeenCalled();
    expect(mutations.every((mutation) => mutation.mock.calls.length === 0)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storageWrites).not.toHaveBeenCalled();
    expect(storageRemovals).not.toHaveBeenCalled();
    expect(navigation).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('preserves row full-ID disclosure and the loaded row data when the reset keeps that row mounted', () => {
    const rows = [
      dependency('dep-one', '22222222-2222-4222-8222-222222222222', 'First', 'todo'),
      dependency('dep-two', '33333333-3333-4333-8333-333333333333', 'Second', 'done'),
    ];
    const { queryClient } = mountDependencies(rows);
    const firstRow = screen.getByText('First').closest('li');
    expect(firstRow).not.toBeNull();
    fireEvent.click(within(firstRow as HTMLElement).getByRole('button', { name: 'Show full task ID' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide completed dependencies' }));

    expect(within(firstRow as HTMLElement).getByRole('button', { name: 'Hide full task ID' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(resetButton());

    const restoredRow = screen.getByText('First').closest('li');
    expect(restoredRow).toBe(firstRow);
    expect(within(restoredRow as HTMLElement).getByText('22222222-2222-4222-8222-222222222222')).toBeInTheDocument();
    expect(within(restoredRow as HTMLElement).getByRole('button', { name: 'Hide full task ID' })).toHaveAttribute('aria-expanded', 'true');
    expect(queryClient.getQueryData(['tasks', taskId, 'dependency-graph'])).toBe(rows);
    expect(rows[0].otherTaskStatus).toBe('todo');
    expect(rows[1].otherTaskStatus).toBe('done');
  });

  it('invalidates both pending copy outcomes across reset and an ABA return to the same search', async () => {
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
    const search = screen.getByRole('textbox', { name: 'Search loaded dependencies' });
    fireEvent.change(search, { target: { value: 'Alpha' } });
    fireEvent.click(idCopyButton(1));
    fireEvent.click(titleCopyButton(1));
    expect(idCopyButton(1)).toBeDisabled();
    expect(titleCopyButton(1)).toBeDisabled();
    expect(writeText).toHaveBeenNthCalledWith(1, '22222222-2222-4222-8222-222222222222');
    expect(writeText).toHaveBeenNthCalledWith(2, 'Alpha title');

    fireEvent.click(resetButton());
    expect(screen.getByRole('textbox', { name: 'Search loaded dependencies' })).toHaveValue('');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search loaded dependencies' }), {
      target: { value: 'Alpha' },
    });
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
    });
    expect(writeText).toHaveBeenCalledTimes(4);
  });
});
