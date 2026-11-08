import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskGitRefs } from './TaskGitRefs';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));
vi.mock('@/lib/api/client', () => ({ default: api }));

const taskId = '11111111-1111-4111-8111-111111111111';
const nextTaskId = '22222222-2222-4222-8222-222222222222';

const references = [
  {
    id: '33333333-3333-4333-8333-333333333333', taskId, type: 'branch',
    url: 'https://git.example:8443/team/repo/tree/release/long-feature-name', ref: 'release/shared',
    createdAt: '2026-11-02T00:00:00.000Z',
  },
  {
    id: '44444444-4444-4444-8444-444444444444', taskId, type: 'branch',
    url: 'https://git.example/other/repo/commit/abcdef0', ref: 'release/shared',
    createdAt: '2026-11-02T00:01:00.000Z',
  },
  {
    id: '55555555-5555-4555-8555-555555555555', taskId, type: 'repo',
    url: 'https://code.example/team/project', ref: 'team/project',
    createdAt: '2026-11-02T00:02:00.000Z',
  },
  {
    id: '66666666-6666-4666-8666-666666666666', taskId, type: 'commit',
    url: 'javascript:alert(1)', ref: 'unsafe-reference',
    createdAt: '2026-11-02T00:03:00.000Z',
  },
];

const nextTaskReferences = [
  {
    id: '77777777-7777-4777-8777-777777777777', taskId: nextTaskId, type: 'branch',
    url: 'https://next.example/team/project/tree/main', ref: 'main',
    createdAt: '2026-11-02T00:04:00.000Z',
  },
];

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

function renderRefs(currentTaskId = taskId) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const renderForTask = (id: string) => (
    <QueryClientProvider client={client}>
      <TaskGitRefs taskId={id} />
    </QueryClientProvider>
  );
  const view = render(renderForTask(currentTaskId));
  return {
    ...view,
    client,
    rerenderTask: (id: string) => view.rerender(renderForTask(id)),
  };
}

beforeEach(() => {
  api.get.mockReset().mockImplementation(async (path: string) => ({
    data: path === `/projects/tasks/${nextTaskId}/git-refs` ? nextTaskReferences : references,
  }));
  for (const method of [api.post, api.put, api.patch, api.delete]) method.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalClipboard) {
    Object.defineProperty(navigator, 'clipboard', originalClipboard);
  } else {
    Reflect.deleteProperty(navigator, 'clipboard');
  }
});

describe('task Git reference destination disclosure', () => {
  it('starts collapsed for safe visible rows and preserves existing link destinations and order', async () => {
    renderRefs();

    const links = await screen.findAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      references[0].url,
      references[1].url,
      references[2].url,
    ]);
    expect(links[0]).toHaveAttribute('target', '_blank');
    expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer');

    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    for (const row of rows.slice(0, 3)) {
      expect(within(row).getByRole('button', { name: 'Show link destination' }))
        .toHaveAttribute('aria-expanded', 'false');
    }
    expect(within(rows[3]).queryByRole('button', { name: /link destination/ }))
      .not.toBeInTheDocument();
    expect(screen.queryByText('git.example:8443/team/repo/tree/release/long-feature-name'))
      .not.toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('reveals only the checked URL host and pathname as wrapping text and toggles accessibly per row', async () => {
    renderRefs();
    await screen.findAllByRole('link');

    const [firstRow, secondRow] = screen.getAllByRole('listitem');
    const firstToggle = within(firstRow).getByRole('button', { name: 'Show link destination' });
    fireEvent.click(firstToggle);

    const firstDestination = within(firstRow).getByText(
      'git.example:8443/team/repo/tree/release/long-feature-name',
      { exact: true },
    );
    expect(firstDestination).toHaveClass('break-all');
    expect(within(firstRow).getByRole('button', { name: 'Hide link destination' }))
      .toHaveAttribute('aria-expanded', 'true');
    expect(within(secondRow).getByRole('button', { name: 'Show link destination' }))
      .toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(within(secondRow).getByRole('button', { name: 'Show link destination' }));
    expect(within(secondRow).getByText('git.example/other/repo/commit/abcdef0', { exact: true }))
      .toHaveClass('break-all');
    expect(within(firstRow).getByText(
      'git.example:8443/team/repo/tree/release/long-feature-name',
      { exact: true },
    )).toBeInTheDocument();

    fireEvent.click(within(firstRow).getByRole('button', { name: 'Hide link destination' }));
    expect(within(firstRow).queryByText(
      'git.example:8443/team/repo/tree/release/long-feature-name',
      { exact: true },
    )).not.toBeInTheDocument();
  });

  it.each([
    ['credentialed URL', 'https://user:secret@git.example/private/path'],
    ['query URL', 'https://git.example/private/path?token=synthetic'],
    ['fragment URL', 'https://git.example/private/path#fragment'],
    ['unsafe scheme', 'javascript:alert(1)'],
    ['missing URL', ''],
  ])('keeps the generic unavailable row without reflecting a rejected %s', async (_kind, url) => {
    const rejected = {
      ...references[3],
      url,
      ref: `private-ref-${_kind}-must-not-appear`,
    };
    if (url === '') {
      const view = renderRefs();
      await screen.findAllByRole('link');
      await act(async () => {
        view.client.setQueryData(['tasks', taskId, 'git-refs'], [{ ...rejected, url: undefined }]);
      });
    } else {
      api.get.mockResolvedValueOnce({ data: [rejected] });
      renderRefs();
    }

    const unavailable = await screen.findByRole('alert');
    expect(unavailable).toHaveTextContent('Reference link unavailable');
    expect(screen.queryByRole('button', { name: /link destination/ })).not.toBeInTheDocument();
    if (url !== '') expect(document.body.textContent).not.toContain(url);
    expect(document.body.textContent).not.toContain(rejected.ref);
  });

  it('retains an expanded choice for the same task-edge-URL refresh and resets on URL or edge change', async () => {
    const view = renderRefs();
    await screen.findAllByRole('link');
    const initialRow = screen.getAllByRole('listitem')[0];
    fireEvent.click(within(initialRow).getByRole('button', { name: 'Show link destination' }));

    api.get.mockResolvedValueOnce({
      data: [
        { ...references[0], ref: 'release/renamed' },
        ...references.slice(1),
      ],
    } as never);
    await act(async () => {
      await view.client.refetchQueries({ queryKey: ['tasks', taskId, 'git-refs'], exact: true });
    });
    const refreshedRow = screen.getAllByRole('listitem')[0];
    expect(within(refreshedRow).getByRole('button', { name: 'Hide link destination' }))
      .toHaveAttribute('aria-expanded', 'true');
    expect(within(refreshedRow).getByText(
      'git.example:8443/team/repo/tree/release/long-feature-name',
      { exact: true },
    )).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(2);

    const changedUrl = 'https://git.example:9443/team/repo/tree/release/updated';
    await act(async () => {
      view.client.setQueryData(['tasks', taskId, 'git-refs'], [
        { ...references[0], url: changedUrl },
        ...references.slice(1),
      ]);
    });
    let changedRow = screen.getAllByRole('listitem')[0];
    expect(within(changedRow).getByRole('button', { name: 'Show link destination' }))
      .toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(within(changedRow).getByRole('button', { name: 'Show link destination' }));
    expect(within(changedRow).getByText('git.example:9443/team/repo/tree/release/updated', { exact: true }))
      .toBeInTheDocument();

    await act(async () => {
      view.client.setQueryData(['tasks', taskId, 'git-refs'], [
        { ...references[0], id: '99999999-9999-4999-8999-999999999999', url: changedUrl },
        ...references.slice(1),
      ]);
    });
    expect((view.client.getQueryData(['tasks', taskId, 'git-refs']) as typeof references)[0].id)
      .toBe('99999999-9999-4999-8999-999999999999');
    await waitFor(() => {
      expect(within(screen.getAllByRole('listitem')[0]).getByRole('button', { name: 'Show link destination' }))
        .toHaveAttribute('aria-expanded', 'false');
    });
    changedRow = screen.getAllByRole('listitem')[0];
  });

  it('resets disclosure state across an A-to-B-to-A task identity transition', async () => {
    const view = renderRefs();
    await screen.findAllByRole('link');
    fireEvent.click(within(screen.getAllByRole('listitem')[0])
      .getByRole('button', { name: 'Show link destination' }));

    view.rerenderTask(nextTaskId);
    await screen.findByRole('link', { name: 'main' });
    expect(within(screen.getByRole('listitem'))
      .getByRole('button', { name: 'Show link destination' })).toHaveAttribute('aria-expanded', 'false');

    view.rerenderTask(taskId);
    await screen.findAllByRole('link', { name: 'release/shared' });
    expect(within(screen.getAllByRole('listitem')[0])
      .getByRole('button', { name: 'Show link destination' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps filtering, order, copying, and list-only disclosure effects tied to loaded rows', async () => {
    const writeText = installClipboard(vi.fn().mockResolvedValue(undefined));
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    renderRefs();
    await screen.findAllByRole('link');

    const firstRow = screen.getAllByRole('listitem')[0];
    fireEvent.click(within(firstRow).getByRole('button', { name: 'Show link destination' }));
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.post).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole('combobox', { name: 'Git reference kind' }), {
      target: { value: 'branch' },
    });
    expect(screen.getByText('Showing 2 of 4 loaded Git references.')).toBeInTheDocument();
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      references[0].url,
      references[1].url,
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Copy 2 available Git reference links' }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith([references[0].url, references[1].url].join('\n'));
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.post).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });
});
