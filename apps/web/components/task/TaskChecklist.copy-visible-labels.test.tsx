import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const duplicateId = '10000000-0000-4000-8000-000000000005';
const lastId = '10000000-0000-4000-8000-000000000006';
const replacementId = '10000000-0000-4000-8000-000000000007';

const initialResponse = [
  { id: firstId, taskId, text: 'Alpha open item', checked: false, position: 0 },
  { id: completedId, taskId, text: 'Alpha completed item', checked: true, position: 1 },
  { id: duplicateId, taskId, text: 'Alpha open item', checked: false, position: 2 },
  { id: lastId, taskId, text: 'Beta open item', checked: false, position: 3 },
];
const otherTaskResponse = [
  { id: lastId, taskId: otherTaskId, text: 'Other task item', checked: false, position: 0 },
];

let client: QueryClient;
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function wrapper({ children }: PropsWithChildren) {
  return createElement(QueryClientProvider, { client }, children);
}

function copyButton(count: number) {
  return screen.getByRole('button', { name: `Copy visible checklist labels (${count})` });
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

function setClipboard(writeText?: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText ? { writeText } : {},
  });
}

function setChecklist(items: ChecklistItem[]) {
  client.setQueryData(['tasks', taskId, 'checklist'], items);
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

describe('copy visible loaded checklist labels', () => {
  it('copies only labels after search and completed filters, preserving order and duplicates', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    const getCallsBeforeRender = api.get.mock.calls.length;
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findAllByRole('checkbox', { name: 'Alpha open item' });

    fireEvent.click(screen.getByRole('button', { name: 'Hide completed items' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded checklist items' }), {
      target: { value: ' alpha ' },
    });
    expect(copyButton(2)).toBeEnabled();
    expect(writeText).not.toHaveBeenCalled();

    fireEvent.click(copyButton(2));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith('Alpha open item\nAlpha open item');
    expect(writeText.mock.calls[0][0]).not.toContain('10000000-');
    expect(writeText.mock.calls[0][0]).not.toContain('completed');
    expect(writeText.mock.calls[0][0]).not.toContain('Beta');
    expect(api.get).toHaveBeenCalledTimes(getCallsBeforeRender + 1);
    expect(api.patch).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Checklist labels copied.');
  });

  it('disables copy for zero visible rows and excludes completed labels', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findAllByRole('checkbox', { name: 'Alpha open item' });
    fireEvent.click(screen.getByRole('button', { name: 'Hide completed items' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded checklist items' }), {
      target: { value: 'Alpha completed' },
    });

    expect(screen.getByText('Showing 0 of 4 loaded checklist items.')).toBeInTheDocument();
    expect(copyButton(0)).toBeDisabled();
    fireEvent.click(copyButton(0));
    expect(writeText).not.toHaveBeenCalled();
  });

  it('adds no reads, mutations, navigation, or storage writes for copy and preserves checkbox mutation behavior', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    const pushState = vi.spyOn(window.history, 'pushState');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    const [checkbox] = await screen.findAllByRole('checkbox', { name: 'Alpha open item' });
    const readsBeforeCopy = api.get.mock.calls.length;

    fireEvent.click(copyButton(4));
    await screen.findByText('Checklist labels copied.');
    expect(api.get).toHaveBeenCalledTimes(readsBeforeCopy);
    expect(api.patch).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();

    const pendingPatch = deferred<{ data: ChecklistItem }>();
    api.patch.mockReturnValueOnce(pendingPatch.promise);
    const currentCheckbox = screen.getAllByRole('checkbox', { name: 'Alpha open item' })[0];
    await act(async () => fireEvent.click(currentCheckbox));
    expect(api.patch).toHaveBeenCalledWith(`/tasks/${taskId}/checklist/${firstId}`, { checked: true });
    expect(currentCheckbox).toBeDisabled();
    await act(async () => pendingPatch.reject(new Error('private mutation detail')));
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to update checklist. Please try again.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('private mutation detail');
  });

  it('blocks synchronous re-entry and shows success only after the clipboard promise resolves', async () => {
    const pending = deferred<void>();
    const writeText = vi.fn(() => pending.promise);
    setClipboard(writeText);
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findAllByRole('checkbox', { name: 'Alpha open item' });

    const button = copyButton(4);
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(screen.queryByText('Checklist labels copied.')).not.toBeInTheDocument();

    await act(async () => pending.resolve());
    expect(await screen.findByRole('status')).toHaveTextContent('Checklist labels copied.');
    expect(button).toBeEnabled();
  });

  it('shows generic rejection and unavailable feedback, then permits retry', async () => {
    const writeText = vi.fn()
      .mockRejectedValueOnce(new Error('private clipboard detail'))
      .mockResolvedValueOnce(undefined);
    setClipboard(writeText);
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findAllByRole('checkbox', { name: 'Alpha open item' });

    fireEvent.click(copyButton(4));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not copy checklist labels. Try again or copy them manually.',
    );
    expect(screen.getByRole('alert')).not.toHaveTextContent('private clipboard detail');

    fireEvent.click(copyButton(4));
    expect(await screen.findByRole('status')).toHaveTextContent('Checklist labels copied.');
    expect(writeText).toHaveBeenCalledTimes(2);

    setClipboard(undefined);
    fireEvent.click(copyButton(4));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not copy checklist labels.');
    expect(screen.queryByText('Clipboard unavailable')).not.toBeInTheDocument();
  });

  it('clears feedback when search, completed filter, or visible row identity/label changes', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findAllByRole('checkbox', { name: 'Alpha open item' });

    fireEvent.click(copyButton(4));
    expect(await screen.findByRole('status')).toHaveTextContent('Checklist labels copied.');
    fireEvent.click(screen.getByRole('button', { name: 'Hide completed items' }));
    expect(screen.queryByText('Checklist labels copied.')).not.toBeInTheDocument();

    fireEvent.click(copyButton(3));
    expect(await screen.findByRole('status')).toHaveTextContent('Checklist labels copied.');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded checklist items' }), {
      target: { value: 'beta' },
    });
    expect(screen.queryByText('Checklist labels copied.')).not.toBeInTheDocument();

    fireEvent.click(copyButton(1));
    expect(await screen.findByRole('status')).toHaveTextContent('Checklist labels copied.');
    await act(async () => setChecklist([
      { id: lastId, taskId, label: 'Beta revised item', checked: false, order: 0 },
    ]));
    await screen.findByRole('checkbox', { name: 'Beta revised item' });
    expect(screen.queryByText('Checklist labels copied.')).not.toBeInTheDocument();
  });

  it('suppresses a deferred success across an A-to-B-to-A query transition', async () => {
    const oldWrite = deferred<void>();
    const newWrite = deferred<void>();
    const writeText = vi.fn().mockReturnValueOnce(oldWrite.promise).mockReturnValueOnce(newWrite.promise);
    setClipboard(writeText);
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findAllByRole('checkbox', { name: 'Alpha open item' });

    fireEvent.click(copyButton(4));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded checklist items' }), {
      target: { value: 'Beta' },
    });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded checklist items' }), {
      target: { value: '' },
    });
    await act(async () => oldWrite.resolve());
    expect(screen.queryByText('Checklist labels copied.')).not.toBeInTheDocument();
    expect(copyButton(4)).toBeEnabled();

    fireEvent.click(copyButton(4));
    expect(writeText).toHaveBeenCalledTimes(2);
    await act(async () => newWrite.resolve());
    expect(await screen.findByRole('status')).toHaveTextContent('Checklist labels copied.');
  });

  it('suppresses stale failures after a filter change and a loaded row replacement', async () => {
    const oldWrite = deferred<void>();
    const writeText = vi.fn(() => oldWrite.promise);
    setClipboard(writeText);
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findAllByRole('checkbox', { name: 'Alpha open item' });

    fireEvent.click(copyButton(4));
    fireEvent.click(screen.getByRole('button', { name: 'Hide completed items' }));
    await act(async () => setChecklist([
      { id: lastId, taskId, label: 'Replacement item', checked: false, order: 0 },
    ]));
    await screen.findByRole('checkbox', { name: 'Replacement item' });
    await act(async () => oldWrite.reject(new Error('stale private error')));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Checklist labels copied.')).not.toBeInTheDocument();
    expect(copyButton(1)).toBeEnabled();
  });

  it('suppresses stale success when a row ID changes but its visible label stays the same', async () => {
    const oldWrite = deferred<void>();
    const writeText = vi.fn(() => oldWrite.promise);
    setClipboard(writeText);
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findAllByRole('checkbox', { name: 'Alpha open item' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded checklist items' }), {
      target: { value: 'Beta' },
    });

    fireEvent.click(copyButton(1));
    await act(async () => setChecklist([
      { id: replacementId, taskId, label: 'Beta open item', checked: false, order: 0 },
    ]));
    await screen.findByRole('checkbox', { name: 'Beta open item' });
    await act(async () => oldWrite.resolve());

    expect(screen.queryByText('Checklist labels copied.')).not.toBeInTheDocument();
    expect(copyButton(1)).toBeEnabled();
  });

  it('drops pending copy feedback on collapse', async () => {
    const oldWrite = deferred<void>();
    const writeText = vi.fn(() => oldWrite.promise);
    setClipboard(writeText);
    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findAllByRole('checkbox', { name: 'Alpha open item' });

    fireEvent.click(copyButton(4));
    fireEvent.click(screen.getByRole('button', { name: /Checklist/ }));
    expect(screen.queryByRole('searchbox', { name: 'Search loaded checklist items' })).not.toBeInTheDocument();
    await act(async () => oldWrite.resolve());
    fireEvent.click(screen.getByRole('button', { name: /Checklist/ }));
    expect(screen.queryByText('Checklist labels copied.')).not.toBeInTheDocument();
  });

  it('does not label a different task after an older clipboard success', async () => {
    const oldWrite = deferred<void>();
    const writeText = vi.fn(() => oldWrite.promise);
    setClipboard(writeText);
    const view = render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findAllByRole('checkbox', { name: 'Alpha open item' });

    fireEvent.click(copyButton(4));
    view.rerender(<TaskChecklist taskId={otherTaskId} />);
    await screen.findByRole('checkbox', { name: 'Other task item' });
    await act(async () => oldWrite.resolve());

    expect(screen.queryByText('Checklist labels copied.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(copyButton(1)).toBeEnabled();
  });
});
