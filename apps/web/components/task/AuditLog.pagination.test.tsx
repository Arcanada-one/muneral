import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLog } from './AuditLog';

const apiGet = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api/client', () => ({ default: { get: apiGet } }));

const taskA = '00000000-0000-4000-8000-000000000001';
const taskB = '00000000-0000-4000-8000-000000000002';
const emptyTask = '00000000-0000-4000-8000-000000000004';
const actorId = '00000000-0000-4000-8000-000000000003';

function responseFor(taskId: string, page: number) {
  const ids = page === 1
    ? Array.from({ length: taskId === taskA ? 20 : taskId === emptyTask ? 0 : 1 }, (_, index) => index + 1)
    : [21];
  return {
    data: {
      data: ids.map((number) => ({
        id: `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
        taskId,
        actorId,
        actorType: 'human',
        actorName: `Actor ${number}`,
        action: `${taskId === taskA ? 'Task A' : 'Task B'} event ${number}`,
        createdAt: '2026-10-23T12:00:00.000Z',
      })),
      total: taskId === taskA ? 21 : taskId === emptyTask ? 0 : 1,
      page,
      limit: 20,
    },
  };
}

function statusChangeResponse(payload: unknown, action = 'task:status_changed') {
  return {
    data: {
      data: [{
        id: '00000000-0000-4000-8000-000000000099',
        taskId: taskA,
        actorId,
        actorType: 'human',
        actorName: 'Status actor',
        action,
        payload,
        createdAt: '2026-10-23T12:00:00.000Z',
      }],
      total: 1,
      page: 1,
      limit: 20,
    },
  };
}

function renderAuditLog(taskId = taskA) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <AuditLog taskId={taskId} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockImplementation(async (url: string) => {
    const parsed = new URL(url, 'http://muneral.test');
    const taskId = parsed.pathname.split('/')[2];
    const page = Number(parsed.searchParams.get('page'));
    return responseFor(taskId, page);
  });
});

afterEach(cleanup);

describe('AuditLog activity history pagination', () => {
  it.each([
    ['todo', 'To Do'],
    ['in_progress', 'In Progress'],
    ['review', 'Review'],
    ['blocked', 'Blocked'],
    ['done', 'Done'],
    ['cancelled', 'Cancelled'],
    ['archived', 'Archived'],
  ])('shows a status transition from %s using its readable label', async (status, label) => {
    apiGet.mockResolvedValue(statusChangeResponse({ from: status, to: 'done' }));
    renderAuditLog();

    expect(await screen.findByText(`Status changed: ${label} → Done`)).toBeInTheDocument();
    expect(screen.queryByText('task:status_changed')).not.toBeInTheDocument();
  });

  it.each([
    ['null payload', null],
    ['missing transition field', { from: 'todo' }],
    ['non-string transition field', { from: 'todo', to: 42 }],
    ['unknown source status', { from: 'unknown', to: 'done' }],
    ['unknown destination status', { from: 'todo', to: '<img src=x onerror=alert(1)>' }],
    ['non-status action with status-like payload', { from: 'todo', to: 'done' }, 'task:updated'],
  ])('falls back to the action for %s without rendering payload markup', async (_description, payload, action = 'task:status_changed') => {
    apiGet.mockResolvedValue(statusChangeResponse(payload, action));
    renderAuditLog();

    expect(await screen.findByText(action)).toBeInTheDocument();
    expect(screen.queryByText(/Status changed:/)).not.toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByText(/unknown|<img/)).not.toBeInTheDocument();
  });

  it('reaches the older 21st event and returns to the newest page', async () => {
    const user = userEvent.setup();
    renderAuditLog();

    expect(await screen.findByText('Task A event 1')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(20);
    expect(screen.getByText('Showing 1–20 of 21 activities')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith(`/tasks/${taskA}/activity?page=1&limit=20`);

    const older = screen.getByRole('button', { name: 'Older activity' });
    expect(screen.getByRole('button', { name: 'Newer activity' })).toBeDisabled();
    expect(older).toBeEnabled();

    await user.click(older);
    expect(await screen.findByText('Task A event 21')).toBeInTheDocument();
    expect(screen.queryByText('Task A event 1')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 21–21 of 21 activities')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith(`/tasks/${taskA}/activity?page=2&limit=20`);
    expect(screen.getByRole('button', { name: 'Newer activity' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Older activity' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Newer activity' }));
    expect(await screen.findByText('Task A event 1')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith(`/tasks/${taskA}/activity?page=1&limit=20`);
  });

  it('resets to page one on task changes without showing the prior task rows', async () => {
    const user = userEvent.setup();
    const view = renderAuditLog();
    expect(await screen.findByText('Task A event 1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Older activity' }));
    expect(await screen.findByText('Task A event 21')).toBeInTheDocument();

    view.rerender(
      <QueryClientProvider client={view.client}>
        <AuditLog taskId={taskB} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Task B event 1')).toBeInTheDocument();
    expect(screen.queryByText(/Task A event/)).not.toBeInTheDocument();
    expect(screen.getByText('Showing 1–1 of 1 activity')).toBeInTheDocument();
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(`/tasks/${taskB}/activity?page=1&limit=20`));
  });

  it('does not expose navigation while another page is loading', async () => {
    const user = userEvent.setup();
    let resolvePage: ((value: ReturnType<typeof responseFor>) => void) | undefined;
    apiGet.mockImplementation(async (url: string) => {
      const parsed = new URL(url, 'http://muneral.test');
      if (parsed.searchParams.get('page') === '2') {
        return new Promise((resolve) => {
          resolvePage = resolve;
        });
      }
      return responseFor(taskA, 1);
    });
    renderAuditLog();
    expect(await screen.findByText('Task A event 1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Older activity' }));
    expect(await screen.findByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Older activity' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Newer activity' })).not.toBeInTheDocument();

    resolvePage?.(responseFor(taskA, 2));
    expect(await screen.findByText('Task A event 21')).toBeInTheDocument();
  });

  it('keeps an empty history navigable only at its first page', async () => {
    renderAuditLog(emptyTask);
    expect(await screen.findByText('Showing 0–0 of 0 activities')).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Newer activity' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Older activity' })).toBeDisabled();
  });

  it('offers recovery when the total shrinks below the current page', async () => {
    const user = userEvent.setup();
    let firstPageCalls = 0;
    apiGet.mockImplementation(async (url: string) => {
      const parsed = new URL(url, 'http://muneral.test');
      if (parsed.searchParams.get('page') === '2') {
        return { data: { data: [], total: 1, page: 2, limit: 20 } };
      }
      firstPageCalls += 1;
      if (firstPageCalls === 1) return responseFor(taskA, 1);
      const latestPage = responseFor(taskA, 1);
      return { ...latestPage, data: { ...latestPage.data, data: latestPage.data.data.slice(0, 1), total: 1 } };
    });
    renderAuditLog();
    expect(await screen.findByText('Task A event 1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Older activity' }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(`/tasks/${taskA}/activity?page=2&limit=20`));
    expect(await screen.findByText('Activity changed. Return to the newest available page.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show newest activity' }));
    expect(await screen.findByText('Task A event 1')).toBeInTheDocument();
    expect(screen.getByText('Showing 1–1 of 1 activity')).toBeInTheDocument();
  });

  it('returns to page one when the current page becomes out of range', async () => {
    const user = userEvent.setup();
    apiGet.mockImplementation(async (url: string) => {
      const parsed = new URL(url, 'http://muneral.test');
      const page = Number(parsed.searchParams.get('page'));
      if (page === 2) {
        return {
          data: {
            ...responseFor(taskA, 2).data,
            data: Array.from({ length: 20 }, (_, index) => ({
              ...responseFor(taskA, 2).data.data[0],
              id: `00000000-0000-4000-8000-${String(index + 21).padStart(12, '0')}`,
              action: `Task A event ${index + 21}`,
            })),
            total: 41,
          },
        };
      }
      if (page === 3) {
        return { data: { data: [], total: 21, page: 3, limit: 20 } };
      }
      return responseFor(taskA, 1);
    });
    renderAuditLog();
    expect(await screen.findByText('Task A event 1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Older activity' }));
    expect(await screen.findByText('Task A event 21')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Older activity' }));
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(`/tasks/${taskA}/activity?page=3&limit=20`));
    expect(await screen.findByText('Activity changed. Return to the newest available page.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show newest activity' }));
    expect(await screen.findByText('Task A event 1')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith(`/tasks/${taskA}/activity?page=1&limit=20`);
    expect(screen.queryByText('Activity changed. Return to the newest available page.')).not.toBeInTheDocument();
  });
});
