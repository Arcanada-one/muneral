import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import apiClient from '@/lib/api/client';
import { TaskDependencies } from './TaskDependencies';

const taskId = '11111111-1111-4111-8111-111111111111';
const otherTaskId = '99999999-9999-4999-8999-999999999999';

type DependencyFixture = {
  id: string;
  type: string;
  direction: 'incoming' | 'outgoing';
  fromTaskId: string;
  toTaskId: string;
  otherTaskId: string;
  otherTaskTitle: string | null;
  otherTaskTitleWithheld?: boolean;
  otherTaskStatus: string;
};

function dependency(
  id: string,
  visibleTaskId: string,
  title: string | null,
  status: string,
  direction: 'incoming' | 'outgoing' = 'incoming',
  currentTaskId = taskId,
): DependencyFixture {
  return {
    id,
    type: 'depends_on',
    direction,
    fromTaskId: direction === 'outgoing' ? currentTaskId : visibleTaskId,
    toTaskId: direction === 'outgoing' ? visibleTaskId : currentTaskId,
    otherTaskId: visibleTaskId,
    otherTaskTitle: title,
    otherTaskStatus: status,
  };
}

function mountDependencies(rows: DependencyFixture[], currentTaskId = taskId) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(['tasks', currentTaskId, 'dependency-graph'], rows);
  const renderForTask = (id: string) => (
    <QueryClientProvider client={queryClient}>
      <TaskDependencies taskId={id} />
    </QueryClientProvider>
  );
  const view = render(renderForTask(currentTaskId));
  return {
    ...view,
    queryClient,
    rerenderTask: (id: string) => view.rerender(renderForTask(id)),
  };
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

function copyButton(count?: number) {
  return screen.getByRole('button', {
    name: `Copy visible dependency task IDs (${count ?? 0})`,
  });
}

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

beforeEach(() => {
  vi.spyOn(apiClient, 'get').mockResolvedValue({ data: [] } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

describe('copy visible loaded dependency task IDs', () => {
  it('copies only displayed IDs after composed filters, preserving order and duplicates', async () => {
    const firstId = '22222222-2222-4222-8222-222222222222';
    const rows = [
      dependency('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', firstId, 'Needle first', 'todo'),
      dependency('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '33333333-3333-4333-8333-333333333333', 'Needle completed', 'done'),
      dependency('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '44444444-4444-4444-8444-444444444444', 'Needle other direction', 'todo', 'outgoing'),
      dependency('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '55555555-5555-4555-8555-555555555555', 'Other title', 'todo'),
      dependency('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', firstId, 'Needle duplicate ID', 'in_progress'),
    ];
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const mutations = [
      vi.spyOn(apiClient, 'post'),
      vi.spyOn(apiClient, 'put'),
      vi.spyOn(apiClient, 'patch'),
      vi.spyOn(apiClient, 'delete'),
    ];
    mountDependencies(rows);

    fireEvent.change(screen.getByRole('textbox', { name: 'Search loaded dependencies' }), {
      target: { value: ' needle ' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Dependency direction' }), {
      target: { value: 'incoming' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide completed dependencies' }));

    expect(copyButton(2)).toBeEnabled();
    fireEvent.click(copyButton(2));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(`${firstId}\n${firstId}`);
    expect(writeText.mock.calls[0][0]).not.toContain('Needle');
    expect(writeText.mock.calls[0][0]).not.toContain('33333333');
    expect(writeText.mock.calls[0][0]).not.toContain('44444444');
    expect(writeText.mock.calls[0][0]).not.toContain('55555555');
    expect(screen.getByRole('status')).toHaveTextContent('Dependency task IDs copied.');
    expect(apiClient.get).not.toHaveBeenCalled();
    expect(mutations.every((mutation) => mutation.mock.calls.length === 0)).toBe(true);
  });

  it('disables the batch action for zero visible rows and never reads withheld titles', () => {
    const withheld = dependency(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '22222222-2222-4222-8222-222222222222',
      null,
      'todo',
    );
    withheld.otherTaskTitleWithheld = true;
    Object.defineProperty(withheld, 'otherTaskTitle', {
      configurable: true,
      get: () => { throw new Error('withheld title must not be read'); },
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mountDependencies([withheld]);

    fireEvent.change(screen.getByRole('textbox', { name: 'Search loaded dependencies' }), {
      target: { value: 'private title' },
    });
    expect(copyButton(0)).toBeDisabled();
    fireEvent.click(copyButton(0));
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByText('Showing 0 matching of 1 loaded dependencies.')).toBeInTheDocument();
  });

  it('uses a synchronous pending guard and shows success only after clipboard resolution', async () => {
    const pending = deferred<void>();
    const writeText = vi.fn(() => pending.promise);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mountDependencies([dependency(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '22222222-2222-4222-8222-222222222222',
      'Visible task',
      'todo',
    )]);

    const button = copyButton(1);
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(screen.queryByText('Dependency task IDs copied.')).not.toBeInTheDocument();

    await act(async () => pending.resolve());
    expect(await screen.findByRole('status')).toHaveTextContent('Dependency task IDs copied.');
    expect(button).toBeEnabled();
  });

  it('shows generic rejection and unavailable feedback, then allows recovery', async () => {
    const writeText = vi.fn()
      .mockRejectedValueOnce(new Error('private clipboard detail'))
      .mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mountDependencies([dependency(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '22222222-2222-4222-8222-222222222222',
      'Visible task',
      'todo',
    )]);

    fireEvent.click(copyButton(1));
    const failure = await screen.findByRole('alert');
    expect(failure).toHaveTextContent('Could not copy dependency task IDs. Try again or copy them manually.');
    expect(failure).not.toHaveTextContent('private clipboard detail');

    fireEvent.click(copyButton(1));
    expect(await screen.findByRole('status')).toHaveTextContent('Dependency task IDs copied.');
    expect(writeText).toHaveBeenCalledTimes(2);

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {} });
    fireEvent.click(copyButton(1));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not copy dependency task IDs.');
    expect(screen.queryByText('Clipboard unavailable')).not.toBeInTheDocument();
  });

  it('clears resolved feedback when filters, query, or loaded data change the batch', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const view = mountDependencies([
      dependency('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222', 'Incoming row', 'todo'),
      dependency('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '33333333-3333-4333-8333-333333333333', 'Outgoing row', 'todo', 'outgoing'),
    ]);

    fireEvent.click(copyButton(2));
    expect(await screen.findByRole('status')).toHaveTextContent('Dependency task IDs copied.');
    fireEvent.change(screen.getByRole('combobox', { name: 'Dependency direction' }), {
      target: { value: 'outgoing' },
    });
    expect(screen.queryByText('Dependency task IDs copied.')).not.toBeInTheDocument();

    fireEvent.click(copyButton(1));
    expect(await screen.findByRole('status')).toHaveTextContent('Dependency task IDs copied.');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search loaded dependencies' }), {
      target: { value: 'no match' },
    });
    expect(screen.queryByText('Dependency task IDs copied.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));

    fireEvent.click(copyButton(1));
    expect(await screen.findByRole('status')).toHaveTextContent('Dependency task IDs copied.');
    await act(async () => view.queryClient.setQueryData(
      ['tasks', taskId, 'dependency-graph'],
      [dependency('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '44444444-4444-4444-8444-444444444444', 'Replacement row', 'todo', 'outgoing')],
    ));
    await waitFor(() => expect(screen.getByText('Replacement row')).toBeInTheDocument());
    expect(screen.queryByText('Dependency task IDs copied.')).not.toBeInTheDocument();
  });

  it('suppresses an old success across an A-B-A query change and releases the new batch', async () => {
    const oldWrite = deferred<void>();
    const newWrite = deferred<void>();
    const writeText = vi.fn().mockReturnValueOnce(oldWrite.promise).mockReturnValueOnce(newWrite.promise);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mountDependencies([
      dependency('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222', 'Alpha', 'todo'),
      dependency('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '33333333-3333-4333-8333-333333333333', 'Beta', 'todo'),
    ]);

    fireEvent.click(copyButton(2));
    const search = screen.getByRole('textbox', { name: 'Search loaded dependencies' });
    fireEvent.change(search, { target: { value: 'Beta' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search loaded dependencies' }), { target: { value: '' } });
    await act(async () => oldWrite.resolve());
    expect(screen.queryByText('Dependency task IDs copied.')).not.toBeInTheDocument();
    expect(copyButton(2)).toBeEnabled();

    fireEvent.click(copyButton(2));
    expect(writeText).toHaveBeenCalledTimes(2);
    await act(async () => newWrite.resolve());
    expect(await screen.findByRole('status')).toHaveTextContent('Dependency task IDs copied.');
  });

  it('suppresses a stale rejection after filter and loaded-data changes', async () => {
    const oldWrite = deferred<void>();
    const writeText = vi.fn(() => oldWrite.promise);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const rows = [
      dependency('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222', 'Incoming', 'todo'),
      dependency('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '33333333-3333-4333-8333-333333333333', 'Outgoing', 'todo', 'outgoing'),
    ];
    const view = mountDependencies(rows);

    fireEvent.click(copyButton(2));
    fireEvent.change(screen.getByRole('combobox', { name: 'Dependency direction' }), {
      target: { value: 'outgoing' },
    });
    await act(async () => view.queryClient.setQueryData(
      ['tasks', taskId, 'dependency-graph'],
      [dependency('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '44444444-4444-4444-8444-444444444444', 'Updated', 'todo', 'outgoing')],
    ));
    expect(await screen.findByText('Updated')).toBeInTheDocument();
    await act(async () => oldWrite.reject(new Error('stale private rejection')));

    expect(screen.getByText('Updated')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Dependency task IDs copied.')).not.toBeInTheDocument();
    expect(copyButton(1)).toBeEnabled();
  });

  it('does not show a pending result after switching to another task', async () => {
    const oldWrite = deferred<void>();
    const writeText = vi.fn(() => oldWrite.promise);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const view = mountDependencies([dependency(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '22222222-2222-4222-8222-222222222222',
      'First task row',
      'todo',
    )]);
    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: [dependency(
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '33333333-3333-4333-8333-333333333333',
      'Second task row',
      'todo',
      'incoming',
      otherTaskId,
    )] } as never);

    fireEvent.click(copyButton(1));
    view.rerenderTask(otherTaskId);
    expect(await screen.findByText('Second task row')).toBeInTheDocument();
    await act(async () => oldWrite.resolve());

    expect(screen.queryByText('Dependency task IDs copied.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(copyButton(1)).toBeEnabled();
  });
});
