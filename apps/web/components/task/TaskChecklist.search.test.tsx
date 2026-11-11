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
const otherTaskId = '10000000-0000-4000-8000-000000000003';
const firstId = '10000000-0000-4000-8000-000000000002';
const completedId = '10000000-0000-4000-8000-000000000004';
const secondId = '10000000-0000-4000-8000-000000000005';
const thirdId = '10000000-0000-4000-8000-000000000006';

const initialResponse = [
  { id: firstId, taskId, text: 'Update [API] docs', checked: false, position: 0 },
  { id: completedId, taskId, text: 'API docs done', checked: true, position: 1 },
  { id: secondId, taskId, text: 'Review api plan', checked: false, position: 2 },
  { id: thirdId, taskId, text: 'Read API? notes', checked: false, position: 3 },
];
const otherTaskResponse = [
  { id: secondId, taskId: otherTaskId, text: 'Needle task B', checked: false, position: 0 },
  { id: thirdId, taskId: otherTaskId, text: 'Other task B item', checked: false, position: 1 },
];

let client: QueryClient;
let clipboardDescriptor: PropertyDescriptor | undefined;
let writeText: ReturnType<typeof vi.fn>;

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
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setClipboard(nextWriteText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: nextWriteText },
  });
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
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  writeText = vi.fn().mockResolvedValue(undefined);
  setClipboard(writeText);
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

describe('TaskChecklist loaded-label search', () => {
  it('trims case-insensitive literal searches, intersects Hide completed, and preserves order and whole-list progress', async () => {
    const user = userEvent.setup();
    render(<TaskChecklist taskId={taskId} />, { wrapper });

    await screen.findByRole('checkbox', { name: 'Update [API] docs' });
    const search = screen.getByRole('searchbox', { name: 'Search loaded checklist items' });
    expect(screen.getByText('1/4 (25%)')).toBeInTheDocument();

    await user.type(search, '  aPi  ');
    expect(visibleLabels()).toEqual([
      'Update [API] docs',
      'API docs done',
      'Review api plan',
      'Read API? notes',
    ]);
    expect(screen.getByText('Showing 4 of 4 loaded checklist items.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hide completed items' }));
    expect(visibleLabels()).toEqual(['Update [API] docs', 'Review api plan', 'Read API? notes']);
    expect(screen.getByText('Showing 3 of 4 loaded checklist items.')).toBeInTheDocument();
    expect(screen.getByText('1/4 (25%)')).toBeInTheDocument();

    await user.clear(search);
    fireEvent.change(search, { target: { value: '[' } });
    expect(visibleLabels()).toEqual(['Update [API] docs']);
    expect(screen.getByText('Showing 1 of 4 loaded checklist items.')).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, '?');
    expect(visibleLabels()).toEqual(['Read API? notes']);

    await user.clear(search);
    await user.type(search, '   ');
    expect(visibleLabels()).toEqual(['Update [API] docs', 'Review api plan', 'Read API? notes']);
    expect(screen.getByText('Showing 3 of 4 loaded checklist items.')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('offers clear-search and show-all recovery when loaded filters leave no matching rows', async () => {
    const user = userEvent.setup();
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findByRole('checkbox', { name: 'Update [API] docs' });

    const search = screen.getByRole('searchbox', { name: 'Search loaded checklist items' });
    await user.type(search, 'no such label');
    expect(screen.getByRole('status')).toHaveTextContent(
      'No loaded checklist items match this search. Clear search to show the loaded items.',
    );
    expect(screen.getByText('Showing 0 of 4 loaded checklist items.')).toBeInTheDocument();
    expect(visibleLabels()).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Hide completed items' }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'No incomplete loaded checklist items match this search. Clear search or show all items.',
    );
    await user.click(screen.getByRole('button', { name: 'Show all items' }));
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(search).toHaveValue('');
    expect(visibleLabels()).toEqual(['Update [API] docs', 'API docs done', 'Review api plan', 'Read API? notes']);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('retains the query across same-task updates, collapse, loaded-empty, and repopulation', async () => {
    const user = userEvent.setup();
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findByRole('checkbox', { name: 'Update [API] docs' });

    const search = screen.getByRole('searchbox', { name: 'Search loaded checklist items' });
    await user.type(search, 'needle');
    await act(async () => {
      setChecklist([
        { id: firstId, taskId, label: 'Needle updated item', checked: false, order: 0 },
        { id: secondId, taskId, label: 'Other updated item', checked: false, order: 1 },
      ]);
    });
    await waitFor(() => expect(visibleLabels()).toEqual(['Needle updated item']));
    expect(search).toHaveValue('needle');

    await user.click(screen.getByRole('button', { name: /Checklist/ }));
    expect(screen.queryByRole('searchbox', { name: 'Search loaded checklist items' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Checklist/ }));
    expect(screen.getByRole('searchbox', { name: 'Search loaded checklist items' })).toHaveValue('needle');
    await user.click(screen.getByRole('button', { name: /Checklist/ }));

    await act(async () => setChecklist([]));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Checklist/ })).not.toBeInTheDocument());
    await act(async () => {
      setChecklist([
        { id: secondId, taskId, label: 'Needle after empty', checked: false, order: 0 },
        { id: thirdId, taskId, label: 'Fresh unrelated item', checked: false, order: 1 },
      ]);
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /Checklist/ })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Checklist/ }));
    expect(screen.getByRole('searchbox', { name: 'Search loaded checklist items' })).toHaveValue('needle');
    expect(visibleLabels()).toEqual(['Needle after empty']);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('resets the query after A-to-B-to-A task identity transitions without editing on B', async () => {
    const user = userEvent.setup();
    const view = render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findByRole('checkbox', { name: 'Update [API] docs' });
    await user.type(screen.getByRole('searchbox', { name: 'Search loaded checklist items' }), 'API');
    expect(visibleLabels()).toHaveLength(4);

    view.rerender(<TaskChecklist taskId={otherTaskId} />);
    await screen.findByRole('checkbox', { name: 'Needle task B' });
    await waitFor(() => {
      expect(screen.getByRole('searchbox', { name: 'Search loaded checklist items' })).toHaveValue('');
    });
    expect(visibleLabels()).toEqual(['Needle task B', 'Other task B item']);

    view.rerender(<TaskChecklist taskId={taskId} />);
    await waitFor(() => {
      expect(screen.getByRole('searchbox', { name: 'Search loaded checklist items' })).toHaveValue('');
      expect(visibleLabels()).toEqual(['Update [API] docs', 'API docs done', 'Review api plan', 'Read API? notes']);
    });
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(api.patch).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('adds no reads or mutations for search and preserves the existing pending and failure behavior of checkbox changes', async () => {
    const user = userEvent.setup();
    const view = render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findByRole('checkbox', { name: 'Update [API] docs' });

    await user.type(screen.getByRole('searchbox', { name: 'Search loaded checklist items' }), 'Update');
    expect(visibleLabels()).toEqual(['Update [API] docs']);
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();

    const pendingPatch = deferred<{ data: ChecklistItem }>();
    api.patch.mockReturnValueOnce(pendingPatch.promise);
    const checkbox = screen.getByRole('checkbox', { name: 'Update [API] docs' });
    await user.click(checkbox);
    expect(api.patch).toHaveBeenCalledWith(`/tasks/${taskId}/checklist/${firstId}`, { checked: true });
    expect(checkbox).toBeDisabled();

    await act(async () => pendingPatch.reject(new Error('private transport detail')));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to update checklist. Please try again.',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('private transport detail');
    expect(screen.getByRole('checkbox', { name: 'Update [API] docs' })).toBeEnabled();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(writeText).not.toHaveBeenCalled();

    view.unmount();
  });
});
