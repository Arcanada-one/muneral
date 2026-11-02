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

function CopyGitReferenceLink({
  reference,
  url,
  label,
}: {
  reference: string;
  url: string;
  label: string;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [isCopying, setIsCopying] = useState(false);
  const isCopyingRef = useRef(false);

  const copyLink = async () => {
    if (isCopyingRef.current) return;

    isCopyingRef.current = true;
    setCopyState('idle');
    setIsCopying(true);
    try {
      await navigator.clipboard.writeText(url);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    } finally {
      isCopyingRef.current = false;
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
        onClick={copyLink}
        disabled={isCopying}
        aria-label={`Copy Git reference link for ${label} ${reference}`}
      >
        <Copy className="h-3 w-3" />
      </Button>
      {copyState === 'copied' && (
        <span role="status" className="basis-full text-xs text-green-700">Git reference link copied.</span>
      )}
      {copyState === 'failed' && (
        <span role="alert" className="basis-full text-xs text-destructive">
          Could not copy Git reference link. Try copying the link manually.
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
    try {
      await navigator.clipboard.writeText(urls.join('\n'));
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
    try {
      await navigator.clipboard.writeText(values.join('\n'));
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

function VisibleGitReferenceKindSummary({ refs }: { refs: TaskGitRef[] }) {
  let repositories = 0;
  let branches = 0;
  let commits = 0;
  let other = 0;

  for (const ref of refs) {
    if (ref.type === 'repo') repositories += 1;
    else if (ref.type === 'branch') branches += 1;
    else if (ref.type === 'commit') commits += 1;
    else other += 1;
  }

  return (
    <p role="status" aria-label="Visible reference kinds" className="mb-3 text-xs text-muted-foreground">
      Visible reference kinds for current loaded rows: Repositories {repositories}; Branches {branches}; Commits {commits}
      {other > 0 ? `; Other ${other}` : ''}.
    </p>
  );
}

function GitReferenceDestinationDisclosure({
  taskId,
  edgeId,
  url,
}: {
  taskId: string;
  edgeId: string;
  url: string;
}) {
  const identity = JSON.stringify([taskId, edgeId, url]);
  const [disclosure, setDisclosure] = useState(() => ({ identity, isExpanded: false }));

  if (disclosure.identity !== identity) {
    setDisclosure({ identity, isExpanded: false });
  }
  const isExpanded = disclosure.identity === identity && disclosure.isExpanded;

  if (!safeRepositoryUrl(url)) return null;

  const destination = new URL(url);

  return (
    <div className="basis-full min-w-0">
      <button
        type="button"
        className="rounded text-sm text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        aria-expanded={isExpanded}
        onClick={() => setDisclosure((current) => ({
          identity,
          isExpanded: current.identity === identity ? !current.isExpanded : true,
        }))}
      >
        {isExpanded ? 'Hide link destination' : 'Show link destination'}
      </button>
      {isExpanded && (
        <p className="min-w-0 whitespace-normal break-all font-mono text-xs text-muted-foreground">
          {destination.host}{destination.pathname}
        </p>
      )}
    </div>
  );
}

export function TaskGitRefs({ taskId }: { taskId: string }) {
  return <TaskGitRefsForTask key={taskId} taskId={taskId} />;
}

function TaskGitRefsForTask({ taskId }: { taskId: string }) {
  const [selectedKind, setSelectedKind] = useState<GitReferenceKind>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [availableLinksOnly, setAvailableLinksOnly] = useState(false);
  const [unavailableLinksOnly, setUnavailableLinksOnly] = useState(false);
  const [reverseLoadedOrder, setReverseLoadedOrder] = useState(false);
  const [wrapReferenceText, setWrapReferenceText] = useState(false);
  const kindSelectId = useId();
  const searchInputId = useId();
  const { data: refs, dataUpdatedAt, isLoading, isError, isFetching, refetch } = useTaskGitRefs(taskId);
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const filteredRefs = (refs ?? []).filter((ref) => {
    if (selectedKind !== 'all' && ref.type !== selectedKind) return false;
    const isAvailable = safeRepositoryUrl(ref.url);
    if (availableLinksOnly && !isAvailable) return false;
    if (unavailableLinksOnly && isAvailable) return false;
    if (!normalizedSearchQuery) return true;

    if (!safeRepositoryUrl(ref.url)) {
      return 'Reference link unavailable'.toLowerCase().includes(normalizedSearchQuery);
    }

    const referenceText = ref.ref || ref.url;
    return `${referenceText}\n${ref.url}`.toLowerCase().includes(normalizedSearchQuery);
  });
  const visibleRefs = reverseLoadedOrder ? [...filteredRefs].reverse() : filteredRefs;
  const availableLinkUrls = visibleRefs
    .filter((ref) => safeRepositoryUrl(ref.url))
    .map((ref) => ref.url);
  const availableReferences = visibleRefs.filter((ref) => safeRepositoryUrl(ref.url));
  const showVisibleKindSummary = !isLoading && !isError && !isFetching && refs !== undefined;
  const visibleBatchKey = JSON.stringify([
    taskId,
    selectedKind,
    searchQuery,
    availableLinksOnly,
    unavailableLinksOnly,
    reverseLoadedOrder,
    (refs ?? []).map((ref) => [ref.id, ref.type, ref.ref, ref.url]),
  ]);
  const availableReferencesKey = JSON.stringify([
    taskId,
    selectedKind,
    searchQuery,
    availableLinksOnly,
    unavailableLinksOnly,
    reverseLoadedOrder,
    dataUpdatedAt,
    availableReferences.map((ref) => [ref.id, ref.type, ref.ref, ref.url]),
  ]);

  return (
    <div className="rounded-lg border p-4">
      <h4 className="mb-3 text-sm font-medium">Git References</h4>
      {isLoading || (isError && isFetching) ? (
        <p className="text-sm text-muted-foreground">Loading Git references…</p>
      ) : isError ? (
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
      ) : refs === undefined ? (
        <p className="text-sm text-muted-foreground">Git references have not been loaded.</p>
      ) : refs.length === 0 ? (
        <>
          <p className="text-sm text-muted-foreground">No Git references.</p>
          {showVisibleKindSummary && <VisibleGitReferenceKindSummary refs={visibleRefs} />}
          <div className="mt-3">
            <CopyAvailableGitReferenceValues key={availableReferencesKey} refs={availableReferences} />
            <CopyAvailableGitReferenceLinks key={visibleBatchKey} urls={availableLinkUrls} />
          </div>
        </>
      ) : (
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
              aria-describedby={`${searchInputId}-help`}
              aria-keyshortcuts="Escape"
              className="min-w-0 rounded border bg-background px-2 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
            <span id={`${searchInputId}-help`} className="text-xs text-muted-foreground">
              Press Escape to clear search.
            </span>
            <label htmlFor={`${kindSelectId}-available-only`} className="inline-flex items-center gap-2 text-sm">
              <input
                id={`${kindSelectId}-available-only`}
                type="checkbox"
                checked={availableLinksOnly}
                onChange={(event) => {
                  setAvailableLinksOnly(event.target.checked);
                  if (event.target.checked) setUnavailableLinksOnly(false);
                }}
              />
              Show available links only
            </label>
            <label htmlFor={`${kindSelectId}-unavailable-only`} className="inline-flex items-center gap-2 text-sm">
              <input
                id={`${kindSelectId}-unavailable-only`}
                type="checkbox"
                checked={unavailableLinksOnly}
                onChange={(event) => {
                  setUnavailableLinksOnly(event.target.checked);
                  if (event.target.checked) setAvailableLinksOnly(false);
                }}
              />
              Show unavailable links only
            </label>
            <label htmlFor={`${kindSelectId}-reverse-loaded-order`} className="inline-flex items-center gap-2 text-sm">
              <input
                id={`${kindSelectId}-reverse-loaded-order`}
                type="checkbox"
                checked={reverseLoadedOrder}
                onChange={(event) => setReverseLoadedOrder(event.target.checked)}
              />
              Reverse loaded order
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
              disabled={selectedKind === 'all' && searchQuery === '' && !availableLinksOnly && !unavailableLinksOnly}
              onClick={() => {
                setSelectedKind('all');
                setSearchQuery('');
                setAvailableLinksOnly(false);
                setUnavailableLinksOnly(false);
              }}
            >
              Reset Git reference filters
            </Button>
            <label htmlFor={`${kindSelectId}-wrap`} className="inline-flex items-center gap-2 text-sm">
              <input
                id={`${kindSelectId}-wrap`}
                type="checkbox"
                checked={wrapReferenceText}
                onChange={(event) => setWrapReferenceText(event.target.checked)}
              />
              Wrap Git reference text
            </label>
            <CopyAvailableGitReferenceLinks key={visibleBatchKey} urls={availableLinkUrls} />
            <CopyAvailableGitReferenceValues key={availableReferencesKey} refs={availableReferences} />
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            Showing {visibleRefs.length} of {refs.length} loaded Git references.
          </p>
          {showVisibleKindSummary && <VisibleGitReferenceKindSummary refs={visibleRefs} />}
          {visibleRefs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No matching Git references in the loaded list.{' '}
              {searchQuery !== ''
                ? 'Clear search or choose All references to show more.'
                : 'Choose All references to show more.'}
              {availableLinksOnly && ' Turn off Show available links only to include unavailable references.'}
              {unavailableLinksOnly && ' Turn off Show unavailable links only to include available references.'}
            </p>
          ) : (
            <ul className="space-y-2">
              {visibleRefs.map((ref) => {
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
                      <span className={wrapReferenceText
                        ? 'min-w-0 flex-1 whitespace-normal break-all font-mono text-xs'
                        : 'truncate font-mono text-xs'}>{referenceText}</span>
                      <ExternalLink className="h-3 w-3 flex-shrink-0 opacity-50" />
                    </a>
                    <CopyGitReference
                      key={`${taskId}:${ref.id}:${referenceText}`}
                      value={referenceText}
                      label={referenceLabel}
                    />
                    {typeof ref.ref === 'string' && ref.ref.trim() !== '' && ref.ref !== ref.url && (
                      <CopyGitReferenceLink
                        key={JSON.stringify([taskId, ref.id, ref.ref, ref.url])}
                        reference={ref.ref}
                        url={ref.url}
                        label={referenceLabel}
                      />
                    )}
                    <GitReferenceDestinationDisclosure
                      taskId={taskId}
                      edgeId={ref.id}
                      url={ref.url}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
