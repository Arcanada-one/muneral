import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskChecklist } from './TaskChecklist';

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ default: api }));

const taskId = '10000000-0000-4000-8000-000000000001';
const item = {
  id: '10000000-0000-4000-8000-000000000002',
  taskId,
  text: 'Write acceptance criteria',
  checked: false,
  position: 0,
};

let client: QueryClient;
function wrapper({ children }: PropsWithChildren) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  api.get.mockReset().mockResolvedValue({ data: [item] });
  api.patch.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  cleanup();
  client.clear();
});

describe('TaskChecklist disclosure state', () => {
  it('announces the expanded state and updates it on keyboard activation', async () => {
    const user = userEvent.setup();
    render(<TaskChecklist taskId={taskId} />, { wrapper });

    await screen.findByRole('checkbox', { name: item.text });
    const disclosure = screen.getByRole('button', { name: /Checklist/ });
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');

    await user.tab();
    expect(disclosure).toHaveFocus();
    await user.keyboard(' ');

    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('checkbox', { name: item.text })).not.toBeInTheDocument();

    await user.keyboard(' ');
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByRole('checkbox', { name: item.text })).toBeInTheDocument();
  });
});
