import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskChecklist } from './TaskChecklist';

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ default: api }));

const taskId = '10000000-0000-4000-8000-000000000001';
const otherTaskId = '10000000-0000-4000-8000-000000000003';
const firstItem = {
  id: '10000000-0000-4000-8000-000000000002',
  taskId,
  text: 'Write acceptance criteria',
  checked: false,
  position: 0,
};
const otherItem = {
  id: '10000000-0000-4000-8000-000000000004',
  taskId: otherTaskId,
  text: 'Review release notes',
  checked: false,
  position: 0,
};

let client: QueryClient;
function wrapper({ children }: PropsWithChildren) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  api.get.mockReset();
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

describe('TaskChecklist read recovery', () => {
  it('keeps a successful empty checklist distinct from a failed read', async () => {
    api.get.mockResolvedValueOnce({ data: [] });

    render(<TaskChecklist taskId={taskId} />, { wrapper });

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(`/tasks/${taskId}/checklist`));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry checklist' })).not.toBeInTheDocument();
  });

  it('retries the current checklist read and renders the returned items', async () => {
    const user = userEvent.setup();
    api.get
      .mockRejectedValueOnce(new Error('Synthetic private read detail'))
      .mockResolvedValueOnce({ data: [firstItem] });

    render(<TaskChecklist taskId={taskId} />, { wrapper });

    expect(await screen.findByRole('alert')).toHaveTextContent('Checklist is unavailable');
    expect(screen.queryByText('Synthetic private read detail')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry checklist' }));

    expect(await screen.findByRole('checkbox', { name: firstItem.text })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.get).toHaveBeenNthCalledWith(1, `/tasks/${taskId}/checklist`);
    expect(api.get).toHaveBeenNthCalledWith(2, `/tasks/${taskId}/checklist`);
  });

  it('disables retry while the current read is pending and prevents duplicate requests', async () => {
    const user = userEvent.setup();
    let resolveRetry: ((value: { data: typeof firstItem[] }) => void) | undefined;
    api.get
      .mockRejectedValueOnce(new Error('Synthetic read failure'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }));

    render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Retry checklist' }));

    const retrying = await screen.findByRole('button', { name: 'Retrying checklist…' });
    expect(retrying).toBeDisabled();
    await user.click(retrying);
    expect(api.get).toHaveBeenCalledTimes(2);

    await act(async () => resolveRetry?.({ data: [firstItem] }));
    expect(await screen.findByRole('checkbox', { name: firstItem.text })).toBeInTheDocument();
  });

  it('keeps a late retry response scoped to the task whose query initiated it', async () => {
    const user = userEvent.setup();
    let resolveFirstTask: ((value: { data: typeof firstItem[] }) => void) | undefined;
    api.get
      .mockRejectedValueOnce(new Error('Initial read failure'))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstTask = resolve; }))
      .mockResolvedValueOnce({ data: [otherItem] });

    const view = render(<TaskChecklist taskId={taskId} />, { wrapper });
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Retry checklist' }));

    view.rerender(<TaskChecklist taskId={otherTaskId} />);
    expect(await screen.findByRole('checkbox', { name: otherItem.text })).toBeInTheDocument();
    await act(async () => resolveFirstTask?.({ data: [firstItem] }));

    await waitFor(() => {
      expect(screen.getByRole('checkbox', { name: otherItem.text })).toBeInTheDocument();
      expect(screen.queryByText(firstItem.text)).not.toBeInTheDocument();
    });
    expect(api.get).toHaveBeenNthCalledWith(3, `/tasks/${otherTaskId}/checklist`);
  });
});
