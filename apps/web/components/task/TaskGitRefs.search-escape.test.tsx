import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

function renderRefs(parentKeyDown?: ReturnType<typeof vi.fn>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <div onKeyDown={parentKeyDown}>
      <QueryClientProvider client={client}>
        <TaskGitRefs taskId={taskId} />
      </QueryClientProvider>
    </div>,
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

function pressEscape(target: Element, init: KeyboardEventInit = {}) {
  return fireEvent.keyDown(target, {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
    ...init,
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

describe('TaskGitRefs search Escape recovery', () => {
  it('clears a nonempty query without moving focus and stops the clearing key', async () => {
    const user = userEvent.setup();
    const parentKeyDown = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);
    renderRefs(parentKeyDown);

    const input = await screen.findByRole('searchbox', { name: 'Search loaded Git references' });
    await user.type(input, 'release/current');
    expect(input).toHaveValue('release/current');
    expect(screen.getByText('Showing 1 of 4 loaded Git references.')).toBeInTheDocument();
    expect(listLabels()).toEqual(['release/current']);

    parentKeyDown.mockClear();
    input.focus();
    const wasNotCanceled = pressEscape(input);

    expect(wasNotCanceled).toBe(false);
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    expect(parentKeyDown).not.toHaveBeenCalled();
    expect(screen.getByText('Showing 4 of 4 loaded Git references.')).toBeInTheDocument();
    expect(listLabels()).toEqual([
      'release/current', 'example/repo', 'Reference link unavailable', '0123456',
    ]);
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset Git reference filters' })).toBeDisabled();
    expect(document.body).not.toHaveTextContent(privateMarker);
    expect(api.get).toHaveBeenCalledOnce();
    expect(api.post).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('clears a whitespace-only raw query even though it does not filter rows', async () => {
    const parentKeyDown = vi.fn();
    renderRefs(parentKeyDown);
    const input = await screen.findByRole('searchbox', { name: 'Search loaded Git references' });
    fireEvent.change(input, { target: { value: '   ' } });

    expect(input).toHaveValue('   ');
    expect(screen.getByText('Showing 4 of 4 loaded Git references.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear search' })).toBeInTheDocument();
    parentKeyDown.mockClear();

    const wasNotCanceled = pressEscape(input);

    expect(wasNotCanceled).toBe(false);
    expect(parentKeyDown).not.toHaveBeenCalled();
    expect(input).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
    expect(api.get).toHaveBeenCalledOnce();
  });

  it.each([
    ['empty query', '', {}],
    ['composition', 'release', { isComposing: true }],
    ['Alt modifier', 'release', { altKey: true }],
    ['Control modifier', 'release', { ctrlKey: true }],
    ['Meta modifier', 'release', { metaKey: true }],
    ['Shift modifier', 'release', { shiftKey: true }],
  ])('does not intercept Escape for %s', async (_label, query, init) => {
    const parentKeyDown = vi.fn();
    renderRefs(parentKeyDown);
    const input = await screen.findByRole('searchbox', { name: 'Search loaded Git references' });
    if (query) fireEvent.change(input, { target: { value: query } });
    parentKeyDown.mockClear();

    const wasNotCanceled = pressEscape(input, init);

    expect(wasNotCanceled).toBe(true);
    expect(parentKeyDown).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue(query);
  });

  it('does not intercept unrelated keys or Escape outside the search input', async () => {
    const parentKeyDown = vi.fn();
    renderRefs(parentKeyDown);
    const input = await screen.findByRole('searchbox', { name: 'Search loaded Git references' });
    fireEvent.change(input, { target: { value: 'release' } });
    parentKeyDown.mockClear();

    expect(fireEvent.keyDown(input, { key: 'Enter', bubbles: true, cancelable: true })).toBe(true);
    expect(parentKeyDown).toHaveBeenCalledTimes(1);
    parentKeyDown.mockClear();

    const clearButton = screen.getByRole('button', { name: 'Clear search' });
    expect(pressEscape(clearButton)).toBe(true);
    expect(parentKeyDown).toHaveBeenCalledTimes(1);
    expect(input).toHaveValue('release');
  });

  it('clears only search and preserves kind, available-only, order, count, and row controls', async () => {
    const user = userEvent.setup();
    const pushState = vi.spyOn(window.history, 'pushState');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
    renderRefs();

    const kind = await screen.findByRole('combobox', { name: 'Git reference kind' });
    const availableOnly = screen.getByRole('checkbox', { name: 'Show available links only' });
    fireEvent.change(kind, { target: { value: 'branch' } });
    fireEvent.click(availableOnly);
    const input = screen.getByRole('searchbox', { name: 'Search loaded Git references' });
    await user.type(input, 'no-match');

    expect(screen.getByText(
      'No matching Git references in the loaded list. Clear search or choose All references to show more. Turn off Show available links only to include unavailable references.',
    )).toBeInTheDocument();

    pressEscape(input);

    expect(input).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Git reference kind' })).toHaveValue('branch');
    expect(screen.getByRole('checkbox', { name: 'Show available links only' })).toBeChecked();
    expect(screen.getByText('Showing 1 of 4 loaded Git references.')).toBeInTheDocument();
    expect(listLabels()).toEqual(['release/current']);
    expect(screen.getByRole('link', { name: 'release/current' }))
      .toHaveAttribute('href', 'https://github.com/example/repo/tree/release/current');
    expect(screen.getByRole('button', { name: 'Copy branch reference release/current' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear search' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset Git reference filters' })).toBeEnabled();
    expect(copyButton('links', 1)).toBeEnabled();
    expect(copyButton('values', 1)).toBeEnabled();
    expect(document.body).not.toHaveTextContent(privateMarker);
    expect(api.get).toHaveBeenCalledOnce();
    expect(api.post).not.toHaveBeenCalled();
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(storageWrite).not.toHaveBeenCalled();
  });

  it('exposes the local shortcut as visible and accessible input help', async () => {
    renderRefs();
    const input = await screen.findByRole('searchbox', { name: 'Search loaded Git references' });

    expect(input).toHaveAttribute('aria-keyshortcuts', 'Escape');
    expect(input).toHaveAccessibleDescription('Press Escape to clear the search.');
    expect(screen.getByText('Press Escape to clear the search.')).toBeVisible();
  });

  it('clears settled bulk confirmations when Escape changes the search view', async () => {
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

    const input = screen.getByRole('searchbox', { name: 'Search loaded Git references' });
    fireEvent.change(input, { target: { value: 'release' } });
    pressEscape(input);

    expect(input).toHaveValue('');
    expect(screen.queryByText('Available Git reference links copied.')).not.toBeInTheDocument();
    expect(screen.queryByText('Available Git reference values copied.')).not.toBeInTheDocument();
    expect(copyButton('links', 1)).toBeEnabled();
    expect(copyButton('values', 1)).toBeEnabled();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(api.get).toHaveBeenCalledOnce();
  });

  it.each([
    { kind: 'links' as const, outcome: 'resolve' as const },
    { kind: 'links' as const, outcome: 'reject' as const },
    { kind: 'values' as const, outcome: 'resolve' as const },
    { kind: 'values' as const, outcome: 'reject' as const },
  ])('does not apply a deferred $outcome for $kind copy after Escape and an ABA return to the same safe payload', async ({ kind, outcome }) => {
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

    const input = screen.getByRole('searchbox', { name: 'Search loaded Git references' });
    fireEvent.change(input, { target: { value: 'release' } });
    pressEscape(input);
    expect(input).toHaveValue('');
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
