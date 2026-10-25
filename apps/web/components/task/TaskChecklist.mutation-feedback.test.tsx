import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskChecklist } from './TaskChecklist';

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ default: api }));

const taskId = '10000000-0000-4000-8000-000000000001';
const nextTaskId = '10000000-0000-4000-8000-000000000003';
const nextItemId = '10000000-0000-4000-8000-000000000004';
const item = {
  id: '10000000-0000-4000-8000-000000000002',
  taskId,
  text: 'Write acceptance criteria',
  checked: false,
  position: 0,
};
const nextItem = {
  ...item,
  id: nextItemId,
  taskId: nextTaskId,
  text: 'Confirm owner handoff',
};
const siblingItem = {
  ...item,
  id: nextItemId,
  text: 'Review task notes',
};

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
function wrapper({ children }: PropsWithChildren) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  api.get.mockReset().mockResolvedValue({ data: [item] });
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
});

describe('TaskChecklist mutation feedback', () => {
  it('suppresses a second same-item PATCH synchronously and exposes pending state', async () => {
    const pending = deferred<{ data: typeof item }>();
    api.patch.mockReturnValue(pending.promise);

    render(<TaskChecklist taskId={taskId} />, { wrapper });
    const checkbox = await screen.findByRole('checkbox', { name: item.text });

    await act(async () => {
      fireEvent.click(checkbox);
      fireEvent.click(checkbox);
    });

    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(checkbox).toBeDisabled();
    expect(checkbox.closest('li')).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      pending.resolve({ data: { ...item, checked: true } });
      await pending.promise;
    });
    await waitFor(() => expect(checkbox).toBeEnabled());
  });

  it('does not let an old task completion clear a newer task key or expose its error', async () => {
    const oldRequest = deferred<{ data: typeof item }>();
    const newRequest = deferred<{ data: typeof nextItem }>();
    api.get.mockImplementation(async (url: string) => ({
      data: url.includes(nextTaskId) ? [nextItem] : [item],
    }));
    api.patch.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);

    const { rerender } = render(<TaskChecklist taskId={taskId} />, { wrapper });
    const oldCheckbox = await screen.findByRole('checkbox', { name: item.text });
    await act(async () => fireEvent.click(oldCheckbox));
    expect(oldCheckbox).toBeDisabled();

    rerender(<TaskChecklist taskId={nextTaskId} />);
    const newCheckbox = await screen.findByRole('checkbox', { name: nextItem.text });
    expect(newCheckbox).toBeEnabled();
    await act(async () => fireEvent.click(newCheckbox));
    expect(newCheckbox).toBeDisabled();

    await act(async () => {
      oldRequest.reject(new Error('Synthetic private server detail'));
      await oldRequest.promise.catch(() => undefined);
    });
    expect(newCheckbox).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => {
      newRequest.resolve({ data: { ...nextItem, checked: true } });
      await newRequest.promise;
    });
    await waitFor(() => expect(newCheckbox).toBeEnabled());
  });

  it('keeps a different checklist item available while one item is pending', async () => {
    const firstRequest = deferred<{ data: typeof item }>();
    const secondRequest = deferred<{ data: typeof siblingItem }>();
    api.get.mockResolvedValue({ data: [item, siblingItem] });
    api.patch.mockReturnValueOnce(firstRequest.promise).mockReturnValueOnce(secondRequest.promise);

    render(<TaskChecklist taskId={taskId} />, { wrapper });
    const firstCheckbox = await screen.findByRole('checkbox', { name: item.text });
    const secondCheckbox = await screen.findByRole('checkbox', { name: siblingItem.text });

    await act(async () => fireEvent.click(firstCheckbox));
    expect(firstCheckbox).toBeDisabled();
    expect(secondCheckbox).toBeEnabled();

    await act(async () => fireEvent.click(secondCheckbox));
    expect(api.patch).toHaveBeenCalledTimes(2);
    expect(secondCheckbox).toBeDisabled();

    await act(async () => {
      firstRequest.resolve({ data: { ...item, checked: true } });
      await firstRequest.promise;
    });
    expect(secondCheckbox).toBeDisabled();

    await act(async () => {
      secondRequest.resolve({ data: { ...siblingItem, checked: true } });
      await secondRequest.promise;
    });
    await waitFor(() => {
      expect(firstCheckbox).toBeEnabled();
      expect(secondCheckbox).toBeEnabled();
    });
  });

  it('shows a generic error when the real checklist PATCH rejects', async () => {
    const user = userEvent.setup();
    api.patch.mockRejectedValue(new Error('Synthetic private server detail'));

    render(<TaskChecklist taskId={taskId} />, { wrapper });
    const checkbox = await screen.findByRole('checkbox', { name: item.text });
    await user.click(checkbox);

    await waitFor(() => {
      expect(api.patch).toHaveBeenCalledWith(
        `/tasks/${taskId}/checklist/${item.id}`,
        { checked: true },
      );
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Unable to update checklist',
      );
    });

    expect(checkbox).not.toBeChecked();
    expect(checkbox).toBeEnabled();
    expect(screen.queryByText('Synthetic private server detail')).not.toBeInTheDocument();
  });

  it('does not carry a failed mutation alert into the next task', async () => {
    const user = userEvent.setup();
    api.patch.mockRejectedValue(new Error('Synthetic private server detail'));
    api.get.mockImplementation(async (url: string) => ({
      data: [{ ...item, taskId: url.split('/')[2] }],
    }));

    const { rerender } = render(<TaskChecklist taskId={taskId} />, { wrapper });
    await user.click(await screen.findByRole('checkbox', { name: item.text }));
    await screen.findByRole('alert');

    rerender(<TaskChecklist taskId={nextTaskId} />);
    await screen.findByRole('checkbox', { name: item.text });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
