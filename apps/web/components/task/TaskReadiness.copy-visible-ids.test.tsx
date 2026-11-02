import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import apiClient from '@/lib/api/client';
import { TaskReadiness } from './TaskReadiness';

const taskId = '11111111-1111-4111-8111-111111111111';
const anotherTaskId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const firstBlockerId = '22222222-2222-4222-8222-222222222222';
const secondBlockerId = '33333333-3333-4333-8333-333333333333';
const thirdBlockerId = '44444444-4444-4444-8444-444444444444';
const edgeIds = [
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
];
const queryClients: QueryClient[] = [];
let originalClipboardDescriptor: PropertyDescriptor | undefined;
let clipboardDescriptorCaptured = false;

function blocker(
  id: string,
  otherTaskId: string,
  title: string,
  withheld = false,
  sourceTaskId = taskId,
) {
  return {
    id,
    type: 'depends_on',
    direction: 'outgoing',
    fromTaskId: sourceTaskId,
    toTaskId: otherTaskId,
    otherTaskId,
    otherTaskTitle: title,
    ...(withheld ? { otherTaskTitleWithheld: true } : {}),
    otherTaskStatus: 'in_progress',
  };
}

function readiness(id: string, blockedBy: Array<Record<string, unknown>>) {
  return {
    taskId: id,
    dependencyCount: blockedBy.length + 1,
    ready: false,
    blockedBy,
  };
}

function renderReadiness(id = taskId) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClients.push(queryClient);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TaskReadiness taskId={id} />
    </QueryClientProvider>,
  );

  return {
    ...view,
    queryClient,
    rerenderTask: (nextId: string) => view.rerender(
      <QueryClientProvider client={queryClient}>
        <TaskReadiness taskId={nextId} />
      </QueryClientProvider>,
    ),
  };
}

function setClipboard(writeText?: (text: string) => Promise<void>) {
  if (!clipboardDescriptorCaptured) {
    originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    clipboardDescriptorCaptured = true;
  }
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

function rows(id = taskId) {
  return [
    blocker(edgeIds[0], firstBlockerId, 'Alpha hidden title', false, id),
    blocker(edgeIds[1], secondBlockerId, 'Needle visible first', false, id),
    blocker(edgeIds[2], firstBlockerId, 'Needle duplicate', false, id),
    blocker(edgeIds[3], thirdBlockerId, 'Needle withheld title', true, id),
  ];
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

describe('TaskReadiness visible blocker ID copy', () => {
  it('copies unique visible IDs in first-visible order and leaves the all-loaded action unchanged', async () => {
    const get = vi.spyOn(apiClient, 'get').mockResolvedValueOnce({
      data: readiness(taskId, rows()),
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
    expect(screen.getByText('Showing 2 of 4 loaded blocking dependencies.')).toBeInTheDocument();
    expect(screen.queryByText('Needle withheld title')).not.toBeInTheDocument();

    const visibleButton = screen.getByRole('button', { name: 'Copy visible blocker IDs (2)' });
    expect(visibleButton).toHaveAttribute('type', 'button');
    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(visibleButton);
    expect(writeText).toHaveBeenLastCalledWith(`${secondBlockerId}\n${firstBlockerId}`);
    expect(await screen.findByRole('status')).toHaveTextContent('Visible blocker IDs copied.');
    expect(writeText.mock.calls[0][0]).not.toContain('Needle');

    fireEvent.click(screen.getByRole('button', { name: 'Copy loaded blocker IDs' }));
    expect(writeText).toHaveBeenLastCalledWith(`${firstBlockerId}\n${secondBlockerId}\n${thirdBlockerId}`);
    expect(await screen.findByText('Blocker IDs copied.')).toBeVisible();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(`/tasks/${taskId}/readiness`);
    mutations.forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
    expect(window.location.href).toBe(initialLocation);
  });

  it('does not write for typing, Escape, collapse, or zero results, and isolates pending state', async () => {
    let finishVisibleCopy: (() => void) | undefined;
    const writeText = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishVisibleCopy = resolve; }))
      .mockResolvedValueOnce(undefined);
    setClipboard(writeText);
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ data: readiness(taskId, rows()) } as never);
    renderReadiness();

    const search = await screen.findByRole('searchbox', { name: 'Search loaded blockers' });
    fireEvent.change(search, { target: { value: 'no-match' } });
    const emptyButton = screen.getByRole('button', { name: 'Copy visible blocker IDs (0)' });
    expect(emptyButton).toBeDisabled();
    fireEvent.click(emptyButton);
    expect(writeText).not.toHaveBeenCalled();

    fireEvent.change(search, { target: { value: 'needle' } });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');
    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Hide blocking tasks' }));
    expect(writeText).not.toHaveBeenCalled();

    const visibleButton = screen.getByRole('button', { name: 'Copy visible blocker IDs (3)' });
    fireEvent.click(visibleButton);
    expect(visibleButton).toBeDisabled();
    fireEvent.click(visibleButton);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(`${firstBlockerId}\n${secondBlockerId}\n${thirdBlockerId}`);
    expect(screen.queryByText('Visible blocker IDs copied.')).not.toBeInTheDocument();

    const allLoadedButton = screen.getByRole('button', { name: 'Copy loaded blocker IDs' });
    expect(allLoadedButton).toBeEnabled();
    fireEvent.click(allLoadedButton);
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith(`${firstBlockerId}\n${secondBlockerId}\n${thirdBlockerId}`);
    expect(await screen.findByText('Blocker IDs copied.')).toBeVisible();
    expect(screen.queryByText('Visible blocker IDs copied.')).not.toBeInTheDocument();

    await act(async () => finishVisibleCopy?.());
    expect(await screen.findByText('Visible blocker IDs copied.')).toBeVisible();
  });

  it('shows a generic failure when the clipboard API is missing', async () => {
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ data: readiness(taskId, rows()) } as never);
    setClipboard();
    renderReadiness();

    fireEvent.click(await screen.findByRole('button', { name: 'Copy visible blocker IDs (3)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not copy visible blocker IDs. Try copying them manually.',
    );
  });

  it('shows a generic failure without exposing a rejected clipboard error', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('private clipboard error with withheld title'));
    setClipboard(writeText);
    vi.spyOn(apiClient, 'get').mockResolvedValueOnce({ data: readiness(taskId, rows()) } as never);
    renderReadiness();

    fireEvent.click(await screen.findByRole('button', { name: 'Copy visible blocker IDs (3)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not copy visible blocker IDs. Try copying them manually.',
    );
    expect(screen.queryByText(/private clipboard error|withheld title/)).not.toBeInTheDocument();
  });

  const deferredChanges = ['query', 'aba', 'task', 'data'] as const;
  const deferredOutcomes = ['resolve', 'reject'] as const;

  for (const change of deferredChanges) {
    for (const outcome of deferredOutcomes) {
      it(`ignores a deferred ${outcome} after ${change} changes the visible-copy snapshot`, async () => {
        let settleOldCopy: (() => void) | undefined;
        let rejectOldCopy: ((error: Error) => void) | undefined;
        const writeText = vi.fn()
          .mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
            settleOldCopy = resolve;
            rejectOldCopy = reject;
          }))
          .mockResolvedValueOnce(undefined);
        setClipboard(writeText);
        const get = vi.spyOn(apiClient, 'get').mockImplementation(async (url) => {
          const id = url === `/tasks/${anotherTaskId}/readiness` ? anotherTaskId : taskId;
          return { data: readiness(id, rows(id)) } as never;
        });
        const view = renderReadiness();
        const search = await screen.findByRole('searchbox', { name: 'Search loaded blockers' });
        if (change === 'query' || change === 'aba') {
          fireEvent.change(search, { target: { value: 'needle' } });
        }
        const oldCount = change === 'query' || change === 'aba' ? 2 : 3;
        const oldButton = await screen.findByRole('button', { name: `Copy visible blocker IDs (${oldCount})` });
        fireEvent.click(oldButton);
        expect(oldButton).toBeDisabled();

        if (change === 'query') {
          fireEvent.change(search, { target: { value: 'alpha' } });
          await screen.findByRole('button', { name: 'Copy visible blocker IDs (1)' });
        } else if (change === 'aba') {
          fireEvent.change(search, { target: { value: 'alpha' } });
          await screen.findByRole('button', { name: 'Copy visible blocker IDs (1)' });
          fireEvent.change(search, { target: { value: 'needle' } });
          await screen.findByRole('button', { name: 'Copy visible blocker IDs (2)' });
        } else if (change === 'task') {
          view.rerenderTask(anotherTaskId);
          await screen.findByRole('button', { name: 'Copy visible blocker IDs (3)' });
        } else {
          await act(async () => {
            view.queryClient.setQueryData(
              ['tasks', taskId, 'readiness'],
              readiness(taskId, [blocker(edgeIds[0], thirdBlockerId, 'Changed data')]),
            );
          });
          await screen.findByRole('button', { name: 'Copy visible blocker IDs (1)' });
        }

        await act(async () => {
          if (outcome === 'resolve') settleOldCopy?.();
          else rejectOldCopy?.(new Error('old private error'));
        });
        expect(screen.queryByText('Visible blocker IDs copied.')).not.toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();

        const currentCount = change === 'aba' ? 2 : change === 'task' ? 3 : 1;
        const currentButton = screen.getByRole('button', {
          name: `Copy visible blocker IDs (${currentCount})`,
        });
        expect(currentButton).toBeEnabled();
        fireEvent.click(currentButton);
        expect(writeText).toHaveBeenCalledTimes(2);
        const expectedCurrentValue = {
          query: firstBlockerId,
          aba: `${secondBlockerId}\n${firstBlockerId}`,
          task: `${firstBlockerId}\n${secondBlockerId}\n${thirdBlockerId}`,
          data: thirdBlockerId,
        }[change];
        expect(writeText).toHaveBeenLastCalledWith(expectedCurrentValue);
        expect(await screen.findByText('Visible blocker IDs copied.')).toBeVisible();
        expect(get).toHaveBeenCalledTimes(change === 'task' ? 2 : 1);
      });
    }
  }
});
