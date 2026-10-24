import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuditLog } from './AuditLog';

interface ActivityFixture {
  id: string;
  taskId: string;
  actorId: string;
  actorName: string;
  actorType: 'agent';
  action: string;
  payload: unknown;
  createdAt: string;
}

const taskId = '11111111-1111-4111-8111-111111111111';
const sha256 = 'a'.repeat(64);
const state = vi.hoisted(() => ({ activity: undefined as unknown }));

vi.mock('@/lib/api/tasks', () => ({
  useActivity: () => state.activity,
}));

function evidenceEntry(payload: unknown, action = 'task:evidence_attached'): ActivityFixture {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    taskId,
    actorId: '33333333-3333-4333-8333-333333333333',
    actorName: 'Evidence author',
    actorType: 'agent',
    action,
    payload,
    createdAt: '2026-10-24T00:00:00.000Z',
  };
}

function setActivity(entry: ActivityFixture) {
  state.activity = {
    data: { data: [entry], total: 1, page: 1, limit: 20 },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  };
}

beforeEach(() => {
  state.activity = undefined;
});

afterEach(() => cleanup());

describe('AuditLog evidence attachment details', () => {
  it('shows the writer fields as inert text in an accessible disclosure', async () => {
    const uri = 'artifact:fixture/<svg/onload=alert(1)>';
    setActivity(evidenceEntry({
      evidence_id: '55555555-5555-4555-8555-555555555555',
      uri,
      sha256,
      content_type: 'application/json',
    }));

    const { container } = render(<AuditLog taskId={taskId} />);
    expect(screen.getByText('Evidence author')).toBeInTheDocument();
    expect(screen.getByText('task:evidence_attached')).toBeInTheDocument();

    const user = userEvent.setup();
    const summary = screen.getByText('Evidence details');
    expect(summary.tagName).toBe('SUMMARY');
    await user.tab();
    expect(summary).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(screen.getByText('URI')).toBeInTheDocument();
    expect(screen.getByText(uri)).toHaveClass('break-all');
    expect(screen.getByText(sha256)).toBeInTheDocument();
    expect(screen.getByText('application/json')).toBeInTheDocument();
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('svg[onload]')).toBeNull();
  });

  it.each([
    ['missing evidence id', { uri: 'artifact:fixture/1', sha256, content_type: 'application/json' }],
    ['malformed digest', { evidence_id: 'evidence-1', uri: 'artifact:fixture/1', sha256: 'A'.repeat(64), content_type: 'application/json' }],
    ['credential-bearing URI', { evidence_id: 'evidence-1', uri: 'https://agent:secret@example.test/item', sha256, content_type: 'application/json' }],
    ['unknown payload property', { evidence_id: 'evidence-1', uri: 'artifact:fixture/1', sha256, content_type: 'application/json', secret: 'hidden' }],
  ])('leaves malformed %s payload on the existing action fallback', (_label, payload) => {
    setActivity(evidenceEntry(payload));

    const { container } = render(<AuditLog taskId={taskId} />);

    expect(screen.getByText('task:evidence_attached')).toBeInTheDocument();
    expect(screen.queryByText('Evidence details')).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('hidden');
  });

  it('does not display evidence-shaped payloads for other activity actions', () => {
    setActivity(evidenceEntry({
      evidence_id: '55555555-5555-4555-8555-555555555555',
      uri: 'artifact:fixture/1',
      sha256,
      content_type: 'application/json',
    }, 'task:updated'));

    render(<AuditLog taskId={taskId} />);

    expect(screen.getByText('task:updated')).toBeInTheDocument();
    expect(screen.queryByText('Evidence details')).not.toBeInTheDocument();
    expect(screen.queryByText('artifact:fixture/1')).not.toBeInTheDocument();
  });
});
