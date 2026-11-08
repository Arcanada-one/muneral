import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const taskA = '11111111-1111-4111-8111-111111111111';
const taskB = '22222222-2222-4222-8222-222222222222';
const safeBranchUrl = 'https://github.com/example/repo/tree/release/current';
const safeRepositoryUrlValue = 'https://github.com/example/repo';
const secondSafeBranchUrl = 'https://github.com/example/other/tree/release/next';
const missingUrlRef = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', taskId: taskA, type: 'branch' as const,
  // Contract requires non-empty url; unparseable values are rejected by safeRepositoryUrl.
  url: 'not-a-url', ref: 'missing-parse-ref', createdAt: '2026-11-02T00:07:00.000Z',
};
const refs = [
  {
    id: '33333333-3333-4333-8333-333333333333', taskId: taskA, type: 'branch',
    url: safeBranchUrl, ref: 'release/current', createdAt: '2026-11-02T00:00:00.000Z',
  },
  {
    id: '44444444-4444-4444-8444-444444444444', taskId: taskA, type: 'branch',
    url: 'https://user:private-credential@example.test/repo',
    ref: 'private-credential-ref', createdAt: '2026-11-02T00:01:00.000Z',
  },
  {
    id: '55555555-5555-4555-8555-555555555555', taskId: taskA, type: 'repo',
    url: safeRepositoryUrlValue, ref: 'example/repo', createdAt: '2026-11-02T00:02:00.000Z',
  },
  {
    id: '66666666-6666-4666-8666-666666666666', taskId: taskA, type: 'commit',
    url: 'https://example.test/repo?token=private-query', ref: 'private-query-ref',
    createdAt: '2026-11-02T00:03:00.000Z',
  },
  {
    id: '77777777-7777-4777-8777-777777777777', taskId: taskA, type: 'branch',
    url: 'https://example.test/repo#private-fragment', ref: 'private-fragment-ref',
    createdAt: '2026-11-02T00:04:00.000Z',
  },
  {
    id: '88888888-8888-4888-8888-888888888888', taskId: taskA, type: 'branch',
    url: 'javascript:private-scheme-value', ref: 'private-scheme-ref',
    createdAt: '2026-11-02T00:05:00.000Z',
  },
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', taskId: taskA, type: 'branch',
    url: secondSafeBranchUrl, ref: 'release/next', createdAt: '2026-11-02T00:06:00.000Z',
  },
  missingUrlRef,
];
const taskBRefs = [{
  id: '99999999-9999-4999-8999-999999999999', taskId: taskB, type: 'repo',
  url: 'https://github.com/next/project', ref: 'next/project', createdAt: '2026-11-02T00:06:00.000Z',
}];
const privateMarkers = [
  'private-credential', 'private-query', 'private-fragment', 'private-scheme', 'not-a-url', 'missing-parse-ref',
];
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function renderRefs(initialTaskId = taskA) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const renderTask = (taskId: string) => (
    <QueryClientProvider client={client}>
      <TaskGitRefs taskId={taskId} />
    </QueryClientProvider>
  );
  const view = render(renderTask(initialTaskId));
  return {
    ...view,
    client,
    rerenderTask: (taskId: string) => view.rerender(renderTask(taskId)),
  };
}

function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

function renderedHrefs() {
  return screen.queryAllByRole('link').map((link) => link.getAttribute('href'));
}

function listLabels() {
  return screen.getAllByRole('listitem').map((item) => {
    const alert = item.querySelector('[role="alert"]');
    if (alert?.textContent) return alert.textContent;
    const link = item.querySelector('a');
    return link?.textContent ?? item.textContent ?? '';
  });
}

beforeEach(() => {
  api.get.mockReset().mockImplementation(async (url: string) => ({
    data: url === `/projects/tasks/${taskB}/git-refs` ? taskBRefs : refs,
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

describe('unavailable-only loaded Git reference filter', () => {
  it('starts off and keeps only safeRepositoryUrl-rejected rows when enabled', async () => {
    const writeText = vi.fn();
    installClipboard(writeText);
    const pushState = vi.spyOn(window.history, 'pushState');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    renderRefs();

    const unavailableOnly = await screen.findByRole('checkbox', { name: 'Show unavailable links only' });
    const availableOnly = screen.getByRole('checkbox', { name: 'Show available links only' });
    expect(unavailableOnly).not.toBeChecked();
    expect(availableOnly).not.toBeChecked();
    expect(screen.getByText('Showing 8 of 8 loaded Git references.')).toBeInTheDocument();
    expect(renderedHrefs()).toEqual([safeBranchUrl, safeRepositoryUrlValue, secondSafeBranchUrl]);
    expect(screen.getAllByText('Reference link unavailable')).toHaveLength(5);
    for (const marker of privateMarkers) expect(document.body).not.toHaveTextContent(marker);

    fireEvent.click(unavailableOnly);
    expect(unavailableOnly).toBeChecked();
    expect(availableOnly).not.toBeChecked();
    expect(screen.getByText('Showing 5 of 8 loaded Git references.')).toBeInTheDocument();
    expect(renderedHrefs()).toEqual([]);
    expect(screen.getAllByText('Reference link unavailable')).toHaveLength(5);
    expect(listLabels()).toEqual([
      'Reference link unavailable',
      'Reference link unavailable',
      'Reference link unavailable',
      'Reference link unavailable',
      'Reference link unavailable',
    ]);
    for (const marker of privateMarkers) expect(document.body).not.toHaveTextContent(marker);
    expect(screen.getByRole('button', { name: 'Copy 0 available Git reference links' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copy 0 available Git reference values' })).toBeDisabled();
    expect(writeText).not.toHaveBeenCalled();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.post).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('is mutually exclusive with available-only and resets both availability flags with kind/search', async () => {
    renderRefs();
    const unavailableOnly = await screen.findByRole('checkbox', { name: 'Show unavailable links only' });
    const availableOnly = screen.getByRole('checkbox', { name: 'Show available links only' });
    const kind = screen.getByRole('combobox', { name: 'Git reference kind' });
    const search = screen.getByRole('searchbox', { name: 'Search loaded Git references' });
    const reset = screen.getByRole('button', { name: 'Reset Git reference filters' });

    expect(reset).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Wrap Git reference text' })).not.toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Reverse Git reference order' })).not.toBeInTheDocument();

    fireEvent.click(unavailableOnly);
    expect(unavailableOnly).toBeChecked();
    expect(availableOnly).not.toBeChecked();
    expect(reset).toBeEnabled();

    fireEvent.click(availableOnly);
    expect(availableOnly).toBeChecked();
    expect(unavailableOnly).not.toBeChecked();
    expect(screen.getByText('Showing 3 of 8 loaded Git references.')).toBeInTheDocument();
    expect(renderedHrefs()).toEqual([safeBranchUrl, safeRepositoryUrlValue, secondSafeBranchUrl]);

    fireEvent.click(unavailableOnly);
    expect(unavailableOnly).toBeChecked();
    expect(availableOnly).not.toBeChecked();
    expect(screen.getByText('Showing 5 of 8 loaded Git references.')).toBeInTheDocument();

    fireEvent.change(kind, { target: { value: 'branch' } });
    fireEvent.change(search, { target: { value: 'Reference link unavailable' } });
    expect(screen.getByText('Showing 4 of 8 loaded Git references.')).toBeInTheDocument();

    fireEvent.click(reset);
    expect(kind).toHaveValue('all');
    expect(search).toHaveValue('');
    expect(availableOnly).not.toBeChecked();
    expect(unavailableOnly).not.toBeChecked();
    expect(reset).toBeDisabled();
    expect(screen.getByText('Showing 8 of 8 loaded Git references.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Wrap Git reference text' })).not.toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Reverse Git reference order' })).not.toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('composes with kind, search, and loaded order without exposing rejected URLs', async () => {
    renderRefs();
    await screen.findByRole('checkbox', { name: 'Show unavailable links only' });
    const kind = screen.getByRole('combobox', { name: 'Git reference kind' });
    const search = screen.getByRole('searchbox', { name: 'Search loaded Git references' });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show unavailable links only' }));
    fireEvent.change(kind, { target: { value: 'commit' } });
    expect(screen.getByText('Showing 1 of 8 loaded Git references.')).toBeInTheDocument();
    expect(listLabels()).toEqual(['Reference link unavailable']);

    fireEvent.change(kind, { target: { value: 'branch' } });
    fireEvent.change(search, { target: { value: 'REFERENCE LINK UNAVAILABLE' } });
    expect(screen.getByText('Showing 4 of 8 loaded Git references.')).toBeInTheDocument();
    expect(renderedHrefs()).toEqual([]);
    for (const marker of privateMarkers) expect(document.body).not.toHaveTextContent(marker);

    fireEvent.change(search, { target: { value: 'release/current' } });
    expect(screen.getByText('Showing 0 of 8 loaded Git references.')).toBeInTheDocument();
    expect(screen.getByText(/No matching Git references in the loaded list\./)).toHaveTextContent(
      'Turn off Show unavailable links only to include available references.',
    );
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('keeps duplicate unavailable rows and safe zero-copy batch controls', async () => {
    const writeText = vi.fn();
    installClipboard(writeText);
    const view = renderRefs();
    await screen.findByRole('checkbox', { name: 'Show unavailable links only' });

    const duplicated = [
      ...refs,
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', taskId: taskA, type: 'branch',
        url: 'https://user:private-credential@example.test/repo',
        ref: 'private-credential-ref-duplicate', createdAt: '2026-11-02T00:08:00.000Z',
      },
    ];
    view.client.setQueryData(['tasks', taskA, 'git-refs'], duplicated);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show unavailable links only' }));

    expect(screen.getByText('Showing 6 of 9 loaded Git references.')).toBeInTheDocument();
    expect(screen.getAllByText('Reference link unavailable')).toHaveLength(6);
    expect(screen.getByRole('button', { name: 'Copy 0 available Git reference links' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copy 0 available Git reference values' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Copy 0 available Git reference links' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy 0 available Git reference values' }));
    expect(writeText).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent('private-credential');
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('preserves mode across refresh, empty, and A-B-A task changes without new mutations', async () => {
    const view = renderRefs();
    const unavailableOnly = await screen.findByRole('checkbox', { name: 'Show unavailable links only' });
    fireEvent.click(unavailableOnly);

    const refreshed = [
      { ...refs[0], url: 'https://github.com/example/refreshed/tree/main', ref: 'main' },
      { ...refs[1], url: 'https://user:private-new@example.test/repo', ref: 'private-new-ref' },
    ];
    view.client.setQueryData(['tasks', taskA, 'git-refs'], refreshed);
    await waitFor(() => expect(screen.getByText('Showing 1 of 2 loaded Git references.')).toBeInTheDocument());
    expect(listLabels()).toEqual(['Reference link unavailable']);
    expect(document.body).not.toHaveTextContent('private-new');

    view.client.setQueryData(['tasks', taskA, 'git-refs'], []);
    expect(await screen.findByText('No Git references.')).toBeInTheDocument();
    view.client.setQueryData(['tasks', taskA, 'git-refs'], refreshed);
    expect(await screen.findByRole('checkbox', { name: 'Show unavailable links only' })).toBeChecked();
    expect(screen.getByText('Showing 1 of 2 loaded Git references.')).toBeInTheDocument();

    view.rerenderTask(taskB);
    expect(await screen.findByRole('checkbox', { name: 'Show unavailable links only' })).not.toBeChecked();
    expect(renderedHrefs()).toEqual(['https://github.com/next/project']);

    view.rerenderTask(taskA);
    expect(await screen.findByRole('checkbox', { name: 'Show unavailable links only' })).not.toBeChecked();
    await waitFor(() => {
      expect(screen.getByText('Showing 8 of 8 loaded Git references.')).toBeInTheDocument();
    });
    expect(api.get.mock.calls).toEqual([
      [`/projects/tasks/${taskA}/git-refs`],
      [`/projects/tasks/${taskB}/git-refs`],
      [`/projects/tasks/${taskA}/git-refs`],
    ]);
    expect(api.post).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)(
    'clears stale batch-copy feedback when selecting unavailable-only before deferred %s',
    async (outcome) => {
      let resolveCopy: (() => void) | undefined;
      let rejectCopy: ((reason: Error) => void) | undefined;
      const writeText = vi.fn(() => new Promise<void>((resolve, reject) => {
        resolveCopy = resolve;
        rejectCopy = reject;
      }));
      installClipboard(writeText);
      renderRefs();

      const copyButton = await screen.findByRole('button', { name: 'Copy 3 available Git reference links' });
      fireEvent.click(copyButton);
      expect(writeText).toHaveBeenCalledWith(
        `${safeBranchUrl}\n${safeRepositoryUrlValue}\n${secondSafeBranchUrl}`,
      );

      fireEvent.click(screen.getByRole('checkbox', { name: 'Show unavailable links only' }));
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Copy 0 available Git reference links' })).toBeDisabled();

      await act(async () => {
        if (outcome === 'resolve') resolveCopy?.();
        else rejectCopy?.(new Error('Synthetic clipboard rejection'));
      });
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByText('Could not copy available Git reference links. Try again.')).not.toBeInTheDocument();
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(api.get).toHaveBeenCalledTimes(1);
    },
  );
});
