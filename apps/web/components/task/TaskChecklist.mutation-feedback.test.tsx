import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskChecklist } from './TaskChecklist';

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ default: api }));

const taskId = '10000000-0000-4000-8000-000000000001';
const nextTaskId = '10000000-0000-4000-8000-000000000003';
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
