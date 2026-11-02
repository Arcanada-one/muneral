import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChecklistItem } from '@/lib/api/tasks';
import { TaskChecklist } from './TaskChecklist';

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ default: api }));

const taskId = '10000000-0000-4000-8000-000000000001';
const items: ChecklistItem[] = [
  { id: '10000000-0000-4000-8000-000000000002', taskId, label: 'Draft agenda', checked: false, order: 0 },
  { id: '10000000-0000-4000-8000-000000000003', taskId, label: 'Approve agenda', checked: true, order: 1 },
  { id: '10000000-0000-4000-8000-000000000004', taskId, label: 'Deliver notes', checked: false, order: 2 },
];

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let client: QueryClient;
let clipboardDescriptor: PropertyDescriptor | undefined;

function wrapper({ children }: PropsWithChildren) {
  return createElement(QueryClientProvider, { client }, children);
}

function visibleLabels() {
  return Array.from(screen.getByRole('list').querySelectorAll('label'))
    .map((label) => label.textContent);
}

function setClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

beforeEach(() => {
  api.get.mockReset().mockResolvedValue({ data: items });
  api.patch.mockReset();
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

describe('TaskChecklist search Escape recovery', () => {
  it('clears a nonempty query without moving focus and stops the clearing key', async () => {
    const user = userEvent.setup();
    const parentKeyDown = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    render(
      <div onKeyDown={parentKeyDown}>
        <TaskChecklist taskId={taskId} />
      </div>,
      { wrapper },
    );

    const input = await screen.findByRole('searchbox', { name: 'Search loaded checklist items' });
    await user.type(input, 'Approve');
    expect(input).toHaveValue('Approve');
    expect(visibleLabels()).toEqual(['Approve agenda']);

    parentKeyDown.mockClear();
    input.focus();
    const wasNotCanceled = fireEvent.keyDown(input, {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });

    expect(wasNotCanceled).toBe(false);
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    expect(parentKeyDown).not.toHaveBeenCalled();
    expect(visibleLabels()).toEqual(['Draft agenda', 'Approve agenda', 'Deliver notes']);
    expect(screen.getByText('1/3 (33%)')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('clears a whitespace-only raw query even though it does not filter rows', async () => {
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    const input = await screen.findByRole('searchbox', { name: 'Search loaded checklist items' });
    fireEvent.change(input, { target: { value: '   ' } });

    expect(input).toHaveValue('   ');
    expect(visibleLabels()).toEqual(['Draft agenda', 'Approve agenda', 'Deliver notes']);
    const wasNotCanceled = fireEvent.keyDown(input, {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });

    expect(wasNotCanceled).toBe(false);
    expect(input).toHaveValue('');
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it.each([
    ['empty query', '', {}],
    ['composition', 'Draft', { isComposing: true }],
    ['Alt modifier', 'Draft', { altKey: true }],
    ['Control modifier', 'Draft', { ctrlKey: true }],
    ['Meta modifier', 'Draft', { metaKey: true }],
    ['Shift modifier', 'Draft', { shiftKey: true }],
  ])('does not intercept Escape for %s', async (_label, query, init) => {
    const parentKeyDown = vi.fn();
    render(<div onKeyDown={parentKeyDown}><TaskChecklist taskId={taskId} /></div>, { wrapper });
    const input = await screen.findByRole('searchbox', { name: 'Search loaded checklist items' });
    if (query) fireEvent.change(input, { target: { value: query } });
    parentKeyDown.mockClear();

    const wasNotCanceled = fireEvent.keyDown(input, {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
      ...init,
    });

    expect(wasNotCanceled).toBe(true);
    expect(parentKeyDown).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue(query);
  });

  it('does not intercept unrelated keys or Escape outside the search input', async () => {
    const parentKeyDown = vi.fn();
    render(<div onKeyDown={parentKeyDown}><TaskChecklist taskId={taskId} /></div>, { wrapper });
    const input = await screen.findByRole('searchbox', { name: 'Search loaded checklist items' });
    fireEvent.change(input, { target: { value: 'Draft' } });
    parentKeyDown.mockClear();

    expect(fireEvent.keyDown(input, { key: 'Enter', bubbles: true, cancelable: true })).toBe(true);
    expect(parentKeyDown).toHaveBeenCalledTimes(1);
    parentKeyDown.mockClear();
    const clearButton = screen.getByRole('button', { name: 'Clear search' });
    expect(fireEvent.keyDown(clearButton, { key: 'Escape', bubbles: true, cancelable: true })).toBe(true);
    expect(parentKeyDown).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue('Draft');
  });

  it.each([
    ['Hide completed items', 'Approve', ['Draft agenda', 'Deliver notes'], 'Showing 2 of 3 loaded checklist items.'],
    ['Show completed items only', 'Draft', ['Approve agenda'], 'Showing 1 of 3 loaded checklist items.'],
  ])('clears only search and preserves %s and loaded order/count', async (filter, query, expected, countText) => {
    const user = userEvent.setup();
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findByRole('checkbox', { name: 'Draft agenda' });
    await user.click(screen.getByRole('button', { name: filter }));
    const input = screen.getByRole('searchbox', { name: 'Search loaded checklist items' });
    await user.type(input, query);
    expect(screen.getByText('Showing 0 of 3 loaded checklist items.')).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Escape', bubbles: true, cancelable: true });

    expect(input).toHaveValue('');
    expect(screen.getByRole('button', { name: filter })).toHaveAttribute('aria-pressed', 'true');
    expect(visibleLabels()).toEqual(expected);
    expect(screen.getByText(countText)).toBeInTheDocument();
    expect(screen.getByText('1/3 (33%)')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('does not show a late clipboard success after the search view changes away and back', async () => {
    const user = userEvent.setup();
    const write = deferred<void>();
    const writeText = vi.fn().mockReturnValue(write.promise);
    setClipboard(writeText);
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findByRole('checkbox', { name: 'Draft agenda' });
    await user.click(screen.getByRole('button', { name: 'Copy visible checklist labels (3)' }));
    expect(writeText).toHaveBeenCalledWith('Draft agenda\nApprove agenda\nDeliver notes');

    const input = screen.getByRole('searchbox', { name: 'Search loaded checklist items' });
    fireEvent.change(input, { target: { value: 'Draft' } });
    fireEvent.change(input, { target: { value: '' } });
    await act(async () => {
      write.resolve(undefined);
      await write.promise;
    });

    expect(screen.queryByText('Checklist labels copied.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy visible checklist labels (3)' })).toBeEnabled();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('does not show a late clipboard rejection after the search view changes', async () => {
    const user = userEvent.setup();
    const write = deferred<void>();
    setClipboard(vi.fn().mockReturnValue(write.promise));
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findByRole('checkbox', { name: 'Draft agenda' });
    await user.click(screen.getByRole('button', { name: 'Copy visible checklist labels (3)' }));

    const input = screen.getByRole('searchbox', { name: 'Search loaded checklist items' });
    fireEvent.change(input, { target: { value: 'Draft' } });
    await act(async () => {
      write.reject(new Error('synthetic clipboard failure'));
      await write.promise.catch(() => undefined);
    });

    expect(screen.queryByText('Checklist labels copied.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('exposes the local shortcut as visible and accessible input help', async () => {
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    const input = await screen.findByRole('searchbox', { name: 'Search loaded checklist items' });

    expect(input).toHaveAttribute('aria-keyshortcuts', 'Escape');
    expect(input).toHaveAccessibleDescription('Press Escape to clear the search.');
    expect(screen.getByText('Press Escape to clear the search.')).toBeVisible();
  });
});
