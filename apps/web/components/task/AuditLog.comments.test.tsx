import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuditLog } from './AuditLog';

interface ActivityFixture {
  id: string;
  taskId: string;
  actorId: string;
  actorName: string;
  actorType: 'human';
  action: string;
  payload: unknown;
  createdAt: string;
}

interface ActivityResult {
  data: ActivityFixture[];
  total: number;
  page: number;
  limit: number;
}

interface ActivityState {
  data: ActivityResult | undefined;
  isLoading: boolean;
  isError: boolean;
  isFetching?: boolean;
}

const state = vi.hoisted(() => ({
  results: new Map<string, ActivityState>(),
}));

vi.mock('@/lib/api/tasks', () => ({
  useActivity: (taskId: string, page = 1) => state.results.get(`${taskId}:${page}`) ?? {
    data: undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
  },
}));

const taskA = '11111111-1111-4111-8111-111111111111';
const taskB = '22222222-2222-4222-8222-222222222222';
const accessorBody = Object.defineProperty({}, 'body', {
  get() {
    throw new Error('comment body accessor must not run');
  },
});

function commentEntry(taskId: string, payload: unknown, action = 'comment'): ActivityFixture {
  return {
    id: `${taskId}-comment-1`,
    taskId,
    actorId: '33333333-3333-4333-8333-333333333333',
    actorName: 'Task owner',
    actorType: 'human',
    action,
    payload,
    createdAt: '2026-10-24T00:00:00.000Z',
  };
}

function ready(taskId: string, entries: ActivityFixture[]) {
  state.results.set(`${taskId}:1`, {
    data: { data: entries, total: entries.length, page: 1, limit: 20 },
    isLoading: false,
    isError: false,
    isFetching: false,
  });
}

beforeEach(() => state.results.clear());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('AuditLog comment bodies', () => {
  it('shows the existing comment body with its author and time as inert multiline text', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T00:30:00.000Z'));
    const body = 'First line\nSecond line <img src=x onerror=alert(1)>';
    ready(taskA, [commentEntry(taskA, { body })]);

    const { container } = render(<AuditLog taskId={taskA} />);

    expect(screen.getByText('Task owner')).toBeInTheDocument();
    expect(screen.getByText('comment')).toBeInTheDocument();
    const renderedBody = screen.getByText((text) => text.startsWith('First line'));
    expect(renderedBody).toHaveClass('whitespace-pre-wrap', 'break-words');
    expect(renderedBody.textContent).toBe(body);
    expect(screen.getByText('30m ago')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(container.textContent).toContain(body);
  });

  it('opens the complete long comment from its keyboard-accessible disclosure', async () => {
    const body = `Start\n${'evidence '.repeat(180)}<script>alert(1)</script> End`;
    ready(taskA, [commentEntry(taskA, { body })]);

    render(<AuditLog taskId={taskA} />);

    const user = userEvent.setup();
    const summary = screen.getByText('Read full comment');
    expect(summary.tagName).toBe('SUMMARY');
    expect(summary).toHaveTextContent('Read full comment');
    const disclosure = summary.closest('details');
    expect(disclosure).not.toBeNull();
    expect(disclosure).not.toHaveAttribute('open');
    await user.tab();
    expect(summary).toHaveFocus();
    fireEvent.click(summary);
    expect(disclosure).toHaveAttribute('open');
    const renderedBody = within(disclosure as HTMLDetailsElement).getByText((text) =>
      text.startsWith('Start evidence evidence'),
    );
    expect(renderedBody.textContent).toBe(body);
    expect(renderedBody.parentElement).not.toHaveClass(/max-h-|overflow-y-auto/);
    expect(document.querySelector('script')).toBeNull();
  });

  it('does not expose payload bodies for non-comment actions', () => {
    ready(taskA, [commentEntry(taskA, { body: 'not a comment' }, 'task:updated')]);

    render(<AuditLog taskId={taskA} />);

    expect(screen.getByText('task:updated')).toBeInTheDocument();
    expect(screen.queryByText('not a comment')).not.toBeInTheDocument();
  });

  it.each([
    ['missing payload', undefined],
    ['null payload', null],
    ['array payload', [{ body: 'array body' }]],
    ['missing body', {}],
    ['non-string body', { body: { text: 'object body' } }],
    ['boxed string body', { body: Reflect.construct(String, ['boxed body']) }],
    ['inherited body', Object.create({ body: 'inherited body' })],
    ['accessor body', accessorBody],
  ])('keeps only the action for %s', (_name, payload) => {
    ready(taskA, [commentEntry(taskA, payload)]);

    render(<AuditLog taskId={taskA} />);

    expect(screen.getByText('comment')).toBeInTheDocument();
    expect(screen.queryByText(/array body|object body|boxed body|inherited body/)).not.toBeInTheDocument();
  });

  it('keeps a prior task comment out after a task switch', () => {
    ready(taskA, [commentEntry(taskA, { body: 'Task A private comment text' })]);
    ready(taskB, [commentEntry(taskB, { body: 'Task B comment text' })]);

    const view = render(<AuditLog taskId={taskA} />);
    expect(screen.getByText('Task A private comment text')).toBeInTheDocument();

    view.rerender(<AuditLog taskId={taskB} />);

    expect(screen.getByText('Task B comment text')).toBeInTheDocument();
    expect(screen.queryByText('Task A private comment text')).not.toBeInTheDocument();
  });

  it('does not show cached comment text while the activity query is in error', () => {
    state.results.set(`${taskA}:1`, {
      data: {
        data: [commentEntry(taskA, { body: 'stale comment must stay hidden' })],
        total: 1,
        page: 1,
        limit: 20,
      },
      isLoading: false,
      isError: true,
      isFetching: false,
    });

    render(<AuditLog taskId={taskA} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Activity is unavailable. Try again later.');
    expect(screen.queryByText('stale comment must stay hidden')).not.toBeInTheDocument();
  });
});
