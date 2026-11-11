import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import apiClient from '@/lib/api/client';
import { TaskDependencies } from './TaskDependencies';

const taskId = '11111111-1111-4111-8111-111111111111';
const nextTaskId = '99999999-9999-4999-8999-999999999999';

type DependencyFixture = {
  id: string;
  type: string;
  direction: 'incoming' | 'outgoing';
  fromTaskId: string;
  toTaskId: string;
  otherTaskId: string;
  otherTaskTitle: string | null;
  otherTaskTitleWithheld?: boolean;
  otherTaskStatus: string;
};

function dependency(
  id: string,
  otherTaskId: string,
  title: string | null,
  status: string,
  direction: 'incoming' | 'outgoing' = 'incoming',
  currentTaskId = taskId,
): DependencyFixture {
  return {
    id,
    type: 'depends_on',
    direction,
    fromTaskId: direction === 'outgoing' ? currentTaskId : otherTaskId,
    toTaskId: direction === 'outgoing' ? otherTaskId : currentTaskId,
    otherTaskId,
    otherTaskTitle: title,
    otherTaskStatus: status,
  };
}

function renderDependencies(currentTaskId = taskId, initialGraph?: DependencyFixture[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (initialGraph) {
    queryClient.setQueryData(['tasks', currentTaskId, 'dependency-graph'], initialGraph);
  }
  const renderForTask = (id: string) => (
    <QueryClientProvider client={queryClient}>
      <TaskDependencies taskId={id} />
    </QueryClientProvider>
  );
  const view = render(renderForTask(currentTaskId));
  return {
    ...view,
    queryClient,
    rerenderTask: (id: string) => view.rerender(renderForTask(id)),
  };
}

function visibleIds(): string[] {
  return screen.queryAllByRole('listitem').map((row) => row.querySelector('code')?.textContent ?? '');
}

const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

beforeEach(() => {
  vi.spyOn(apiClient, 'get').mockResolvedValue({ data: [] } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

describe('loaded dependency search', () => {
  it('starts empty, performs trimmed case-insensitive literal ID/title matching, preserves order, and clears locally', async () => {
    const rows = [
      dependency('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222', 'Alpha Design', 'todo'),
      dependency('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '33333333-3333-4333-8333-333333333333', 'Gamma alpha note', 'in_progress'),
      dependency('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB', 'Other title', 'todo'),
      dependency('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '55555555-5555-4555-8555-555555555555', 'AlphaXbeta', 'todo'),
    ];
    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: rows } as never);
    renderDependencies();

    const search = await screen.findByRole('textbox', { name: 'Search loaded dependencies' });
    expect(search).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeDisabled();
    expect(screen.getByText('Showing 4 of 4 loaded dependencies.')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: '  ALPHA  ' } });
    expect(visibleIds()).toEqual(['22222222', '33333333', '55555555']);
    expect(screen.getByText('Showing 3 matching of 4 loaded dependencies.')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search loaded dependencies' }), {
      target: { value: 'alpha.*' },
    });
    expect(visibleIds()).toEqual([]);
    expect(screen.getByText(/No matching dependencies in the loaded list\./)).toHaveTextContent(
      'Clear search or adjust the dependency filters to show more.',
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Search loaded dependencies' }), {
      target: { value: 'bbbB' },
    });
    expect(visibleIds()).toEqual(['BBBBBBBB']);
    expect(screen.getByText('Showing 1 matching of 4 loaded dependencies.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByRole('textbox', { name: 'Search loaded dependencies' })).toHaveValue('');
    expect(visibleIds()).toEqual(['22222222', '33333333', 'BBBBBBBB', '55555555']);
    expect(screen.getByText('Showing 4 of 4 loaded dependencies.')).toBeInTheDocument();
  });

  it('never reads, renders, or counts a withheld title as a search match', async () => {
    const withheld = dependency(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '22222222-2222-4222-8222-222222222222',
      null,
      'todo',
    );
    withheld.otherTaskTitleWithheld = true;
    Object.defineProperty(withheld, 'otherTaskTitle', {
      configurable: true,
      get: () => { throw new Error('withheld title was consulted'); },
    });
    renderDependencies(taskId, [withheld]);

    fireEvent.change(await screen.findByRole('textbox', { name: 'Search loaded dependencies' }), {
      target: { value: 'confidential withheld phrase' },
    });

    expect(screen.queryByText('confidential withheld phrase')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 0 matching of 1 loaded dependencies.')).toBeInTheDocument();
    expect(screen.getByText(/No matching dependencies in the loaded list\./)).toHaveTextContent(
      'Clear search or adjust the dependency filters to show more.',
    );
  });

  it('intersects direction and completed filters, keeps loaded totals, order, and local recovery', async () => {
    const rows = [
      dependency('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222', 'Needle done incoming', 'done'),
      dependency('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '33333333-3333-4333-8333-333333333333', 'Needle open incoming', 'todo'),
      dependency('cccccccc-cccc-4ccc-8ccc-cccccccccccc', '44444444-4444-4444-8444-444444444444', 'Needle open outgoing', 'todo', 'outgoing'),
      dependency('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '55555555-5555-4555-8555-555555555555', 'Other incoming', 'todo'),
    ];
    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: rows } as never);
    renderDependencies();

    fireEvent.change(await screen.findByRole('textbox', { name: 'Search loaded dependencies' }), {
      target: { value: ' needle ' },
    });
    expect(visibleIds()).toEqual(['22222222', '33333333', '44444444']);
    expect(screen.getByText('Showing 3 matching of 4 loaded dependencies.')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Dependency direction' }), {
      target: { value: 'incoming' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide completed dependencies' }));
    expect(visibleIds()).toEqual(['33333333']);
    expect(screen.getByText('Showing 1 matching of 4 loaded dependencies.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(visibleIds()).toEqual(['33333333', '55555555']);
    expect(screen.getByText('Showing 2 of 4 loaded dependencies.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Dependency direction' })).toHaveValue('incoming');
    expect(screen.getByRole('checkbox', { name: 'Hide completed dependencies' })).toBeChecked();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('keeps the query across same-task refresh and loaded-empty roundtrip, but resets on task switch', async () => {
    const firstRows = [dependency(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '22222222-2222-4222-8222-222222222222',
      'Initial title',
      'todo',
    )];
    const view = renderDependencies(taskId, firstRows);
    const search = await screen.findByRole('textbox', { name: 'Search loaded dependencies' });
    fireEvent.change(search, { target: { value: 'updated' } });
    expect(screen.getByText('Showing 0 matching of 1 loaded dependencies.')).toBeInTheDocument();

    await act(async () => {
      view.queryClient.setQueryData(['tasks', taskId, 'dependency-graph'], [dependency(
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        '33333333-3333-4333-8333-333333333333',
        'Updated title',
        'in_progress',
      )]);
    });
    expect(screen.getByRole('textbox', { name: 'Search loaded dependencies' })).toHaveValue('updated');
    await waitFor(() => expect(screen.getByText('Updated title')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Showing 1 matching of 1 loaded dependencies.')).toBeInTheDocument());

    await act(async () => view.queryClient.setQueryData(['tasks', taskId, 'dependency-graph'], []));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Search loaded dependencies' })).not.toBeInTheDocument());
    await act(async () => view.queryClient.setQueryData(['tasks', taskId, 'dependency-graph'], [dependency(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      '44444444-4444-4444-8444-444444444444',
      'Updated after empty',
      'todo',
    ), dependency(
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      '66666666-6666-4666-8666-666666666666',
      'Unrelated after empty',
      'todo',
    )]));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Search loaded dependencies' })).toHaveValue('updated'));
    expect(screen.getByText('Updated after empty')).toBeInTheDocument();
    expect(screen.queryByText('Unrelated after empty')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 1 matching of 2 loaded dependencies.')).toBeInTheDocument();

    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: [dependency(
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      '55555555-5555-4555-8555-555555555555',
      'New task row',
      'todo',
      'incoming',
      nextTaskId,
    )] } as never);
    view.rerenderTask(nextTaskId);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Search loaded dependencies' })).toHaveValue(''));
    expect(screen.getByText('New task row')).toBeInTheDocument();
    expect(screen.getByText('Showing 1 of 1 loaded dependencies.')).toBeInTheDocument();

    view.rerenderTask(taskId);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Search loaded dependencies' })).toHaveValue(''));
    expect(screen.getByText('Updated after empty')).toBeInTheDocument();
    expect(screen.getByText('Unrelated after empty')).toBeInTheDocument();
    expect(visibleIds()).toEqual(['44444444', '66666666']);
    expect(screen.getByText('Showing 2 of 2 loaded dependencies.')).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it('does not trigger mutations, navigation, clipboard, or additional reads while searching and filtering', async () => {
    const rows = [dependency(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '22222222-2222-4222-8222-222222222222',
      'Searchable title',
      'todo',
    )];
    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: rows } as never);
    const mutations = [
      vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('unexpected dependency mutation')),
      vi.spyOn(apiClient, 'put').mockRejectedValue(new Error('unexpected dependency mutation')),
      vi.spyOn(apiClient, 'patch').mockRejectedValue(new Error('unexpected dependency mutation')),
      vi.spyOn(apiClient, 'delete').mockRejectedValue(new Error('unexpected dependency mutation')),
    ];
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const originalUrl = window.location.href;
    const pushState = vi.spyOn(window.history, 'pushState').mockImplementation(() => {});
    const replaceState = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});

    renderDependencies();
    const search = await screen.findByRole('textbox', { name: 'Search loaded dependencies' });
    fireEvent.change(search, { target: { value: 'searchable' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Dependency direction' }), {
      target: { value: 'outgoing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));

    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(mutations.every((mutation) => mutation.mock.calls.length === 0)).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(window.location.href).toBe(originalUrl);
  });
});
