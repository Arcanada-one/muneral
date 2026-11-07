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
const otherTaskId = '10000000-0000-4000-8000-000000000099';
const items: ChecklistItem[] = [
  { id: '10000000-0000-4000-8000-000000000002', taskId, text: 'Draft agenda', checked: false, position: 0 },
  { id: '10000000-0000-4000-8000-000000000003', taskId, text: 'Approve agenda', checked: true, position: 1 },
  { id: '10000000-0000-4000-8000-000000000004', taskId, text: 'Deliver notes', checked: false, position: 2 },
] as unknown as ChecklistItem[];
const otherItems: ChecklistItem[] = [
  { id: '10000000-0000-4000-8000-000000000005', taskId: otherTaskId, text: 'Other task item', checked: false, position: 0 },
] as unknown as ChecklistItem[];

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

function resetButton() {
  return screen.getByRole('button', { name: 'Reset checklist filters' });
}

function copyButton(count: number) {
  return screen.getByRole('button', { name: `Copy visible checklist labels (${count})` });
}

function setClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

beforeEach(() => {
  api.get.mockReset().mockImplementation(async (url: string) => ({
    data: url.startsWith(`/tasks/${otherTaskId}/`) ? otherItems : items,
  }));
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

describe('reset all loaded checklist filters', () => {
  it('clears search and both completed filters atomically and restores order/progress/count', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    const pushState = vi.spyOn(window.history, 'pushState');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    render(<TaskChecklist taskId={taskId} />, { wrapper });

    await screen.findByRole('checkbox', { name: 'Draft agenda' });
    expect(resetButton()).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Hide completed items' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded checklist items' }), {
      target: { value: 'agenda' },
    });
    expect(screen.getByText('Showing 1 of 3 loaded checklist items.')).toBeInTheDocument();
    expect(visibleLabels()).toEqual(['Draft agenda']);
    expect(resetButton()).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Show all items' })).toBeInTheDocument();

    fireEvent.click(resetButton());

    expect(screen.getByRole('searchbox', { name: 'Search loaded checklist items' })).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Hide completed items' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Show completed items only' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: 'Show all items' })).not.toBeInTheDocument();
    expect(visibleLabels()).toEqual(['Draft agenda', 'Approve agenda', 'Deliver notes']);
    expect(screen.getByText('Showing 3 of 3 loaded checklist items.')).toBeInTheDocument();
    expect(screen.getByText('1/3 (33%)')).toBeInTheDocument();
    expect(resetButton()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeDisabled();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
  });

  it('clears show-completed-only together with raw search without mutating checkboxes', async () => {
    const user = userEvent.setup();
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findByRole('checkbox', { name: 'Draft agenda' });

    await user.click(screen.getByRole('button', { name: 'Show completed items only' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded checklist items' }), {
      target: { value: 'Approve' },
    });
    expect(visibleLabels()).toEqual(['Approve agenda']);
    expect(screen.getByRole('checkbox', { name: 'Approve agenda' })).toBeChecked();

    fireEvent.click(resetButton());

    expect(visibleLabels()).toEqual(['Draft agenda', 'Approve agenda', 'Deliver notes']);
    expect(screen.getByRole('checkbox', { name: 'Draft agenda' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Approve agenda' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Deliver notes' })).not.toBeChecked();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('keeps whitespace-only raw query resettable while defaults stay disabled', async () => {
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    const input = await screen.findByRole('searchbox', { name: 'Search loaded checklist items' });

    expect(resetButton()).toBeDisabled();
    fireEvent.change(input, { target: { value: '   ' } });
    expect(visibleLabels()).toEqual(['Draft agenda', 'Approve agenda', 'Deliver notes']);
    expect(resetButton()).toBeEnabled();

    fireEvent.click(resetButton());
    expect(input).toHaveValue('');
    expect(resetButton()).toBeDisabled();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('remains available in filter-empty view and restores all loaded rows', async () => {
    const user = userEvent.setup();
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findByRole('checkbox', { name: 'Draft agenda' });

    await user.click(screen.getByRole('button', { name: 'Hide completed items' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded checklist items' }), {
      target: { value: 'Approve' },
    });
    expect(screen.getByText('Showing 0 of 3 loaded checklist items.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'No incomplete loaded checklist items match this search. Clear search or show all items.',
    );
    expect(resetButton()).toBeEnabled();

    fireEvent.click(resetButton());

    expect(visibleLabels()).toEqual(['Draft agenda', 'Approve agenda', 'Deliver notes']);
    expect(screen.getByText('Showing 3 of 3 loaded checklist items.')).toBeInTheDocument();
    expect(screen.getByText('1/3 (33%)')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('preserves collapse choice and leaves Escape / Clear search / Show all independent', async () => {
    const user = userEvent.setup();
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findByRole('checkbox', { name: 'Draft agenda' });

    await user.click(screen.getByRole('button', { name: 'Hide completed items' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded checklist items' }), {
      target: { value: 'Draft' },
    });
    expect(resetButton()).toBeEnabled();

    const disclosure = screen.getByRole('button', { name: /Checklist/ });
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Reset checklist filters' })).not.toBeInTheDocument();
    expect(screen.queryByRole('searchbox', { name: 'Search loaded checklist items' })).not.toBeInTheDocument();
    expect(screen.getByText('1/3 (33%)')).toBeInTheDocument();

    await user.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    const input = screen.getByRole('searchbox', { name: 'Search loaded checklist items' });
    expect(input).toHaveValue('Draft');
    expect(screen.getByRole('button', { name: 'Hide completed items' })).toHaveAttribute('aria-pressed', 'true');
    expect(resetButton()).toBeEnabled();

    fireEvent.keyDown(input, { key: 'Escape', bubbles: true, cancelable: true });
    expect(input).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Hide completed items' })).toHaveAttribute('aria-pressed', 'true');
    expect(resetButton()).toBeEnabled();

    fireEvent.change(input, { target: { value: 'notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(input).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Hide completed items' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Show all items' }));
    expect(screen.getByRole('button', { name: 'Hide completed items' })).toHaveAttribute('aria-pressed', 'false');
    expect(input).toHaveValue('');
    expect(resetButton()).toBeDisabled();
  });

  it('keeps loading, error/retry, and true-empty outside the reset control', async () => {
    let finishLoad: ((response: { data: typeof items }) => void) | undefined;
    api.get.mockReset().mockImplementationOnce(() => new Promise((resolve) => {
      finishLoad = resolve;
    }));
    const loadingView = render(<TaskChecklist taskId={taskId} />, { wrapper });
    expect(screen.getByText('Loading checklist…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset checklist filters' })).not.toBeInTheDocument();
    await act(async () => finishLoad?.({ data: items }));
    expect(await screen.findByRole('button', { name: 'Reset checklist filters' })).toBeDisabled();
    loadingView.unmount();

    api.get.mockReset().mockRejectedValueOnce(new Error('Synthetic checklist read failure'));
    const errorView = render(<TaskChecklist taskId={taskId} />, { wrapper });
    expect(await screen.findByRole('alert')).toHaveTextContent('Checklist is unavailable. Try again later.');
    expect(screen.queryByRole('button', { name: 'Reset checklist filters' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry checklist' })).toBeInTheDocument();
    errorView.unmount();

    api.get.mockReset().mockResolvedValueOnce({ data: [] });
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Reset checklist filters' })).not.toBeInTheDocument();
    expect(screen.queryByText('Checklist')).not.toBeInTheDocument();
  });

  it('does not mutate checkbox pending/error state and still allows a later toggle', async () => {
    const user = userEvent.setup();
    const pendingPatch = deferred<{ data: ChecklistItem }>();
    api.patch.mockReturnValueOnce(pendingPatch.promise);
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    const checkbox = await screen.findByRole('checkbox', { name: 'Draft agenda' });

    await user.click(screen.getByRole('button', { name: 'Hide completed items' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded checklist items' }), {
      target: { value: 'Draft' },
    });
    await act(async () => {
      fireEvent.click(checkbox);
    });
    expect(api.patch).toHaveBeenCalledWith(
      `/tasks/${taskId}/checklist/10000000-0000-4000-8000-000000000002`,
      { checked: true },
    );
    expect(screen.getByRole('checkbox', { name: 'Draft agenda' })).toBeDisabled();

    fireEvent.click(resetButton());
    expect(screen.getByRole('checkbox', { name: 'Draft agenda' })).toBeDisabled();
    expect(api.patch).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingPatch.resolve({
        data: {
          id: '10000000-0000-4000-8000-000000000002',
          taskId,
          label: 'Draft agenda',
          checked: true,
          position: 0,
        } as ChecklistItem,
      });
      await pendingPatch.promise;
    });
    expect(screen.getByRole('checkbox', { name: 'Draft agenda' })).toBeEnabled();
  });

  it('clears settled copy success on reset and allows a fresh current-view copy', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findByRole('checkbox', { name: 'Draft agenda' });

    await user.click(screen.getByRole('button', { name: 'Hide completed items' }));
    fireEvent.click(copyButton(2));
    expect(await screen.findByText('Checklist labels copied.')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith('Draft agenda\nDeliver notes');

    fireEvent.click(resetButton());
    expect(screen.queryByText('Checklist labels copied.')).not.toBeInTheDocument();
    expect(copyButton(3)).toBeEnabled();

    fireEvent.click(copyButton(3));
    expect(await screen.findByText('Checklist labels copied.')).toBeInTheDocument();
    expect(writeText).toHaveBeenLastCalledWith('Draft agenda\nApprove agenda\nDeliver notes');
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('does not label the restored view with a deferred copy success or rejection after ABA', async () => {
    const user = userEvent.setup();
    const write = deferred<void>();
    const writeText = vi.fn().mockReturnValue(write.promise);
    setClipboard(writeText);
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findByRole('checkbox', { name: 'Draft agenda' });

    await user.click(screen.getByRole('button', { name: 'Show completed items only' }));
    fireEvent.click(copyButton(1));
    expect(copyButton(1)).toBeDisabled();

    fireEvent.click(resetButton());
    expect(copyButton(3)).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Show completed items only' }));
    expect(copyButton(1)).toBeEnabled();
    expect(screen.queryByText('Checklist labels copied.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => {
      write.resolve(undefined);
      await write.promise;
    });
    expect(screen.queryByText('Checklist labels copied.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(copyButton(1)).toBeEnabled();

    const failWrite = deferred<void>();
    setClipboard(vi.fn().mockReturnValue(failWrite.promise));
    fireEvent.click(copyButton(1));
    fireEvent.click(resetButton());
    await user.click(screen.getByRole('button', { name: 'Show completed items only' }));
    await act(async () => {
      failWrite.reject(new Error('synthetic clipboard failure'));
      await failWrite.promise.catch(() => undefined);
    });
    expect(screen.queryByText('Checklist labels copied.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('preserves same-task filter updates and resets filters when the task identity changes', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findByRole('checkbox', { name: 'Draft agenda' });

    await user.click(screen.getByRole('button', { name: 'Hide completed items' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded checklist items' }), {
      target: { value: 'Draft' },
    });
    expect(resetButton()).toBeEnabled();

    rerender(<TaskChecklist taskId={otherTaskId} />);
    expect(await screen.findByRole('checkbox', { name: 'Other task item' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search loaded checklist items' })).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Hide completed items' })).toHaveAttribute('aria-pressed', 'false');
    expect(resetButton()).toBeDisabled();

    rerender(<TaskChecklist taskId={taskId} />);
    await screen.findByRole('checkbox', { name: 'Draft agenda' });
    expect(screen.getByRole('searchbox', { name: 'Search loaded checklist items' })).toHaveValue('');
    expect(resetButton()).toBeDisabled();
    expect(visibleLabels()).toEqual(['Draft agenda', 'Approve agenda', 'Deliver notes']);
  });
});
