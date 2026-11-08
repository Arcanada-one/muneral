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

const taskId = '10000000-0000-4000-8000-000000000101';
const otherTaskId = '10000000-0000-4000-8000-000000000102';
const firstId = '10000000-0000-4000-8000-000000000103';
const completedId = '10000000-0000-4000-8000-000000000104';
const secondId = '10000000-0000-4000-8000-000000000105';
const fourthId = '10000000-0000-4000-8000-000000000106';

const initialResponse = [
  { id: firstId, taskId, text: 'Alpha open item', checked: false, position: 0 },
  { id: completedId, taskId, text: 'Alpha completed item', checked: true, position: 1 },
  { id: secondId, taskId, text: 'Beta open item', checked: false, position: 2 },
  { id: fourthId, taskId, text: 'Beta completed item', checked: true, position: 3 },
];
const otherTaskResponse = [
  { id: secondId, taskId: otherTaskId, text: 'Other open item', checked: false, position: 0 },
  { id: fourthId, taskId: otherTaskId, text: 'Other completed item', checked: true, position: 1 },
];

let client: QueryClient;
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function wrapper({ children }: PropsWithChildren) {
  return createElement(QueryClientProvider, { client }, children);
}

function visibleLabels() {
  const list = screen.queryByRole('list');
  return list ? Array.from(list.querySelectorAll('label')).map((label) => label.textContent) : [];
}

function setChecklist(items: ChecklistItem[]) {
  client.setQueryData(['tasks', taskId, 'checklist'], items);
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

beforeEach(() => {
  api.get.mockReset().mockImplementation(async (url: string) => ({
    data: url.startsWith(`/tasks/${otherTaskId}/`) ? otherTaskResponse : initialResponse,
  }));
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

describe('TaskChecklist completed-only view', () => {
  it('defaults to all loaded rows and keeps completion filters mutually exclusive with full-list progress', async () => {
    const user = userEvent.setup();
    render(<TaskChecklist taskId={taskId} />, { wrapper });

    await screen.findByRole('checkbox', { name: 'Alpha open item' });
    const hideCompleted = screen.getByRole('button', { name: 'Hide completed items' });
    const completedOnly = screen.getByRole('button', { name: 'Show completed items only' });
    expect(hideCompleted).toHaveAttribute('aria-pressed', 'false');
    expect(completedOnly).toHaveAttribute('aria-pressed', 'false');
    expect(visibleLabels()).toEqual([
      'Alpha open item',
      'Alpha completed item',
      'Beta open item',
      'Beta completed item',
    ]);
    expect(screen.getByText('2/4 (50%)')).toBeInTheDocument();

    await user.click(completedOnly);
    expect(completedOnly).toHaveAttribute('aria-pressed', 'true');
    expect(hideCompleted).toHaveAttribute('aria-pressed', 'false');
    expect(visibleLabels()).toEqual(['Alpha completed item', 'Beta completed item']);
    expect(screen.getByText('Showing 2 of 4 loaded checklist items.')).toBeInTheDocument();
    expect(screen.getByText('2/4 (50%)')).toBeInTheDocument();

    await user.click(hideCompleted);
    expect(hideCompleted).toHaveAttribute('aria-pressed', 'true');
    expect(completedOnly).toHaveAttribute('aria-pressed', 'false');
    expect(visibleLabels()).toEqual(['Alpha open item', 'Beta open item']);

    await user.click(completedOnly);
    expect(hideCompleted).toHaveAttribute('aria-pressed', 'false');
    expect(completedOnly).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Show all items' }));
    expect(hideCompleted).toHaveAttribute('aria-pressed', 'false');
    expect(completedOnly).toHaveAttribute('aria-pressed', 'false');
    expect(visibleLabels()).toHaveLength(4);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('intersects completed-only with search in loaded order and recovers from an empty filter', async () => {
    const user = userEvent.setup();
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findByRole('checkbox', { name: 'Alpha open item' });

    await user.click(screen.getByRole('button', { name: 'Show completed items only' }));
    const search = screen.getByRole('searchbox', { name: 'Search loaded checklist items' });
    await user.type(search, 'beta');
    expect(visibleLabels()).toEqual(['Beta completed item']);
    expect(screen.getByText('Showing 1 of 4 loaded checklist items.')).toBeInTheDocument();
    expect(screen.getByText('2/4 (50%)')).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, 'no matching label');
    expect(visibleLabels()).toEqual([]);
    expect(screen.getByText('Showing 0 of 4 loaded checklist items.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'No completed loaded checklist items match this search. Clear search or show all items.',
    );
    await user.click(screen.getByRole('button', { name: 'Show all items' }));
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(visibleLabels()).toEqual([
      'Alpha open item',
      'Alpha completed item',
      'Beta open item',
      'Beta completed item',
    ]);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('keeps the selected view across current same-task rows, collapse and loaded-empty round trips', async () => {
    const user = userEvent.setup();
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findByRole('checkbox', { name: 'Alpha open item' });
    await user.click(screen.getByRole('button', { name: 'Show completed items only' }));

    await act(async () => setChecklist([
      { id: firstId, taskId, label: 'Alpha now completed', checked: true, order: 0 },
      { id: completedId, taskId, label: 'Alpha now open', checked: false, order: 1 },
      { id: secondId, taskId, label: 'Beta remains completed', checked: true, order: 2 },
    ]));
    await waitFor(() => expect(visibleLabels()).toEqual(['Alpha now completed', 'Beta remains completed']));
    expect(screen.getByText('2/3 (67%)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Checklist/ }));
    expect(screen.queryByRole('searchbox', { name: 'Search loaded checklist items' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Checklist/ }));
    expect(screen.getByRole('button', { name: 'Show completed items only' })).toHaveAttribute('aria-pressed', 'true');
    expect(visibleLabels()).toEqual(['Alpha now completed', 'Beta remains completed']);

    await act(async () => setChecklist([]));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Checklist/ })).not.toBeInTheDocument());
    await act(async () => setChecklist([
      { id: secondId, taskId, label: 'Beta after empty, open', checked: false, order: 0 },
      { id: firstId, taskId, label: 'Alpha after empty, done', checked: true, order: 1 },
    ]));
    await waitFor(() => expect(screen.getByRole('button', { name: /Checklist/ })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Show completed items only' })).toHaveAttribute('aria-pressed', 'true');
    expect(visibleLabels()).toEqual(['Alpha after empty, done']);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('resets completion view through task A-to-B-to-A changes', async () => {
    const user = userEvent.setup();
    const view = render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findByRole('checkbox', { name: 'Alpha open item' });
    await user.click(screen.getByRole('button', { name: 'Show completed items only' }));
    expect(visibleLabels()).toEqual(['Alpha completed item', 'Beta completed item']);

    view.rerender(<TaskChecklist taskId={otherTaskId} />);
    await screen.findByRole('checkbox', { name: 'Other open item' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show completed items only' }))
      .toHaveAttribute('aria-pressed', 'false'));
    expect(visibleLabels()).toEqual(['Other open item', 'Other completed item']);

    view.rerender(<TaskChecklist taskId={taskId} />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Show completed items only' })).toHaveAttribute('aria-pressed', 'false');
      expect(visibleLabels()).toEqual([
        'Alpha open item',
        'Alpha completed item',
        'Beta open item',
        'Beta completed item',
      ]);
    });
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('adds no reads, mutations, navigation, storage or clipboard work for filtering and copies only completed visible labels', async () => {
    const pendingOldCopy = deferred<void>();
    const writeText = vi.fn()
      .mockReturnValueOnce(pendingOldCopy.promise)
      .mockResolvedValueOnce(undefined);
    const pushState = vi.spyOn(window.history, 'pushState');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findByRole('checkbox', { name: 'Alpha open item' });

    fireEvent.click(screen.getByRole('button', { name: 'Copy visible checklist labels (4)' }));
    expect(writeText).toHaveBeenCalledWith(
      'Alpha open item\nAlpha completed item\nBeta open item\nBeta completed item',
    );
    await user.click(screen.getByRole('button', { name: 'Show completed items only' }));
    expect(screen.queryByText('Checklist labels copied.')).not.toBeInTheDocument();
    expect(writeText).toHaveBeenCalledTimes(1);
    await act(async () => pendingOldCopy.resolve());
    expect(screen.queryByText('Checklist labels copied.')).not.toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: 'Search loaded checklist items' }), 'alpha');
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Copy visible checklist labels (1)' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('Alpha completed item'));
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();

    await user.clear(screen.getByRole('searchbox', { name: 'Search loaded checklist items' }));
    expect(visibleLabels()).toEqual(['Alpha completed item', 'Beta completed item']);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('preserves checkbox pending and generic failure behavior while the completed view is active', async () => {
    const user = userEvent.setup();
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findByRole('checkbox', { name: 'Alpha open item' });
    await user.click(screen.getByRole('button', { name: 'Show completed items only' }));

    const pendingPatch = deferred<{ data: ChecklistItem }>();
    api.patch.mockReturnValueOnce(pendingPatch.promise);
    const checkbox = screen.getByRole('checkbox', { name: 'Alpha completed item' });
    await user.click(checkbox);
    expect(api.patch).toHaveBeenCalledWith(`/tasks/${taskId}/checklist/${completedId}`, { checked: false });
    expect(checkbox).toBeDisabled();

    await act(async () => pendingPatch.reject(new Error('private mutation detail')));
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to update checklist. Please try again.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('private mutation detail');
    expect(screen.getByRole('checkbox', { name: 'Alpha completed item' })).toBeEnabled();

    api.patch.mockResolvedValueOnce({ data: { id: completedId, taskId, checked: false } });
    await user.click(screen.getByRole('checkbox', { name: 'Alpha completed item' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(2));
    expect(api.patch).toHaveBeenLastCalledWith(
      `/tasks/${taskId}/checklist/${completedId}`,
      { checked: false },
    );
  });
});
