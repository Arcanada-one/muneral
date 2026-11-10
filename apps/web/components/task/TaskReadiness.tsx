'use client';

import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useTaskReadiness } from '@/lib/api/tasks';
import { getTaskStatusLabel } from '@/lib/task-status-labels';

interface TaskReadinessProps {
  taskId: string;
}

type BlockerStatusFilter = 'all' | 'todo' | 'in_progress' | 'review' | 'blocked';

function CopyBlockerTaskIdButton({ blockerTaskId }: { blockerTaskId: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [isCopying, setIsCopying] = useState(false);

  const copyBlockerTaskId = async () => {
    if (isCopying) return;
    setCopyState('idle');
    setIsCopying(true);

    try {
      await navigator.clipboard.writeText(blockerTaskId);
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
        onClick={copyBlockerTaskId}
        disabled={isCopying}
        aria-label={`Copy blocker task ID ${blockerTaskId}`}
      >
        <Copy className="h-3 w-3" />
      </Button>
      {copyState === 'copied' && (
        <span role="status" className="text-xs text-green-700">Blocker task ID copied.</span>
      )}
      {copyState === 'failed' && (
        <span role="alert" className="text-xs text-destructive">Could not copy blocker task ID. Try copying it manually.</span>
      )}
    </>
  );
}

function CopyLoadedBlockerIdsButton({
  blockerTaskIds,
}: {
  blockerTaskIds: string[];
}) {
  const isCopyPending = useRef(false);
  const [isCopying, setIsCopying] = useState(false);
  const [copyResult, setCopyResult] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copyLoadedBlockerIds = async () => {
    if (isCopyPending.current) return;

    isCopyPending.current = true;
    setIsCopying(true);
    setCopyResult('idle');

    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      isCopyPending.current = false;
      setIsCopying(false);
      setCopyResult('failed');
      return;
    }

    try {
      await clipboard.writeText(blockerTaskIds.join('\n'));
      setCopyResult('copied');
    } catch {
      setCopyResult('failed');
    } finally {
      isCopyPending.current = false;
      setIsCopying(false);
    }
  };

  return (
    <div className="mt-2">
      <Button type="button" variant="outline" size="sm" onClick={copyLoadedBlockerIds} disabled={isCopying}>
        Copy loaded blocker IDs
      </Button>
      {copyResult === 'copied' && (
        <span role="status" className="ml-2 text-xs text-green-700">Blocker IDs copied.</span>
      )}
      {copyResult === 'failed' && (
        <span role="alert" className="ml-2 text-xs text-destructive">
          Could not copy blocker IDs. Try copying them manually.
        </span>
      )}
    </div>
  );
}

function CopyVisibleLoadedBlockerIdsButton({
  blockerTaskIds,
  selectionKey,
}: {
  blockerTaskIds: string[];
  selectionKey: string;
}) {
  const isCopyPending = useRef(false);
  const selectionKeyRef = useRef(selectionKey);
  useLayoutEffect(() => {
    selectionKeyRef.current = selectionKey;
  }, [selectionKey]);
  const [isCopying, setIsCopying] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<{
    selectionKey: string;
    result: 'idle' | 'copied' | 'failed';
  }>({ selectionKey, result: 'idle' });
  const copyResult = copyFeedback.selectionKey === selectionKey ? copyFeedback.result : 'idle';

  const copyVisibleLoadedBlockerIds = async () => {
    if (isCopyPending.current || blockerTaskIds.length === 0) return;

    const requestedSelectionKey = selectionKey;
    isCopyPending.current = true;
    setIsCopying(true);
    setCopyFeedback({ selectionKey: requestedSelectionKey, result: 'idle' });

    try {
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== 'function') {
        throw new Error('Clipboard unavailable');
      }

      await clipboard.writeText(blockerTaskIds.join('\n'));
      if (selectionKeyRef.current === requestedSelectionKey) {
        setCopyFeedback({ selectionKey: requestedSelectionKey, result: 'copied' });
      }
    } catch {
      if (selectionKeyRef.current === requestedSelectionKey) {
        setCopyFeedback({ selectionKey: requestedSelectionKey, result: 'failed' });
      }
    } finally {
      isCopyPending.current = false;
      setIsCopying(false);
    }
  };

  return (
    <div className="mt-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={copyVisibleLoadedBlockerIds}
        disabled={blockerTaskIds.length === 0 || isCopying}
      >
        Copy visible loaded blocker IDs ({blockerTaskIds.length})
      </Button>
      {copyResult === 'copied' && (
        <span role="status" className="ml-2 text-xs text-green-700">Visible blocker IDs copied.</span>
      )}
      {copyResult === 'failed' && (
        <span role="alert" className="ml-2 text-xs text-destructive">
          Could not copy visible blocker IDs. Try copying them manually.
        </span>
      )}
    </div>
  );
}

function blockerSearchText(edge: {
  otherTaskId: string;
  otherTaskTitle?: string | null;
  otherTaskTitleWithheld?: true;
}): string {
  const parts = [edge.otherTaskId];
  if (edge.otherTaskTitleWithheld !== true && edge.otherTaskTitle) {
    parts.push(edge.otherTaskTitle);
  }
  return parts.join('\n').toLowerCase();
}

export function TaskReadiness({ taskId }: TaskReadinessProps) {
  const readiness = useTaskReadiness(taskId);
  return <TaskReadinessPanel key={taskId} taskId={taskId} readiness={readiness} />;
}

function TaskReadinessPanel({
  taskId,
  readiness,
}: {
  taskId: string;
  readiness: ReturnType<typeof useTaskReadiness>;
}) {
  const { data, isLoading, isError, isFetching, refetch } = readiness;
  const [searchQuery, setSearchQuery] = useState('');
  const [blockerStatusFilter, setBlockerStatusFilter] = useState<BlockerStatusFilter>('all');
  const [blockersExpanded, setBlockersExpanded] = useState(true);
  const [reverseBlockerOrder, setReverseBlockerOrder] = useState(false);
  const [visibleCopyRevision, setVisibleCopyRevision] = useState(0);
  const searchInputId = useId();
  const statusFilterId = useId();
  const reverseOrderId = useId();
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();

  let content;
  if (!taskId) {
    content = <p className="text-sm text-muted-foreground">Dependency readiness is unavailable.</p>;
  } else if (isError && isFetching) {
    content = <p className="text-sm text-muted-foreground">Dependency readiness is unknown while it loads.</p>;
  } else if (isError) {
    content = <p className="text-sm text-muted-foreground">Dependency readiness is unavailable.</p>;
  } else if (isLoading || !data) {
    content = <p className="text-sm text-muted-foreground">Dependency readiness is unknown while it loads.</p>;
  } else if (data.ready && data.dependencyCount === 0) {
    content = <p className="text-sm text-muted-foreground">Ready: no dependency links.</p>;
  } else if (data.ready) {
    content = <p className="text-sm text-muted-foreground">
      Ready: no blocking dependencies among {data.dependencyCount} dependency links.
    </p>;
  } else {
    const loadedBlockers = data.blockedBy;
    const loadedBlockerIds = Array.from(new Set(loadedBlockers.map((edge) => edge.otherTaskId)));
    const filteredBlockers = loadedBlockers.filter((edge) => {
      if (blockerStatusFilter !== 'all' && edge.otherTaskStatus !== blockerStatusFilter) {
        return false;
      }
      if (!normalizedSearchQuery) {
        return true;
      }
      return blockerSearchText(edge).includes(normalizedSearchQuery);
    });
    const blockerStatusCounts = filteredBlockers.reduce(
      (counts, edge) => {
        switch (edge.otherTaskStatus) {
          case 'todo':
            counts.todo += 1;
            break;
          case 'in_progress':
            counts.inProgress += 1;
            break;
          case 'review':
            counts.review += 1;
            break;
          case 'blocked':
            counts.blocked += 1;
            break;
          default:
            counts.other += 1;
        }
        return counts;
      },
      { todo: 0, inProgress: 0, review: 0, blocked: 0, other: 0 },
    )
    const visibleBlockers = reverseBlockerOrder
      ? [...filteredBlockers].reverse()
      : filteredBlockers;
    const visibleBlockerIds = visibleBlockers.map((edge) => edge.otherTaskId);
    const visibleCopySelectionKey = JSON.stringify([
      taskId,
      visibleCopyRevision,
      reverseBlockerOrder,
      searchQuery,
      blockerStatusFilter,
      visibleBlockerIds,
    ]);
    const filtersActive = normalizedSearchQuery !== '' || blockerStatusFilter !== 'all';

    content = (
      <>
        <p className="text-sm text-muted-foreground">
          {data.blockedBy.length} of {data.dependencyCount} dependency links are blocking this task.
        </p>
        <div role="group" aria-label="Filtered blocker statuses" className="mt-2 text-sm text-muted-foreground">
          <p>Counts of filtered loaded blocker edges:</p>
          <ul className="flex flex-wrap gap-x-3" aria-label="Filtered blocker status counts">
            <li>To Do {blockerStatusCounts.todo}</li>
            <li>In Progress {blockerStatusCounts.inProgress}</li>
            <li>Review {blockerStatusCounts.review}</li>
            <li>Blocked {blockerStatusCounts.blocked}</li>
            {blockerStatusCounts.other > 0 && <li>Other {blockerStatusCounts.other}</li>}
          </ul>
        </div>
        {loadedBlockers.length > 0 && (
          <>
            <button
              type="button"
              aria-controls={`task-readiness-${taskId}-blockers`}
              aria-expanded={blockersExpanded}
              className="mt-2 rounded text-sm text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              onClick={() => setBlockersExpanded((expanded) => !expanded)}
            >
              {blockersExpanded ? 'Hide blocking tasks' : 'Show blocking tasks'}
            </button>
            <CopyLoadedBlockerIdsButton
              key={JSON.stringify([taskId, loadedBlockerIds])}
              blockerTaskIds={loadedBlockerIds}
            />
            <CopyVisibleLoadedBlockerIdsButton
              blockerTaskIds={visibleBlockerIds}
              selectionKey={visibleCopySelectionKey}
            />
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <label htmlFor={statusFilterId} className="text-sm">
                  Blocker status
                </label>
                <select
                  id={statusFilterId}
                  value={blockerStatusFilter}
                  onChange={(event) => {
                    setBlockerStatusFilter(event.target.value as BlockerStatusFilter);
                    setVisibleCopyRevision((revision) => revision + 1);
                  }}
                  className="rounded border bg-background px-2 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <option value="all">All blocker statuses</option>
                  <option value="todo">To Do</option>
                  <option value="in_progress">In Progress</option>
                  <option value="review">Review</option>
                  <option value="blocked">Blocked</option>
                </select>
              </div>
              <label htmlFor={searchInputId} className="text-sm">
                Search loaded blockers
              </label>
              <input
                id={searchInputId}
                type="search"
                value={searchQuery}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  setVisibleCopyRevision((revision) => revision + 1);
                }}
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
                  setVisibleCopyRevision((revision) => revision + 1);
                }}
                aria-describedby={`${searchInputId}-help`}
                aria-keyshortcuts="Escape"
                placeholder="Title or task ID"
                className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
              <span id={`${searchInputId}-help`} className="basis-full text-xs text-muted-foreground">
                Filters the already-loaded readiness blockers locally. Press Escape to clear search.
              </span>
              {searchQuery !== '' && (
                <button
                  type="button"
                  aria-label="Clear search"
                  className="rounded text-sm text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  onClick={() => {
                    setSearchQuery('');
                    setVisibleCopyRevision((revision) => revision + 1);
                  }}
                >
                  Clear search
                </button>
              )}
              <label htmlFor={reverseOrderId} className="flex items-center gap-2 text-sm text-foreground">
                <input
                  id={reverseOrderId}
                  type="checkbox"
                  checked={reverseBlockerOrder}
                  onChange={(event) => {
                    setReverseBlockerOrder(event.target.checked);
                    setVisibleCopyRevision((revision) => revision + 1);
                  }}
                  className="h-4 w-4 rounded border-input text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                />
                Reverse loaded blocker order
              </label>
              <p className="basis-full text-xs text-muted-foreground">
                Showing {visibleBlockers.length} of {loadedBlockers.length} loaded blocking dependencies.
              </p>
            </div>
          </>
        )}
        <div id={`task-readiness-${taskId}-blockers`} hidden={!blockersExpanded}>
          {visibleBlockers.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {loadedBlockers.length === 0
                ? 'No loaded readiness blockers.'
                : filtersActive
                  ? 'No loaded blocking dependencies match the selected filters. Choose All blocker statuses or clear search to broaden the loaded results.'
                  : 'No matching readiness blockers in the loaded list. Clear search to show more.'}
            </p>
          ) : (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              {visibleBlockers.map((edge) => {
                const title = edge.otherTaskTitleWithheld === true ? null : edge.otherTaskTitle;
                const status = getTaskStatusLabel(edge.otherTaskStatus);
                return (
                  <li key={`${taskId}:${edge.id}:${edge.otherTaskId}`} className="break-words">
                    {title || edge.otherTaskId}
                    {status ? <Badge className="ml-2" variant="secondary">{status}</Badge> : null}
                    <CopyBlockerTaskIdButton
                      blockerTaskId={edge.otherTaskId}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </>
    );
  }

  return (
    <section aria-labelledby={`task-readiness-${taskId}`} className="rounded-lg border p-4" aria-live="polite">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h4 id={`task-readiness-${taskId}`} className="text-sm font-medium">Dependency readiness</h4>
        {data && !isError && <Badge variant={data.ready ? 'success' : 'destructive'}>
          {data.ready ? 'Ready (dependencies)' : 'Blocked'}
        </Badge>}
      </div>
      {content}
      {taskId && isError && (
        <button
          type="button"
          aria-label="Retry dependency readiness"
          className="mt-2 rounded text-sm text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isFetching}
          onClick={() => { void refetch(); }}
        >
          Retry
        </button>
      )}
    </section>
  );
}
