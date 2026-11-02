import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChecklistItem } from '@/lib/api/tasks';
import { TaskChecklist } from './TaskChecklist';

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ default: api }));

const taskId = '10000000-0000-4000-8000-000000000101';
const openFirstId = '10000000-0000-4000-8000-000000000102';
const completeFirstId = '10000000-0000-4000-8000-000000000103';
const openSecondId = '10000000-0000-4000-8000-000000000104';
const completeSecondId = '10000000-0000-4000-8000-000000000105';

const apiChecklist = [
  { id: openFirstId, taskId, text: 'Alpha open item', checked: false, position: 0 },
  { id: completeFirstId, taskId, text: 'Alpha completed item', checked: true, position: 1 },
  { id: openSecondId, taskId, text: 'Beta open item', checked: false, position: 2 },
  { id: completeSecondId, taskId, text: 'Beta completed item', checked: true, position: 3 },
];
const checklist: ChecklistItem[] = apiChecklist.map(({ id, taskId: itemTaskId, text, checked, position }) => ({
  id,
  taskId: itemTaskId,
  label: text,
  checked,
  order: position,
}));

let client: QueryClient;
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function wrapper({ children }: PropsWithChildren) {
  return createElement(QueryClientProvider, { client }, children);
}

function visibleLabels() {
  const list = screen.queryByRole('list');
  return list ? Array.from(list.querySelectorAll('label')).map((label) => label.textContent) : [];
}

function resetButton() {
  return screen.getByRole('button', { name: 'Reset checklist filters' });
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

function setClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

beforeEach(() => {
  api.get.mockReset().mockResolvedValue({ data: apiChecklist });
  api.patch.mockReset();
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

describe('reset all loaded checklist filters', () => {
  it('atomically clears search and either completion mode, while whitespace remains resettable', async () => {
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findByRole('checkbox', { name: 'Alpha open item' });

    expect(resetButton()).toBeDisabled();
    const search = screen.getByRole('searchbox', { name: 'Search loaded checklist items' });
    fireEvent.click(screen.getByRole('button', { name: 'Hide completed items' }));
    fireEvent.change(search, { target: { value: 'Alpha' } });
    expect(visibleLabels()).toEqual(['Alpha open item']);
    expect(resetButton()).toBeEnabled();

    fireEvent.click(resetButton());
    expect(search).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Hide completed items' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Show completed items only' })).toHaveAttribute('aria-pressed', 'false');
    expect(visibleLabels()).toEqual([
      'Alpha open item',
      'Alpha completed item',
      'Beta open item',
      'Beta completed item',
    ]);
    expect(screen.getByText('2/4 (50%)')).toBeInTheDocument();
    expect(resetButton()).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Show completed items only' }));
    fireEvent.change(search, { target: { value: 'Beta' } });
    expect(visibleLabels()).toEqual(['Beta completed item']);
    expect(resetButton()).toBeEnabled();
    fireEvent.click(resetButton());
    expect(search).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Hide completed items' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Show completed items only' })).toHaveAttribute('aria-pressed', 'false');
    expect(visibleLabels()).toHaveLength(4);
    expect(resetButton()).toBeDisabled();

    fireEvent.change(search, { target: { value: '   ' } });
    expect(visibleLabels()).toHaveLength(4);
    expect(resetButton()).toBeEnabled();
    fireEvent.click(resetButton());
    expect(search).toHaveValue('');
    expect(resetButton()).toBeDisabled();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('stays available in a filter-empty view and restores loaded order and counts without effects', async () => {
    const pushState = vi.spyOn(window.history, 'pushState');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findByRole('checkbox', { name: 'Alpha open item' });

    fireEvent.click(screen.getByRole('button', { name: 'Show completed items only' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded checklist items' }), {
      target: { value: 'no matching label' },
    });
    expect(visibleLabels()).toEqual([]);
    expect(screen.getByText('Showing 0 of 4 loaded checklist items.')).toBeInTheDocument();
    expect(resetButton()).toBeEnabled();

    fireEvent.click(resetButton());
    expect(visibleLabels()).toEqual([
      'Alpha open item',
      'Alpha completed item',
      'Beta open item',
      'Beta completed item',
    ]);
    expect(screen.getByText('Showing 4 of 4 loaded checklist items.')).toBeInTheDocument();
    expect(screen.getByText('2/4 (50%)')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Alpha open item' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Alpha completed item' })).toBeChecked();
    expect(resetButton()).toBeDisabled();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it.each([
    ['success', (pending: ReturnType<typeof deferred<void>>) => pending.resolve()],
    ['rejection', (pending: ReturnType<typeof deferred<void>>) => pending.reject(new Error('private clipboard detail'))],
  ] as const)('does not show a stale %s after reset and an A-to-B-to-A filter return', async (outcome, settleOldCopy) => {
    const oldCopy = deferred<void>();
    const writeText = vi.fn()
      .mockReturnValueOnce(oldCopy.promise)
      .mockResolvedValueOnce(undefined);
    setClipboard(writeText);
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findByRole('checkbox', { name: 'Alpha open item' });

    const search = screen.getByRole('searchbox', { name: 'Search loaded checklist items' });
    fireEvent.change(search, { target: { value: 'Alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hide completed items' }));
    expect(visibleLabels()).toEqual(['Alpha open item']);
    fireEvent.click(screen.getByRole('button', { name: 'Copy visible checklist labels (1)' }));
    expect(writeText).toHaveBeenCalledWith('Alpha open item');

    fireEvent.click(resetButton());
    expect(visibleLabels()).toHaveLength(4);
    expect(screen.queryByText('Checklist labels copied.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'Alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Hide completed items' }));
    expect(visibleLabels()).toEqual(['Alpha open item']);
    await act(async () => settleOldCopy(oldCopy));

    expect(screen.queryByText('Checklist labels copied.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy visible checklist labels (1)' }));
    expect(await screen.findByText('Checklist labels copied.')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith('Alpha open item');
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
  });
});
