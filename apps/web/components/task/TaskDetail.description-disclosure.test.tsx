import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readTask } from '@/lib/api/read-contract';
import { TaskDetail } from './TaskDetail';

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ default: api }));
vi.mock('./TaskChecklist', () => ({ TaskChecklist: () => null }));
vi.mock('./TaskDependencies', () => ({ TaskDependencies: () => null }));
vi.mock('./TaskReadiness', () => ({ TaskReadiness: () => null }));
vi.mock('./AuditLog', () => ({ AuditLog: () => null }));
vi.mock('./TaskGitRefs', () => ({ TaskGitRefs: () => null }));

const taskId = '11111111-1111-4111-8111-111111111111';
const otherTaskId = '99999999-9999-4999-8999-999999999999';
const task = {
  id: taskId,
  title: 'Current task',
  status: 'todo',
  priority: 'medium',
  projectId: '22222222-2222-4222-8222-222222222222',
  actorType: 'human',
  createdAt: '2026-10-28T05:00:00.000Z',
  updatedAt: '2026-10-28T05:00:00.000Z',
};
const queryClients: QueryClient[] = [];

function renderTaskDetail(value: unknown) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClients.push(queryClient);
  const renderValue = (next: unknown) => (
    <QueryClientProvider client={queryClient}>
      <TaskDetail task={readTask(next)} />
    </QueryClientProvider>
  );
  const view = render(renderValue(value));
  return { ...view, rerenderTask: (next: unknown) => view.rerender(renderValue(next)) };
}

beforeEach(() => {
  api.get.mockReset();
  api.patch.mockReset();
});

afterEach(() => {
  cleanup();
  queryClients.splice(0).forEach((queryClient) => queryClient.clear());
  vi.restoreAllMocks();
});

describe('TaskDetail description disclosure', () => {
  it('starts expanded with an accessible control and the exact plain text', () => {
    const description = 'First line  \nSecond line\n<script>remains text</script>';
    renderTaskDetail({ ...task, description });

    const button = screen.getByRole('button', { name: 'Description' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const panelId = button.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    const panel = document.getElementById(panelId!);
    expect(panel).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-controls', panel!.id);
    expect(panel!.querySelector('p')?.textContent).toBe(description);
    expect(panel!.querySelector('script')).not.toBeInTheDocument();
  });

  it('does not render a disclosure for an empty or absent description', () => {
    const view = renderTaskDetail({ ...task, description: '' });
    expect(screen.queryByRole('button', { name: 'Description' })).not.toBeInTheDocument();

    view.rerenderTask(task);
    expect(screen.queryByRole('button', { name: 'Description' })).not.toBeInTheDocument();
  });

  it('collapses and restores only the description using click without an API request', async () => {
    const user = userEvent.setup();
    const description = 'Keep this exact text.\nAnd this order.';
    renderTaskDetail({ ...task, description });
    const button = screen.getByRole('button', { name: 'Description' });
    const panel = document.getElementById(button.getAttribute('aria-controls')!)!;
    api.get.mockClear();
    api.patch.mockClear();

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(panel).toHaveAttribute('hidden');
    expect(panel.querySelector('p')?.textContent).toBe(description);

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(panel).not.toHaveAttribute('hidden');
    expect(panel.querySelector('p')?.textContent).toBe(description);
    expect(api.get).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('supports native keyboard activation', async () => {
    const user = userEvent.setup();
    renderTaskDetail({ ...task, description: 'Keyboard accessible.' });
    const button = screen.getByRole('button', { name: 'Description' });
    button.focus();

    await user.keyboard('{Enter}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard(' ');
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('preserves same-task state and updates text, then resets expanded for another task', async () => {
    const user = userEvent.setup();
    const view = renderTaskDetail({ ...task, description: 'Original description.' });
    const button = screen.getByRole('button', { name: 'Description' });
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');

    view.rerenderTask({ ...task, title: 'Updated title', description: 'Updated description.' });
    const updatedButton = screen.getByRole('button', { name: 'Description' });
    expect(updatedButton).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById(updatedButton.getAttribute('aria-controls')!)?.querySelector('p')?.textContent)
      .toBe('Updated description.');

    view.rerenderTask({ ...task, id: otherTaskId, title: 'Other task', description: 'Other description.' });
    const otherButton = screen.getByRole('button', { name: 'Description' });
    expect(otherButton).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(otherButton.getAttribute('aria-controls')!)?.querySelector('p')?.textContent)
      .toBe('Other description.');
    expect(screen.queryByText('Updated description.')).not.toBeInTheDocument();
  });
});
