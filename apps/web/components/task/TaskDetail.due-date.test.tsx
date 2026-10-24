import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Task } from '@/lib/api/tasks';
import { TaskDetail } from './TaskDetail';

vi.mock('@/lib/api/client', () => ({ default: { patch: vi.fn() } }));
vi.mock('./TaskChecklist', () => ({ TaskChecklist: () => null }));
vi.mock('./TaskDependencies', () => ({ TaskDependencies: () => null }));
vi.mock('./AuditLog', () => ({ AuditLog: () => null }));
vi.mock('./TaskGitRefs', () => ({ TaskGitRefs: () => null }));

const task: Task = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Due date display task',
  status: 'todo',
  priority: 'medium',
  projectId: '22222222-2222-4222-8222-222222222222',
  actorType: 'human',
  createdAt: '2026-10-24T05:00:00.000Z',
  updatedAt: '2026-10-24T05:00:00.000Z',
  dueDate: '2026-10-08',
};

let previousTimeZone: string | undefined;
const queryClients: QueryClient[] = [];

beforeEach(() => {
  previousTimeZone = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
});

afterEach(() => {
  cleanup();
  queryClients.splice(0).forEach((queryClient) => queryClient.clear());
  if (previousTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = previousTimeZone;
});

function renderTask(value: Task) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClients.push(queryClient);
  return render(
    <QueryClientProvider client={queryClient}>
      <TaskDetail task={value} />
    </QueryClientProvider>,
  );
}

function dueDateText() {
  return screen.getByText((_, element) =>
    element?.tagName === 'SPAN' && element.textContent?.startsWith('Due ') === true,
  ).textContent;
}

describe('TaskDetail due date', () => {
  it('keeps an API date-only due date on the same calendar day west of UTC', () => {
    renderTask(task);

    const expected = new Date(`${task.dueDate}T00:00:00.000Z`).toLocaleDateString(undefined, {
      timeZone: 'UTC',
    });
    expect(dueDateText()).toBe(`Due ${expected}`);
  });

  it('keeps timestamp due dates on the existing local calendar day', () => {
    const timestamp = '2026-10-08T00:30:00.000Z';
    renderTask({ ...task, dueDate: timestamp });

    expect(dueDateText()).toBe(`Due ${new Date(timestamp).toLocaleDateString()}`);
  });

  it.each(['source due text', '2026-02-30'])('preserves unparseable source due-date text: %s', (dueDate) => {
    renderTask({ ...task, dueDate });

    expect(dueDateText()).toBe(`Due ${dueDate}`);
  });
});
