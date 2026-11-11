import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import apiClient from '@/lib/api/client';
import { TaskReadiness } from './TaskReadiness';

const taskId = '11111111-1111-4111-8111-111111111111';
const firstBlockerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secondBlockerId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const thirdBlockerId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const queryClients: QueryClient[] = [];

function blocker(value: number, otherTaskId: string, title: string) {
  return {
    id: `00000000-0000-4000-8000-${value.toString().padStart(12, '0')}`,
    type: 'depends_on',
    direction: 'outgoing',
    fromTaskId: taskId,
    toTaskId: otherTaskId,
    otherTaskId,
    otherTaskTitle: title,
    otherTaskStatus: 'in_progress',
  };
}

function readiness(blockedBy: ReturnType<typeof blocker>[]) {
  return {
    taskId,
    dependencyCount: blockedBy.length + 2,
    ready: false,
    blockedBy,
  };
}

function renderReadiness(onParentKeyDown = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClients.push(queryClient);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <div onKeyDown={onParentKeyDown}>
        <TaskReadiness taskId={taskId} />
      </div>
    </QueryClientProvider>,
  );
  return { ...view, queryClient, onParentKeyDown };
}

let originalClipboardDescriptor: PropertyDescriptor | undefined;
let clipboardDescriptorCaptured = false;

function setClipboard(writeText: (text: string) => Promise<void>) {
  if (!clipboardDescriptorCaptured) {
    originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    clipboardDescriptorCaptured = true;
  }
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

afterEach(() => {
  cleanup();
  queryClients.splice(0).forEach((queryClient) => queryClient.clear());
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
  originalClipboardDescriptor = undefined;
  clipboardDescriptorCaptured = false;
  vi.restoreAllMocks();
});

describe('TaskReadiness search Escape recovery', () => {
  it('clears only a nonempty query, keeps focus and disclosure, and restores filtered rows in loaded order', async () => {
    const rows = [
      blocker(1, firstBlockerId, 'Alpha blocker'),
      blocker(2, secondBlockerId, 'Needle blocker'),
      blocker(3, thirdBlockerId, 'Needle later blocker'),
    ];
    const get = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness(rows),
    } as never);
    const view = renderReadiness();

    const search = await screen.findByRole('searchbox', { name: 'Search loaded blockers' });
    expect(search).toHaveAttribute('aria-keyshortcuts', 'Escape');
    expect(search).toHaveAccessibleDescription(
      'Filters the already-loaded readiness blockers locally. Press Escape to clear search.',
    );
    fireEvent.change(search, { target: { value: 'needle' } });
    expect(screen.getByText('Showing 2 of 3 loaded blocking dependencies.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Hide blocking tasks' }));
    expect(screen.getByRole('button', { name: 'Show blocking tasks' })).toHaveAttribute('aria-expanded', 'false');
    search.focus();
    const handled = fireEvent.keyDown(search, { key: 'Escape' });

    expect(handled).toBe(false);
    expect(view.onParentKeyDown).not.toHaveBeenCalled();
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(screen.getByText('3 of 5 dependency links are blocking this task.')).toBeInTheDocument();
    expect(screen.getByText('Showing 3 of 3 loaded blocking dependencies.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show blocking tasks' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('list', { name: 'Loaded readiness blockers', hidden: true })).not.toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Show blocking tasks' }));
    const list = screen.getByRole('list', { name: 'Loaded readiness blockers' });
    expect(within(list).getAllByRole('listitem').map((row) => row.textContent?.replace(/\s+/g, ' ').trim()))
      .toEqual(['Alpha blockerIn Progress', 'Needle blockerIn Progress', 'Needle later blockerIn Progress']);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(`/tasks/${taskId}/readiness`);
  });

  it('clears a whitespace-only raw query while consuming only that plain Escape', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness([blocker(4, firstBlockerId, 'Alpha blocker')]),
    } as never);
    const view = renderReadiness();
    const search = await screen.findByRole('searchbox', { name: 'Search loaded blockers' });
    fireEvent.change(search, { target: { value: '   ' } });
    expect(search).toHaveValue('   ');
    search.focus();

    fireEvent.keyDown(search, { key: 'Escape' });

    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(view.onParentKeyDown).not.toHaveBeenCalled();
    expect(screen.getByText('Showing 1 of 1 loaded blocking dependencies.')).toBeInTheDocument();
  });

  it('does not intercept empty, composing, modified or unrelated keys, or Escape outside the input', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness([blocker(5, firstBlockerId, 'Alpha blocker')]),
    } as never);
    const view = renderReadiness();
    const search = await screen.findByRole('searchbox', { name: 'Search loaded blockers' });

    const emptyEscape = fireEvent.keyDown(search, { key: 'Escape' });
    expect(emptyEscape).toBe(true);
    expect(view.onParentKeyDown).toHaveBeenCalledTimes(1);
    expect(search).toHaveValue('');

    fireEvent.change(search, { target: { value: 'alpha' } });
    view.onParentKeyDown.mockClear();
    const composing = fireEvent.keyDown(search, { key: 'Escape', isComposing: true });
    expect(composing).toBe(true);
    expect(view.onParentKeyDown).toHaveBeenCalledTimes(1);
    expect(search).toHaveValue('alpha');

    for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) {
      view.onParentKeyDown.mockClear();
      const bubbled = fireEvent.keyDown(search, { key: 'Escape', [modifier]: true });
      expect(bubbled).toBe(true);
      expect(view.onParentKeyDown).toHaveBeenCalledTimes(1);
      expect(search).toHaveValue('alpha');
    }

    view.onParentKeyDown.mockClear();
    expect(fireEvent.keyDown(search, { key: 'Enter' })).toBe(true);
    expect(view.onParentKeyDown).toHaveBeenCalledTimes(1);
    view.onParentKeyDown.mockClear();
    expect(fireEvent.keyDown(view.container.querySelector('div')!, { key: 'Escape' })).toBe(true);
    expect(view.onParentKeyDown).toHaveBeenCalledTimes(1);
    expect(search).toHaveValue('alpha');
  });

  it('does not copy on Escape and still copies all loaded unique IDs afterward', async () => {
    const rows = [
      blocker(6, firstBlockerId, 'Alpha blocker'),
      blocker(7, secondBlockerId, 'Needle blocker'),
      blocker(8, firstBlockerId, 'Needle duplicate'),
    ];
    const get = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness(rows),
    } as never);
    const mutations = [
      vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('unexpected mutation')),
      vi.spyOn(apiClient, 'put').mockRejectedValue(new Error('unexpected mutation')),
      vi.spyOn(apiClient, 'patch').mockRejectedValue(new Error('unexpected mutation')),
      vi.spyOn(apiClient, 'delete').mockRejectedValue(new Error('unexpected mutation')),
    ];
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    const initialLocation = window.location.href;
    renderReadiness();
    const search = await screen.findByRole('searchbox', { name: 'Search loaded blockers' });

    fireEvent.change(search, { target: { value: 'needle' } });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(writeText).not.toHaveBeenCalled();
    expect(search).toHaveValue('');
    expect(screen.getByText('Showing 3 of 3 loaded blocking dependencies.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Copy loaded blocker IDs' }));
    expect(await screen.findByText('Blocker IDs copied.')).toBeVisible();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(`${firstBlockerId}\n${secondBlockerId}`);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(`/tasks/${taskId}/readiness`);
    mutations.forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
    expect(window.location.href).toBe(initialLocation);
  });
});
