import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
const refs = [
  {
    id: '33333333-3333-4333-8333-333333333333', taskId, type: 'branch',
    url: 'https://github.com/example/repo/tree/release/current', ref: 'release/current',
    createdAt: '2026-11-02T00:00:00.000Z',
  },
  {
    id: '44444444-4444-4444-8444-444444444444', taskId, type: 'repo',
    url: 'https://github.com/example/repo', ref: 'example/repo',
    createdAt: '2026-11-02T00:01:00.000Z',
  },
  {
    id: '55555555-5555-4555-8555-555555555555', taskId, type: 'branch',
    url: 'https://user:private-credential@example.test/repo', ref: 'private-credential-ref',
    createdAt: '2026-11-02T00:02:00.000Z',
  },
  {
    id: '66666666-6666-4666-8666-666666666666', taskId, type: 'commit',
    url: 'https://github.com/example/repo/commit/0123456', ref: '0123456',
    createdAt: '2026-11-02T00:03:00.000Z',
  },
];
const privateMarker = 'private-credential';
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function renderRefs() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <TaskGitRefs taskId={taskId} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

function deferredWriteText() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { writeText: vi.fn(() => promise), resolve, reject };
}

async function settleDeferred(
  deferred: ReturnType<typeof deferredWriteText>,
  outcome: 'resolve' | 'reject',
) {
  await act(async () => {
    if (outcome === 'resolve') deferred.resolve();
    else deferred.reject(new Error('private clipboard failure detail'));
  });
}

function copyButton(kind: 'links' | 'values', count: number) {
  return screen.getByRole('button', {
    name: `Copy ${count} available Git reference ${kind}`,
  });
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
  api.get.mockReset().mockResolvedValue({ data: refs });
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

describe('reset loaded Git reference filters', () => {
  it('restores all loaded rows and counts without exposing rejected values', { timeout: 15000 }, async () => {
    const writeText = vi.fn();
    installClipboard(writeText);
    const pushState = vi.spyOn(window.history, 'pushState');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    renderRefs();

    const kind = await screen.findByRole('combobox', { name: 'Git reference kind' }, { timeout: 10000 });
    const search = screen.getByRole('searchbox', { name: 'Search loaded Git references' });
    const availableOnly = screen.getByRole('checkbox', { name: 'Show available links only' });
    const reset = screen.getByRole('button', { name: 'Reset Git reference filters' });
    expect(reset).toBeDisabled();
    // Wrap control is absent on measured origin/main tip; preservation is NOT_MEASURED as a product surface here.
    expect(screen.getByRole('checkbox', { name: 'Wrap Git reference text' })).not.toBeChecked();

    fireEvent.change(kind, { target: { value: 'branch' } });
    fireEvent.change(search, { target: { value: 'release/current' } });
    fireEvent.click(availableOnly);
    expect(screen.getByText('Showing 1 of 4 loaded Git references.')).toBeInTheDocument();
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      'https://github.com/example/repo/tree/release/current',
    ]);
    expect(screen.getByRole('button', { name: 'Reset Git reference filters' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Reset Git reference filters' }));

    expect(screen.getByRole('combobox', { name: 'Git reference kind' })).toHaveValue('all');
    expect(screen.getByRole('searchbox', { name: 'Search loaded Git references' })).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: 'Show available links only' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Wrap Git reference text' })).not.toBeChecked();
    expect(screen.getByText('Showing 4 of 4 loaded Git references.')).toBeInTheDocument();
    expect(listLabels()).toEqual([
      'release/current', 'example/repo', 'Reference link unavailable', '0123456',
    ]);
    expect(screen.getByRole('link', { name: 'release/current' }))
      .toHaveAttribute('href', 'https://github.com/example/repo/tree/release/current');
    expect(screen.getByRole('button', { name: 'Copy branch reference release/current' })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(privateMarker);
    expect(copyButton('links', 3)).toBeEnabled();
    expect(copyButton('values', 3)).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reset Git reference filters' })).toBeDisabled();
    expect(api.get).toHaveBeenCalledOnce();
    expect(api.post).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
  });

  it('keeps loading, read-error, and true-empty branches outside the filter controls', async () => {
    let finishLoad: ((response: { data: typeof refs }) => void) | undefined;
    api.get.mockReset().mockImplementationOnce(() => new Promise((resolve) => {
      finishLoad = resolve;
    }));
    const loadingView = renderRefs();
    expect(screen.getByText('Loading Git references…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset Git reference filters' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Git reference kind' })).not.toBeInTheDocument();
    await act(async () => finishLoad?.({ data: refs }));
    expect(await screen.findByRole('combobox', { name: 'Git reference kind' })).toBeInTheDocument();
    loadingView.unmount();

    api.get.mockReset().mockRejectedValueOnce(new Error('Synthetic Git reference read failure'));
    const errorView = renderRefs();
    expect(await screen.findByText('Git references are unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset Git reference filters' })).not.toBeInTheDocument();
    errorView.unmount();

    api.get.mockReset().mockResolvedValueOnce({ data: [] });
    renderRefs();
    expect(await screen.findByText('No Git references.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset Git reference filters' })).not.toBeInTheDocument();
    expect(api.get).toHaveBeenCalledOnce();
  });

  it('keeps whitespace search resettable even though it currently matches the unfiltered list', async () => {
    renderRefs();
    const search = await screen.findByRole('searchbox', { name: 'Search loaded Git references' });

    fireEvent.change(search, { target: { value: '   ' } });
    expect(screen.getByText('Showing 4 of 4 loaded Git references.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset Git reference filters' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Reset Git reference filters' }));
    expect(screen.getByRole('searchbox', { name: 'Search loaded Git references' })).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Reset Git reference filters' })).toBeDisabled();
    expect(api.get).toHaveBeenCalledOnce();
  });

  it('preserves filter-empty guidance and restores generic unavailable rows', async () => {
    renderRefs();
    await screen.findByRole('combobox', { name: 'Git reference kind' });

    fireEvent.change(screen.getByRole('combobox', { name: 'Git reference kind' }), {
      target: { value: 'commit' },
    });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search loaded Git references' }), {
      target: { value: 'no-match' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show available links only' }));

    expect(screen.getByText(
      'No matching Git references in the loaded list. Clear search or choose All references to show more. Turn off Show available links only to include unavailable references.',
    )).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset Git reference filters' }));

    expect(screen.getByText('Showing 4 of 4 loaded Git references.')).toBeInTheDocument();
    expect(screen.getByText('Reference link unavailable')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(privateMarker);
    expect(api.get).toHaveBeenCalledOnce();
  });

  it('clears both settled batch confirmations on reset without another read or clipboard action', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);
    renderRefs();
    fireEvent.change(await screen.findByRole('combobox', { name: 'Git reference kind' }), {
      target: { value: 'branch' },
    });

    fireEvent.click(copyButton('links', 1));
    fireEvent.click(copyButton('values', 1));
    expect(await screen.findByText('Available Git reference links copied.')).toBeInTheDocument();
    expect(await screen.findByText('Available Git reference values copied.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset Git reference filters' }));

    expect(screen.queryByText('Available Git reference links copied.')).not.toBeInTheDocument();
    expect(screen.queryByText('Available Git reference values copied.')).not.toBeInTheDocument();
    expect(copyButton('links', 3)).toBeEnabled();
    expect(copyButton('values', 3)).toBeEnabled();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(api.get).toHaveBeenCalledOnce();
  });

  it('clears batch feedback when reset returns to an equal available payload after refresh', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);
    const view = renderRefs();
    await screen.findByRole('combobox', { name: 'Git reference kind' });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show available links only' }));
    fireEvent.click(copyButton('links', 3));
    fireEvent.click(copyButton('values', 3));
    expect(await screen.findByText('Available Git reference links copied.')).toBeInTheDocument();
    expect(await screen.findByText('Available Git reference values copied.')).toBeInTheDocument();

    const refreshed = refs.map((ref) => ({ ...ref }));
    view.client.setQueryData(['tasks', taskId, 'git-refs'], refreshed);
    expect(screen.getByText('Available Git reference links copied.')).toBeInTheDocument();
    expect(screen.getByText('Available Git reference values copied.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset Git reference filters' }));
    expect(screen.queryByText('Available Git reference links copied.')).not.toBeInTheDocument();
    expect(screen.queryByText('Available Git reference values copied.')).not.toBeInTheDocument();
    expect(copyButton('links', 3)).toBeEnabled();
    expect(copyButton('values', 3)).toBeEnabled();
    expect(listLabels()).toEqual([
      'release/current', 'example/repo', 'Reference link unavailable', '0123456',
    ]);
    expect(api.get).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it.each([
    { kind: 'links' as const, outcome: 'resolve' as const },
    { kind: 'links' as const, outcome: 'reject' as const },
    { kind: 'values' as const, outcome: 'resolve' as const },
    { kind: 'values' as const, outcome: 'reject' as const },
  ])('does not apply a deferred $outcome for $kind copy after reset and an ABA return to the same safe payload', async ({ kind, outcome }) => {
    const deferred = deferredWriteText();
    installClipboard(deferred.writeText);
    renderRefs();
    const selector = await screen.findByRole('combobox', { name: 'Git reference kind' });

    fireEvent.change(selector, { target: { value: 'branch' } });
    fireEvent.click(copyButton(kind, 1));
    expect(copyButton(kind, 1)).toBeDisabled();
    expect(deferred.writeText).toHaveBeenCalledWith(kind === 'links'
      ? 'https://github.com/example/repo/tree/release/current'
      : 'release/current');

    fireEvent.click(screen.getByRole('button', { name: 'Reset Git reference filters' }));
    expect(screen.getByRole('combobox', { name: 'Git reference kind' })).toHaveValue('all');
    expect(copyButton(kind, 3)).toBeEnabled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Git reference kind' }), {
      target: { value: 'branch' },
    });
    expect(copyButton(kind, 1)).toBeEnabled();
    expect(screen.queryByText('Available Git reference links copied.')).not.toBeInTheDocument();
    expect(screen.queryByText('Available Git reference values copied.')).not.toBeInTheDocument();
    expect(screen.queryByText('Could not copy available Git reference links. Try again.')).not.toBeInTheDocument();
    expect(screen.queryByText('Could not copy available Git reference values. Try again.')).not.toBeInTheDocument();

    await settleDeferred(deferred, outcome);

    expect(copyButton(kind, 1)).toBeEnabled();
    expect(screen.queryByText('Available Git reference links copied.')).not.toBeInTheDocument();
    expect(screen.queryByText('Available Git reference values copied.')).not.toBeInTheDocument();
    expect(screen.queryByText('Could not copy available Git reference links. Try again.')).not.toBeInTheDocument();
    expect(screen.queryByText('Could not copy available Git reference values. Try again.')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('private clipboard failure detail');
    expect(api.get).toHaveBeenCalledOnce();
    expect(deferred.writeText).toHaveBeenCalledOnce();
  });
});
