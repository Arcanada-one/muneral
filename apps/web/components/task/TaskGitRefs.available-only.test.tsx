import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskGitRefs } from './TaskGitRefs';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ default: api }));

const taskA = '11111111-1111-4111-8111-111111111111';
const taskB = '22222222-2222-4222-8222-222222222222';
const safeBranchUrl = 'https://github.com/example/repo/tree/release/current';
const safeRepositoryUrl = 'https://github.com/example/repo';
const secondSafeBranchUrl = 'https://github.com/example/other/tree/release/next';
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
    url: safeRepositoryUrl, ref: 'example/repo', createdAt: '2026-11-02T00:02:00.000Z',
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
];
const taskBRefs = [{
  id: '99999999-9999-4999-8999-999999999999', taskId: taskB, type: 'repo',
  url: 'https://github.com/next/project', ref: 'next/project', createdAt: '2026-11-02T00:06:00.000Z',
}];
const privateMarkers = [
  'private-credential', 'private-query', 'private-fragment', 'private-scheme',
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
  return screen.getAllByRole('link').map((link) => link.getAttribute('href'));
}

beforeEach(() => {
  api.get.mockReset().mockImplementation(async (url: string) => ({
    data: url === `/projects/tasks/${taskB}/git-refs` ? taskBRefs : refs,
  }));
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

describe('available-only loaded Git reference filter', () => {
  it('starts off, keeps unavailable rows generic, and filters only loaded safe links in order', async () => {
    renderRefs();

    const availableOnly = await screen.findByRole('checkbox', { name: 'Show available links only' });
    expect(availableOnly).not.toBeChecked();
    expect(screen.getByText('Showing 7 of 7 loaded Git references.')).toBeInTheDocument();
    expect(renderedHrefs()).toEqual([safeBranchUrl, safeRepositoryUrl, secondSafeBranchUrl]);
    expect(screen.getAllByText('Reference link unavailable')).toHaveLength(4);
    for (const marker of privateMarkers) expect(document.body).not.toHaveTextContent(marker);

    fireEvent.click(availableOnly);
    expect(availableOnly).toBeChecked();
    expect(screen.getByText('Showing 3 of 7 loaded Git references.')).toBeInTheDocument();
    expect(renderedHrefs()).toEqual([safeBranchUrl, safeRepositoryUrl, secondSafeBranchUrl]);
    expect(screen.queryByText('Reference link unavailable')).not.toBeInTheDocument();
    for (const marker of privateMarkers) expect(document.body).not.toHaveTextContent(marker);

    fireEvent.click(availableOnly);
    expect(screen.getByText('Showing 7 of 7 loaded Git references.')).toBeInTheDocument();
    expect(screen.getAllByText('Reference link unavailable')).toHaveLength(4);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('intersects available-only with kind and search and explains a loaded-list empty result', async () => {
    renderRefs();
    await screen.findByRole('checkbox', { name: 'Show available links only' });
    const kind = screen.getByRole('combobox', { name: 'Git reference kind' });
    const search = screen.getByRole('searchbox', { name: 'Search loaded Git references' });

    fireEvent.change(kind, { target: { value: 'branch' } });
    fireEvent.change(search, { target: { value: 'RELEASE' } });
    expect(screen.getByText('Showing 2 of 7 loaded Git references.')).toBeInTheDocument();
    expect(renderedHrefs()).toEqual([safeBranchUrl, secondSafeBranchUrl]);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show available links only' }));
    expect(kind).toHaveValue('branch');
    expect(search).toHaveValue('RELEASE');
    expect(screen.getByText('Showing 2 of 7 loaded Git references.')).toBeInTheDocument();
    expect(renderedHrefs()).toEqual([safeBranchUrl, secondSafeBranchUrl]);

    fireEvent.change(search, { target: { value: 'private' } });
    expect(screen.getByText('Showing 0 of 7 loaded Git references.')).toBeInTheDocument();
    expect(screen.getByText(/No matching Git references in the loaded list\./)).toHaveTextContent(
      'Turn off Show available links only to include unavailable references.',
    );
    for (const marker of privateMarkers) expect(document.body).not.toHaveTextContent(marker);
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('uses refreshed safe and unsafe URLs, and preserves the mode across same-task empty data', async () => {
    const view = renderRefs();
    const availableOnly = await screen.findByRole('checkbox', { name: 'Show available links only' });
    fireEvent.click(availableOnly);

    const refreshed = [
      { ...refs[0], url: 'https://github.com/example/refreshed/tree/main', ref: 'main' },
      { ...refs[1], url: 'https://user:private-new@example.test/repo', ref: 'private-new-ref' },
    ];
    view.client.setQueryData(['tasks', taskA, 'git-refs'], refreshed);
    await waitFor(() => expect(screen.getByText('Showing 1 of 2 loaded Git references.')).toBeInTheDocument());
    expect(renderedHrefs()).toEqual(['https://github.com/example/refreshed/tree/main']);
    expect(document.body).not.toHaveTextContent('private-new');

    view.client.setQueryData(['tasks', taskA, 'git-refs'], []);
    expect(await screen.findByText('No Git references.')).toBeInTheDocument();
    view.client.setQueryData(['tasks', taskA, 'git-refs'], refreshed);
    expect(await screen.findByRole('checkbox', { name: 'Show available links only' })).toBeChecked();
    expect(screen.getByText('Showing 1 of 2 loaded Git references.')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('resets to all loaded links on task changes, including A to B to A', async () => {
    const view = renderRefs();
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Show available links only' }));
    expect(screen.getByRole('checkbox', { name: 'Show available links only' })).toBeChecked();

    view.rerenderTask(taskB);
    expect(await screen.findByRole('checkbox', { name: 'Show available links only' })).not.toBeChecked();
    expect(renderedHrefs()).toEqual(['https://github.com/next/project']);

    view.rerenderTask(taskA);
    expect(await screen.findByRole('checkbox', { name: 'Show available links only' })).not.toBeChecked();
    expect(screen.getByText('Showing 7 of 7 loaded Git references.')).toBeInTheDocument();
    expect(api.get.mock.calls).toEqual([
      [`/projects/tasks/${taskA}/git-refs`],
      [`/projects/tasks/${taskB}/git-refs`],
      [`/projects/tasks/${taskA}/git-refs`],
    ]);
  });

  it.each(['resolve', 'reject'] as const)(
    'does not let an old deferred clipboard %s label a toggled batch as copied', async (outcome) => {
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
      expect(writeText).toHaveBeenCalledWith(`${safeBranchUrl}\n${safeRepositoryUrl}\n${secondSafeBranchUrl}`);
      expect(screen.getByRole('button', { name: 'Copy 3 available Git reference links' })).toBeDisabled();

      fireEvent.click(screen.getByRole('checkbox', { name: 'Show available links only' }));
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Copy 3 available Git reference links' })).toBeEnabled();

      await act(async () => {
        if (outcome === 'resolve') resolveCopy?.();
        else rejectCopy?.(new Error('Synthetic clipboard rejection'));
      });
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Copy 3 available Git reference links' })).toBeEnabled();
      expect(api.get).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledTimes(1);
    },
  );
});
