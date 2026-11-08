'use client';

import { useId, useRef, useState } from 'react';
import { Copy, GitBranch, GitCommit, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTaskGitRefs, type TaskGitRef } from '@/lib/api/tasks';
import { safeRepositoryUrl } from '@/components/project/ProjectRepository';

const iconMap = {
  repo: ExternalLink,
  branch: GitBranch,
  commit: GitCommit,
};

const referenceLabels = {
  repo: 'repository',
  branch: 'branch',
  commit: 'commit',
};

type GitReferenceKind = 'all' | TaskGitRef['type'];

function CopyGitReference({ value, label }: { value: string; label: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [isCopying, setIsCopying] = useState(false);

  const copyReference = async () => {
    setCopyState('idle');
    setIsCopying(true);
    try {
      await navigator.clipboard.writeText(value);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    } finally {
      setIsCopying(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        onClick={copyReference}
        disabled={isCopying}
        aria-label={`Copy ${label} reference ${value}`}
      >
        <Copy className="h-3 w-3" />
      </Button>
      {copyState === 'copied' && (
        <span role="status" className="basis-full text-xs text-green-700">Git reference copied.</span>
      )}
      {copyState === 'failed' && (
        <span role="alert" className="basis-full text-xs text-destructive">
          Could not copy Git reference. Try copying it manually.
        </span>
      )}
    </>
  );
}

function CopyAvailableGitReferenceLinks({ urls }: { urls: string[] }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [isCopying, setIsCopying] = useState(false);
  const isCopyingRef = useRef(false);

  const copyLinks = async () => {
    if (isCopyingRef.current || urls.length === 0) return;

    isCopyingRef.current = true;
    setCopyState('idle');
    setIsCopying(true);

    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      isCopyingRef.current = false;
      setIsCopying(false);
      setCopyState('failed');
      return;
    }

    try {
      await clipboard.writeText(urls.join('\n'));
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    } finally {
      isCopyingRef.current = false;
      setIsCopying(false);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => { void copyLinks(); }}
        disabled={urls.length === 0 || isCopying}
        aria-label={`Copy ${urls.length} available Git reference links`}
        aria-busy={isCopying}
      >
        <Copy className="h-3 w-3" />
        {isCopying ? 'Copying available links…' : `Copy available links (${urls.length})`}
      </Button>
      {copyState === 'copied' && (
        <span role="status" className="text-xs text-green-700">Available Git reference links copied.</span>
      )}
      {copyState === 'failed' && (
        <span role="alert" className="text-xs text-destructive">
          Could not copy available Git reference links. Try again.
        </span>
      )}
    </span>
  );
}

function CopyAvailableGitReferenceValues({ refs }: { refs: TaskGitRef[] }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [isCopying, setIsCopying] = useState(false);
  const isCopyingRef = useRef(false);
  const values = refs.map((ref) => ref.ref || ref.url);

  const copyValues = async () => {
    if (isCopyingRef.current || values.length === 0) return;

    isCopyingRef.current = true;
    setCopyState('idle');
    setIsCopying(true);

    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      isCopyingRef.current = false;
      setIsCopying(false);
      setCopyState('failed');
      return;
    }

    try {
      await clipboard.writeText(values.join('\n'));
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    } finally {
      isCopyingRef.current = false;
      setIsCopying(false);
    }
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => { void copyValues(); }}
        disabled={values.length === 0 || isCopying}
        aria-label={`Copy ${values.length} available Git reference values`}
        aria-busy={isCopying}
      >
        <Copy className="h-3 w-3" />
        {isCopying ? 'Copying available references…' : `Copy available reference values (${values.length})`}
      </Button>
      {copyState === 'copied' && (
        <span role="status" className="text-xs text-green-700">Available Git reference values copied.</span>
      )}
      {copyState === 'failed' && (
        <span role="alert" className="text-xs text-destructive">
          Could not copy available Git reference values. Try again.
        </span>
      )}
    </span>
  );
}

export function TaskGitRefs({ taskId }: { taskId: string }) {
  return <TaskGitRefsForTask key={taskId} taskId={taskId} />;
}

function TaskGitRefsForTask({ taskId }: { taskId: string }) {
  const [selectedKind, setSelectedKind] = useState<GitReferenceKind>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [availableLinksOnly, setAvailableLinksOnly] = useState(false);
  const kindSelectId = useId();
  const searchInputId = useId();
  const availableOnlyId = `${kindSelectId}-available-only`;
  const { data: refs, dataUpdatedAt, isLoading, isError, isFetching, refetch } = useTaskGitRefs(taskId);
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const filteredRefs = (refs ?? []).filter((ref) => {
    if (selectedKind !== 'all' && ref.type !== selectedKind) return false;
    if (availableLinksOnly && !safeRepositoryUrl(ref.url)) return false;
    if (!normalizedSearchQuery) return true;

    if (!safeRepositoryUrl(ref.url)) {
      return 'Reference link unavailable'.toLowerCase().includes(normalizedSearchQuery);
    }

    const referenceText = ref.ref || ref.url;
    return `${referenceText}\n${ref.url}`.toLowerCase().includes(normalizedSearchQuery);
  });
  const availableLinkUrls = filteredRefs
    .filter((ref) => safeRepositoryUrl(ref.url))
    .map((ref) => ref.url);
  const availableReferences = filteredRefs.filter((ref) => safeRepositoryUrl(ref.url));
  const visibleBatchKey = JSON.stringify([
    taskId,
    selectedKind,
    searchQuery,
    availableLinksOnly,
    (refs ?? []).map((ref) => [ref.id, ref.type, ref.ref, ref.url]),
  ]);
  const availableReferencesKey = JSON.stringify([
    taskId,
    selectedKind,
    searchQuery,
    availableLinksOnly,
    dataUpdatedAt,
    availableReferences.map((ref) => [ref.id, ref.type, ref.ref, ref.url]),
  ]);

  let body;
  if (isLoading || (isError && isFetching)) {
    body = <p className="text-sm text-muted-foreground">Loading Git references…</p>;
  } else if (isError) {
    body = (
      <>
        <p role="alert" className="text-sm text-muted-foreground">Git references are unavailable.</p>
        <button
          type="button"
          aria-label="Retry Git references"
          className="mt-2 rounded text-sm text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isFetching}
          onClick={() => { void refetch(); }}
        >
          Retry
        </button>
      </>
    );
  } else if (refs === undefined) {
    body = <p className="text-sm text-muted-foreground">Git references have not been loaded.</p>;
  } else if (refs.length === 0) {
    body = (
      <>
        <p className="text-sm text-muted-foreground">No Git references.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <CopyAvailableGitReferenceLinks key={visibleBatchKey} urls={availableLinkUrls} />
          <CopyAvailableGitReferenceValues key={availableReferencesKey} refs={availableReferences} />
        </div>
      </>
    );
  } else {
    body = (
      <>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <label htmlFor={kindSelectId} className="text-sm">
            Git reference kind
          </label>
          <select
            id={kindSelectId}
            aria-label="Git reference kind"
            className="rounded border bg-background px-2 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            value={selectedKind}
            onChange={(event) => setSelectedKind(event.target.value as GitReferenceKind)}
          >
            <option value="all">All references</option>
            <option value="repo">Repositories</option>
            <option value="branch">Branches</option>
            <option value="commit">Commits</option>
          </select>
          <label htmlFor={searchInputId} className="text-sm">
            Search loaded Git references
          </label>
          <input
            id={searchInputId}
            type="search"
            aria-label="Search loaded Git references"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key !== 'Escape' ||
                searchQuery === '' ||
                event.nativeEvent.isComposing ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey
              ) {
                return;
              }

              event.preventDefault();
              event.stopPropagation();
              setSearchQuery('');
            }}
            aria-describedby={`${searchInputId}-hint`}
            aria-keyshortcuts="Escape"
            className="min-w-0 rounded border bg-background px-2 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
          <span id={`${searchInputId}-hint`} className="basis-full text-xs text-muted-foreground">
            Press Escape to clear the search.
          </span>
          <label htmlFor={availableOnlyId} className="inline-flex items-center gap-2 text-sm">
            <input
              id={availableOnlyId}
              type="checkbox"
              checked={availableLinksOnly}
              onChange={(event) => setAvailableLinksOnly(event.target.checked)}
            />
            Show available links only
          </label>
          {searchQuery !== '' && (
            <Button type="button" variant="outline" size="sm" onClick={() => setSearchQuery('')}>
              Clear search
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={selectedKind === 'all' && searchQuery === '' && !availableLinksOnly}
            onClick={() => {
              setSelectedKind('all');
              setSearchQuery('');
              setAvailableLinksOnly(false);
            }}
          >
            Reset Git reference filters
          </Button>
          <CopyAvailableGitReferenceLinks key={visibleBatchKey} urls={availableLinkUrls} />
          <CopyAvailableGitReferenceValues key={availableReferencesKey} refs={availableReferences} />
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          Showing {filteredRefs.length} of {refs.length} loaded Git references.
        </p>
        {filteredRefs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No matching Git references in the loaded list.{' '}
            {searchQuery !== ''
              ? 'Clear search or choose All references to show more.'
              : 'Choose All references to show more.'}
            {availableLinksOnly && ' Turn off Show available links only to include unavailable references.'}
          </p>
        ) : (
          <ul className="space-y-2">
            {filteredRefs.map((ref) => {
              const Icon = iconMap[ref.type] ?? ExternalLink;
              const referenceText = ref.ref || ref.url;
              const referenceLabel = referenceLabels[ref.type] ?? 'Git';
              if (!safeRepositoryUrl(ref.url)) {
                return (
                  <li key={ref.id}>
                    <span role="alert" className="text-sm text-muted-foreground">
                      Reference link unavailable
                    </span>
                  </li>
                );
              }

              return (
                <li key={ref.id} className="flex flex-wrap items-center gap-2">
                  <a
                    href={ref.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex min-w-0 flex-1 items-center gap-2 text-sm text-primary hover:underline"
                  >
                    <Icon className="h-4 w-4 flex-shrink-0" />
                    <span className="truncate font-mono text-xs">{referenceText}</span>
                    <ExternalLink className="h-3 w-3 flex-shrink-0 opacity-50" />
                  </a>
                  <CopyGitReference
                    key={`${taskId}:${ref.id}:${referenceText}`}
                    value={referenceText}
                    label={referenceLabel}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </>
    );
  }

  return (
    <div className="rounded-lg border p-4">
      <h4 className="mb-3 text-sm font-medium">Git References</h4>
      {body}
    </div>
  );
}
