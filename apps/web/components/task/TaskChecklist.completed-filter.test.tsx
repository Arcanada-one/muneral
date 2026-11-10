import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
const otherOpenId = '10000000-0000-4000-8000-000000000006';
const otherDoneId = '10000000-0000-4000-8000-000000000007';

const initialResponse = [
  { id: firstId, taskId, text: 'First open item', checked: false, position: 0 },
  { id: completedId, taskId, text: 'Finished item', checked: true, position: 1 },
  { id: secondId, taskId, text: 'Second open item', checked: false, position: 2 },
];
const otherTaskResponse = [
  { id: otherOpenId, taskId: otherTaskId, text: 'Other task open item', checked: false, position: 0 },
  { id: otherDoneId, taskId: otherTaskId, text: 'Other task finished item', checked: true, position: 1 },
];

let client: QueryClient;
function wrapper({ children }: PropsWithChildren) {
  return createElement(QueryClientProvider, { client }, children);
}

function visibleLabels() {
  const list = screen.queryByRole('list');
  return list
    ? Array.from(list.querySelectorAll('label')).map((label) => label.textContent)
    : [];
}

function setChecklist(items: ChecklistItem[]) {
  client.setQueryData(['tasks', taskId, 'checklist'], items);
}

beforeEach(() => {
  api.get.mockReset().mockImplementation(async (url: string) => ({
    data: url.startsWith(`/tasks/${otherTaskId}/`) ? otherTaskResponse : initialResponse,
  }));
  api.patch.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  cleanup();
  client.clear();
});

describe('TaskChecklist completed-item filter', () => {
  it('defaults to all items and hides then restores completed rows without changing full-list counts or order', async () => {
    const user = userEvent.setup();
    render(<TaskChecklist taskId={taskId} />, { wrapper });

    await screen.findByRole('checkbox', { name: 'First open item' });
    const disclosure = screen.getByRole('button', { name: /Checklist/ });
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');

    const filterButton = screen.getByRole('button', { name: 'Hide completed items' });
    expect(filterButton).toHaveAttribute('aria-pressed', 'false');
    expect(visibleLabels()).toEqual(['First open item', 'Finished item', 'Second open item']);
    expect(screen.getByText('1/3 (33%)')).toBeInTheDocument();

    await user.click(filterButton);

    expect(filterButton).toHaveAttribute('aria-pressed', 'true');
    expect(visibleLabels()).toEqual(['First open item', 'Second open item']);
    expect(screen.getByText('1/3 (33%)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show all items' })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Show all items' }));

    expect(filterButton).toHaveAttribute('aria-pressed', 'false');
    expect(visibleLabels()).toEqual(['First open item', 'Finished item', 'Second open item']);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('explains when hiding completed items leaves no rows and keeps show-all available', async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValueOnce({
      data: [
        { id: completedId, taskId, text: 'First finished item', checked: true, position: 0 },
        { id: secondId, taskId, text: 'Second finished item', checked: true, position: 1 },
      ],
    });
    render(<TaskChecklist taskId={taskId} />, { wrapper });

    await screen.findByRole('checkbox', { name: 'First finished item' });
    expect(screen.getByText('2/2 (100%)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide completed items' }));

    expect(screen.getByRole('status')).toHaveTextContent(
      'No incomplete items in this loaded checklist.',
    );
    expect(screen.getByText('2/2 (100%)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show all items' }));
    expect(await screen.findByRole('checkbox', { name: 'First finished item' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Second finished item' })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('preserves the filter for same-task item updates and resets it for a different task', async () => {
    const user = userEvent.setup();
    const view = render(<TaskChecklist taskId={taskId} />, { wrapper });

    await screen.findByRole('checkbox', { name: 'First open item' });
    await user.click(screen.getByRole('button', { name: 'Hide completed items' }));

    await act(async () => {
      setChecklist([
        { id: firstId, taskId, label: 'First open item', checked: true, order: 0 },
        { id: completedId, taskId, label: 'Finished item', checked: true, order: 1 },
        { id: secondId, taskId, label: 'Second open item', checked: false, order: 2 },
      ]);
    });

    expect(screen.getByRole('button', { name: 'Hide completed items' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => {
      expect(visibleLabels()).toEqual(['Second open item']);
      expect(screen.getByText('2/3 (67%)')).toBeInTheDocument();
    });

    view.rerender(<TaskChecklist taskId={otherTaskId} />);

    await screen.findByRole('checkbox', { name: 'Other task open item' });
    expect(screen.getByRole('button', { name: 'Hide completed items' })).toHaveAttribute('aria-pressed', 'false');
    expect(visibleLabels()).toEqual(['Other task open item', 'Other task finished item']);
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('preserves the same-task filter across an empty item update and renders the current list', async () => {
    const user = userEvent.setup();
    render(<TaskChecklist taskId={taskId} />, { wrapper });

    await screen.findByRole('checkbox', { name: 'First open item' });
    await user.click(screen.getByRole('button', { name: 'Hide completed items' }));

    await act(async () => {
      setChecklist([]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Hide completed items' })).not.toBeInTheDocument();
    });

    await act(async () => {
      setChecklist([
        { id: secondId, taskId, label: 'Updated first open item', checked: false, order: 0 },
        { id: completedId, taskId, label: 'Updated finished item', checked: true, order: 1 },
        { id: firstId, taskId, label: 'Updated second open item', checked: false, order: 2 },
      ]);
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Hide completed items' })).toHaveAttribute('aria-pressed', 'true');
      expect(visibleLabels()).toEqual(['Updated first open item', 'Updated second open item']);
      expect(screen.getByText('1/3 (33%)')).toBeInTheDocument();
    });
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.patch).not.toHaveBeenCalled();
  });
});
