'use client';

import { useLayoutEffect, useRef, useState } from 'react';
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

function CopyVisibleBlockerIdsButton({
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

  const copyVisibleBlockerIds = async () => {
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
        onClick={copyVisibleBlockerIds}
        disabled={isCopying || blockerTaskIds.length === 0}
      >
        Copy visible blocker IDs ({blockerTaskIds.length})
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
  const [blockersExpanded, setBlockersExpanded] = useState(true);
  const [blockerSearch, setBlockerSearch] = useState('');
  const [blockerStatusFilter, setBlockerStatusFilter] = useState<BlockerStatusFilter>('all');
  const [reverseBlockerOrder, setReverseBlockerOrder] = useState(false);
  const [visibleCopyRevision, setVisibleCopyRevision] = useState(0);

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
    const loadedBlockerIds = Array.from(new Set(data.blockedBy.map((edge) => edge.otherTaskId)));
    const normalizedBlockerSearch = blockerSearch.trim().toLowerCase();
    const filteredBlockers = data.blockedBy.filter((edge) => {
      if (blockerStatusFilter !== 'all' && edge.otherTaskStatus !== blockerStatusFilter) return false;

      if (!normalizedBlockerSearch || edge.otherTaskId.toLowerCase().includes(normalizedBlockerSearch)) {
        return true;
      }

      if (edge.otherTaskTitleWithheld === true) return false;
      return (edge.otherTaskTitle ?? '').toLowerCase().includes(normalizedBlockerSearch);
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
    );
    const visibleBlockers = reverseBlockerOrder ? [...filteredBlockers].reverse() : filteredBlockers;
    const visibleBlockerIds = Array.from(new Set(visibleBlockers.map((edge) => edge.otherTaskId)));
    const blockerSearchId = `task-readiness-${taskId}-blocker-search`;
    const blockerStatusFilterId = `task-readiness-${taskId}-blocker-status`;
    const blockerOrderId = `task-readiness-${taskId}-reverse-blocker-order`;
    const visibleCopySelectionKey = JSON.stringify([
      taskId,
      visibleCopyRevision,
      reverseBlockerOrder,
      blockerStatusFilter,
      blockerSearch,
      visibleBlockerIds,
    ]);

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
        {data.blockedBy.length > 0 && (
          <>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <label htmlFor={blockerStatusFilterId} className="text-xs text-muted-foreground">
                  Blocker status
                </label>
                <select
                  id={blockerStatusFilterId}
                  value={blockerStatusFilter}
                  onChange={(event) => {
                    setBlockerStatusFilter(event.target.value as BlockerStatusFilter);
                    setVisibleCopyRevision((revision) => revision + 1);
                  }}
                  className="rounded-md border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <option value="all">All blocker statuses</option>
                  <option value="todo">To Do</option>
                  <option value="in_progress">In Progress</option>
                  <option value="review">Review</option>
                  <option value="blocked">Blocked</option>
                </select>
              </div>
              <label htmlFor={blockerSearchId} className="sr-only">
                Search loaded blockers
              </label>
              <input
                id={blockerSearchId}
                type="search"
                value={blockerSearch}
                onChange={(event) => {
                  setBlockerSearch(event.target.value);
                  setVisibleCopyRevision((revision) => revision + 1);
                }}
                onKeyDown={(event) => {
                  if (
                    event.key !== 'Escape' ||
                    !blockerSearch ||
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
                  setBlockerSearch('');
                  setVisibleCopyRevision((revision) => revision + 1);
                }}
                placeholder="Search loaded blockers"
                aria-describedby={`${blockerSearchId}-help`}
                aria-keyshortcuts="Escape"
                className="min-w-0 rounded-md border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              />
              <button
                type="button"
                className="rounded text-sm text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                onClick={() => {
                  setBlockerSearch('');
                  setVisibleCopyRevision((revision) => revision + 1);
                }}
              >
                Clear search
              </button>
              <label htmlFor={blockerOrderId} className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  id={blockerOrderId}
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
            </div>
            <p id={`${blockerSearchId}-help`} className="mt-1 text-xs text-muted-foreground">
              Press Escape to clear search.
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Showing {visibleBlockers.length} of {data.blockedBy.length} loaded blocking dependencies.
            </p>
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
            <CopyVisibleBlockerIdsButton
              key={visibleCopySelectionKey}
              blockerTaskIds={visibleBlockerIds}
              selectionKey={visibleCopySelectionKey}
            />
          </>
        )}
        <ul
          id={`task-readiness-${taskId}-blockers`}
          aria-label="Loaded blocking dependencies"
          hidden={!blockersExpanded}
          className="mt-2 list-disc space-y-1 pl-5 text-sm"
        >
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
        {visibleBlockers.length === 0 && (normalizedBlockerSearch || blockerStatusFilter !== 'all') && (
          <p className="mt-2 text-sm text-muted-foreground">
            No loaded blocking dependencies match the selected filters. Choose All blocker statuses or clear search to broaden the loaded results.
          </p>
        )}
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
