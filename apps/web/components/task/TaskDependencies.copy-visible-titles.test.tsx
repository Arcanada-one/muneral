import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import apiClient from '@/lib/api/client';
import { TaskDependencies } from './TaskDependencies';

const taskId = '11111111-1111-4111-8111-111111111111';
const otherTaskId = '88888888-8888-4888-8888-888888888888';

type DependencyFixture = {
  id: string;
  type: string;
  direction: 'incoming' | 'outgoing';
  fromTaskId: string;
  toTaskId: string;
  otherTaskId: string;
  otherTaskTitle?: string | null;
  otherTaskTitleWithheld?: boolean;
  otherTaskStatus: string;
};

function dependency(
  id: string,
  visibleTaskId: string,
  title: string | null | undefined,
  status = 'todo',
  direction: 'incoming' | 'outgoing' = 'incoming',
  currentTaskId = taskId,
): DependencyFixture {
  const row: DependencyFixture = {
    id,
    type: 'depends_on',
    direction,
    fromTaskId: direction === 'outgoing' ? currentTaskId : visibleTaskId,
    toTaskId: direction === 'outgoing' ? visibleTaskId : currentTaskId,
    otherTaskId: visibleTaskId,
    otherTaskStatus: status,
  };
  if (title !== undefined) row.otherTaskTitle = title;
  return row;
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

function titleCopyButton(count: number) {
  return screen.getByRole('button', { name: `Copy available dependency titles (${count})` });
}

function idCopyButton(count: number) {
  return screen.getByRole('button', { name: `Copy visible dependency task IDs (${count})` });
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

describe('copy available visible dependency titles', () => {
  it('copies exact nonempty loaded titles after intersecting filters, preserving order and duplicates', async () => {
    const withheld = dependency('dep-withheld', 'needle-withheld', null);
    withheld.otherTaskTitleWithheld = true;
    Object.defineProperty(withheld, 'otherTaskTitle', {
      configurable: true,
      get: () => { throw new Error('withheld title must not be read'); },
    });
    const rows = [
      dependency('dep-first', 'needle-first', ' First '),
      dependency('dep-blank', 'needle-blank', ' \t '),
      dependency('dep-missing', 'needle-missing', undefined),
      dependency('dep-null', 'needle-null', null),
      withheld,
      dependency('dep-second', 'needle-second', 'Second'),
      dependency('dep-duplicate', 'needle-duplicate', ' First '),
      dependency('dep-outgoing', 'needle-outgoing', 'Outgoing title', 'todo', 'outgoing'),
      dependency('dep-completed', 'needle-completed', 'Completed title', 'done'),
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

    expect(writeText).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search loaded dependencies' }), {
      target: { value: 'needle' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Dependency direction' }), {
      target: { value: 'incoming' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide completed dependencies' }));

    expect(screen.getByText('Showing 7 matching of 9 loaded dependencies.')).toBeInTheDocument();
    expect(titleCopyButton(3)).toBeEnabled();
    expect(idCopyButton(7)).toBeEnabled();
    fireEvent.click(titleCopyButton(3));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith(' First \nSecond\n First ');
    expect(writeText.mock.calls[0][0]).not.toContain('needle-');
    expect(writeText.mock.calls[0][0]).not.toContain('Outgoing title');
    expect(writeText.mock.calls[0][0]).not.toContain('Completed title');
    expect(await screen.findByText('Dependency titles copied.')).toBeInTheDocument();
    expect(apiClient.get).not.toHaveBeenCalled();
    expect(mutations.every((mutation) => mutation.mock.calls.length === 0)).toBe(true);
  });

  it('disables when no title is eligible and leaves visible ID copying available', async () => {
    const withheld = dependency('dep-withheld', 'withheld-id', null);
    withheld.otherTaskTitleWithheld = true;
    Object.defineProperty(withheld, 'otherTaskTitle', {
      configurable: true,
      get: () => { throw new Error('withheld title must not be read'); },
    });
    const rows = [withheld, dependency('dep-blank', 'blank-id', '   '), dependency('dep-null', 'null-id', null)];
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mountDependencies(rows);

    expect(titleCopyButton(0)).toBeDisabled();
    expect(idCopyButton(3)).toBeEnabled();
    fireEvent.click(titleCopyButton(0));
    expect(writeText).not.toHaveBeenCalled();

    fireEvent.click(idCopyButton(3));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('withheld-id\nblank-id\nnull-id'));
    expect(screen.queryByText('Dependency titles copied.')).not.toBeInTheDocument();
    expect(screen.getByText('Dependency task IDs copied.')).toBeInTheDocument();
  });

  it('guards synchronous re-entry and waits for clipboard resolution before success', async () => {
    const pending = deferred<void>();
    const writeText = vi.fn(() => pending.promise);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mountDependencies([dependency('dep-one', 'one-id', 'One')]);

    const button = titleCopyButton(1);
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(screen.queryByText('Dependency titles copied.')).not.toBeInTheDocument();

    await act(async () => pending.resolve());
    expect(await screen.findByText('Dependency titles copied.')).toBeInTheDocument();
    expect(button).toBeEnabled();
  });

  it('keeps title and ID pending guards independent', async () => {
    const titleWrite = deferred<void>();
    const firstIdWrite = deferred<void>();
    const secondIdWrite = deferred<void>();
    const idWrites = [firstIdWrite, secondIdWrite];
    let idWriteIndex = 0;
    const writeText = vi.fn((value: string) => value === 'Visible title'
      ? titleWrite.promise : idWrites[idWriteIndex++].promise);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mountDependencies([dependency('dep-one', 'one-id', 'Visible title')]);

    fireEvent.click(idCopyButton(1));
    expect(idCopyButton(1)).toBeDisabled();
    expect(titleCopyButton(1)).toBeEnabled();
    act(() => {
      fireEvent.click(titleCopyButton(1));
      fireEvent.click(titleCopyButton(1));
    });
    expect(titleCopyButton(1)).toBeDisabled();
    expect(idCopyButton(1)).toBeDisabled();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(titleCopyButton(1)).toBeDisabled();
    expect(idCopyButton(1)).toBeDisabled();

    await act(async () => firstIdWrite.resolve());
    expect(screen.getByText('Dependency task IDs copied.')).toBeInTheDocument();
    expect(idCopyButton(1)).toBeEnabled();
    expect(titleCopyButton(1)).toBeDisabled();
    fireEvent.click(idCopyButton(1));
    expect(writeText).toHaveBeenCalledTimes(3);
    expect(idCopyButton(1)).toBeDisabled();
    await act(async () => secondIdWrite.resolve());
    expect(screen.getByText('Dependency task IDs copied.')).toBeInTheDocument();
    expect(screen.queryByText('Dependency titles copied.')).not.toBeInTheDocument();
    await act(async () => titleWrite.resolve());
    expect(screen.getByText('Dependency titles copied.')).toBeInTheDocument();
  });

  it('shows only generic rejection or unavailable feedback and permits retry', async () => {
    const writeText = vi.fn()
      .mockRejectedValueOnce(new Error('private title payload'))
      .mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mountDependencies([dependency('dep-one', 'one-id', 'Visible title')]);

    fireEvent.click(titleCopyButton(1));
    const failure = await screen.findByRole('alert');
    expect(failure).toHaveTextContent('Could not copy dependency titles. Try again or copy them manually.');
    expect(failure).not.toHaveTextContent('private title payload');

    fireEvent.click(titleCopyButton(1));
    expect(await screen.findByText('Dependency titles copied.')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledTimes(2);

    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {} });
    fireEvent.click(titleCopyButton(1));
    const unavailable = await screen.findByRole('alert');
    expect(unavailable).toHaveTextContent('Could not copy dependency titles.');
    expect(unavailable).not.toHaveTextContent('Clipboard unavailable');
  });

  it('suppresses a stale success across filter A-B-A and allows copying the current batch', async () => {
    const oldWrite = deferred<void>();
    const newWrite = deferred<void>();
    const writeText = vi.fn().mockReturnValueOnce(oldWrite.promise).mockReturnValueOnce(newWrite.promise);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mountDependencies([
      dependency('dep-alpha', 'alpha-id', 'Alpha'),
      dependency('dep-beta', 'beta-id', 'Beta'),
    ]);

    fireEvent.click(titleCopyButton(2));
    const search = screen.getByRole('textbox', { name: 'Search loaded dependencies' });
    fireEvent.change(search, { target: { value: 'Alpha' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search loaded dependencies' }), { target: { value: 'Beta' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search loaded dependencies' }), { target: { value: '' } });
    await act(async () => oldWrite.resolve());

    expect(screen.queryByText('Dependency titles copied.')).not.toBeInTheDocument();
    expect(titleCopyButton(2)).toBeEnabled();
    fireEvent.click(titleCopyButton(2));
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText.mock.calls[1][0]).toBe('Alpha\nBeta');
    await act(async () => newWrite.resolve());
    expect(screen.getByText('Dependency titles copied.')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search loaded dependencies' }), {
      target: { value: 'Alpha' },
    });
    expect(screen.queryByText('Dependency titles copied.')).not.toBeInTheDocument();
  });

  it('suppresses stale rejection after a same-task loaded-data update and clears prior success', async () => {
    const oldWrite = deferred<void>();
    const writeText = vi.fn().mockReturnValueOnce(oldWrite.promise).mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const view = mountDependencies([dependency('dep-old', 'old-id', 'Old title')]);

    fireEvent.click(titleCopyButton(1));
    await act(async () => view.queryClient.setQueryData(
      ['tasks', taskId, 'dependency-graph'],
      [dependency('dep-new', 'new-id', 'New title')],
    ));
    expect(await screen.findByText('New title')).toBeInTheDocument();
    await act(async () => oldWrite.reject(new Error('stale private failure')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(titleCopyButton(1)).toBeEnabled();
    fireEvent.click(titleCopyButton(1));
    expect(await screen.findByText('Dependency titles copied.')).toBeInTheDocument();
    expect(writeText.mock.calls[1][0]).toBe('New title');

    await act(async () => view.queryClient.setQueryData(
      ['tasks', taskId, 'dependency-graph'],
      [dependency('dep-newer', 'newer-id', 'Newest title')],
    ));
    await waitFor(() => expect(screen.queryByText('Dependency titles copied.')).not.toBeInTheDocument());
  });

  it('suppresses an obsolete completion after switching tasks', async () => {
    const oldWrite = deferred<void>();
    const writeText = vi.fn().mockReturnValueOnce(oldWrite.promise).mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const view = mountDependencies([dependency('dep-current', 'current-id', 'Current title')]);
    view.queryClient.setQueryData(
      ['tasks', otherTaskId, 'dependency-graph'],
      [dependency('dep-other', 'other-id', 'Other title', 'todo', 'incoming', otherTaskId)],
    );

    fireEvent.click(titleCopyButton(1));
    view.rerenderTask(otherTaskId);
    await act(async () => oldWrite.resolve());

    expect(screen.queryByText('Dependency titles copied.')).not.toBeInTheDocument();
    expect(titleCopyButton(1)).toBeEnabled();
    fireEvent.click(titleCopyButton(1));
    expect(await screen.findByText('Dependency titles copied.')).toBeInTheDocument();
    expect(writeText.mock.calls.map(([value]) => value)).toEqual(['Current title', 'Other title']);
  });
});
