'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, Copy, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useDependencyGraph } from '@/lib/api/tasks';
import { getTaskStatusLabel } from '@/lib/task-status-labels';

interface TaskDependenciesProps {
  taskId: string;
}

const typeLabels: Record<string, { incoming: string; outgoing: string; className: string }> = {
  depends_on: { incoming: 'Required by', outgoing: 'Depends on', className: 'text-blue-600' },
  blocks: { incoming: 'Blocked by', outgoing: 'Blocks', className: 'text-red-600' },
  related_to: { incoming: 'Related to', outgoing: 'Related to', className: 'text-gray-600' },
  duplicates: { incoming: 'Duplicates', outgoing: 'Duplicates', className: 'text-amber-600' },
};

function dependencyRowIdentity(
  taskId: string,
  dependencyId: string,
  otherTaskId: string,
): string {
  return `${taskId}:${dependencyId}:${otherTaskId}`;
}


function CopyTaskIdButton({ taskId }: { taskId: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [isCopying, setIsCopying] = useState(false);

  const copyTaskId = async () => {
    setCopyState('idle');
    setIsCopying(true);

    try {
      await navigator.clipboard.writeText(taskId);
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
        onClick={copyTaskId}
        disabled={isCopying}
        aria-label={`Copy task ID ${taskId}`}
      >
        <Copy className="h-3 w-3" />
      </Button>
      {copyState === 'copied' && (
        <span role="status" className="basis-full text-xs text-green-700">Task ID copied.</span>
      )}
      {copyState === 'failed' && (
        <span role="alert" className="basis-full text-xs text-destructive">Could not copy task ID. Try copying it manually.</span>
      )}
    </>
  );
}

export function TaskDependencies({ taskId }: TaskDependenciesProps) {
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);
  const [expandedRowIds, setExpandedRowIds] = useState<ReadonlySet<string>>(() => new Set());
  const [searchState, setSearchState] = useState({ taskId, query: '' });
  const searchTaskIdRef = useRef(taskId);
  useEffect(() => {
    if (searchTaskIdRef.current === taskId) return;
    searchTaskIdRef.current = taskId;
    setSearchState({ taskId, query: '' });
  }, [taskId]);
  const searchQuery = searchState.taskId === taskId ? searchState.query : '';
  const { data: deps, isPending, isError, isFetching, refetch } = useDependencyGraph(taskId);
  const isRetrying = retryingTaskId === taskId;

  const retryDependencies = () => {
    if (isFetching || isRetrying) return;

    setRetryingTaskId(taskId);
    const finishRetry = () => setRetryingTaskId((currentTaskId) =>
      currentTaskId === taskId ? null : currentTaskId,
    );
    void refetch().then(finishRetry, finishRetry);
  };

  const toggleFullTaskId = (rowIdentity: string) => {
    setExpandedRowIds((current) => {
      const next = new Set(current);
      if (next.has(rowIdentity)) {
        next.delete(rowIdentity);
      } else {
        next.add(rowIdentity);
      }
      return next;
    });
  };

  if (isError || isRetrying) {
    return (
      <div role={isRetrying ? 'status' : 'alert'} className="rounded-lg border p-4 text-sm text-muted-foreground">
        <p>
          {isRetrying ? 'Retrying dependencies…' : 'Dependencies are unavailable.'}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={retryDependencies}
          disabled={isFetching || isRetrying}
        >
          {isRetrying ? 'Retrying dependencies…' : 'Retry dependencies'}
        </Button>
      </div>
    );
  }
  if (taskId && isPending && deps === undefined) {
    return <p role="status" className="text-sm text-muted-foreground">Loading dependencies…</p>;
  }
  if (deps === undefined) return null;
  if (deps.length === 0) {
    return (
      <div className="rounded-lg border p-4">
        <h4 className="mb-3 flex items-center gap-2 text-sm font-medium">
          <Link2 className="h-4 w-4" />
          Dependencies
        </h4>
        <p role="status" className="text-sm text-muted-foreground">No dependencies.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-4">
      <h4 className="mb-3 flex items-center gap-2 text-sm font-medium">
        <Link2 className="h-4 w-4" />
        Dependencies
      </h4>

      <DependencyList
        key={taskId}
        taskId={taskId}
        deps={deps}
        searchQuery={searchQuery}
        onSearchQueryChange={(query) => setSearchState({ taskId, query })}
        expandedRowIds={expandedRowIds}
        onToggleFullTaskId={toggleFullTaskId}
      />
    </div>
  );
}

type DependencyRow = NonNullable<ReturnType<typeof useDependencyGraph>['data']>[number];

function DependencyList({
  taskId,
  deps,
  searchQuery,
  onSearchQueryChange,
  expandedRowIds,
  onToggleFullTaskId,
}: {
  taskId: string;
  deps: DependencyRow[];
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  expandedRowIds: ReadonlySet<string>;
  onToggleFullTaskId: (rowIdentity: string) => void;
}) {
  const [direction, setDirection] = useState<'all' | 'incoming' | 'outgoing'>('all');
  const [hideCompleted, setHideCompleted] = useState(false);
  const [batchCopyFeedback, setBatchCopyFeedback] = useState<{
    generation: number;
    result: 'copied' | 'failed';
  } | null>(null);
  const [pendingBatchCopy, setPendingBatchCopy] = useState<{
    id: number;
    generation: number;
  } | null>(null);
  const [titleBatchCopyFeedback, setTitleBatchCopyFeedback] = useState<{
    generation: number;
    result: 'copied' | 'failed';
  } | null>(null);
  const [pendingTitleBatchCopy, setPendingTitleBatchCopy] = useState<{
    id: number;
    generation: number;
  } | null>(null);
  const copyAttempt = useRef(0);
  const pendingCopyRef = useRef<{ id: number; generation: number } | null>(null);
  const pendingTitleCopyRef = useRef<{ id: number; generation: number } | null>(null);

  const hideCompletedId = useId();
  const searchId = useId();
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const visibleDeps = deps.filter((dep) => {
    const matchesQuery = normalizedQuery.length === 0
      || dep.otherTaskId.toLowerCase().includes(normalizedQuery)
      || (dep.otherTaskTitleWithheld !== true
        && typeof dep.otherTaskTitle === 'string'
        && dep.otherTaskTitle.toLowerCase().includes(normalizedQuery));

    return matchesQuery
      && (direction === 'all' || dep.direction === direction)
      && (!hideCompleted || dep.otherTaskStatus !== 'done');
  });
  const eligibleTitles = visibleDeps.flatMap((dep) => {
    if (dep.otherTaskTitleWithheld === true) return [];
    const title = dep.otherTaskTitle;
    return typeof title === 'string' && title.trim().length > 0 ? [title] : [];
  });
  const titleBatchKey = JSON.stringify([
    taskId,
    direction,
    hideCompleted,
    searchQuery,
    visibleDeps.map((dep) => {
      if (dep.otherTaskTitleWithheld === true) {
        return [dep.id, dep.type, dep.direction, dep.fromTaskId, dep.toTaskId,
          dep.otherTaskId, 'withheld', dep.otherTaskStatus];
      }
      return [dep.id, dep.type, dep.direction, dep.fromTaskId, dep.toTaskId,
        dep.otherTaskId, dep.otherTaskTitle, dep.otherTaskStatus];
    }),
  ]);
  const [batchGeneration, setBatchGeneration] = useState(0);
  const copyGeneration = useRef({
    generation: 0,
    taskId,
    deps,
    direction,
    hideCompleted,
    searchQuery,
    titleBatchKey,
  });

  useEffect(() => {
    const nextGeneration = copyGeneration.current.generation + 1;
    copyGeneration.current = {
      generation: nextGeneration,
      taskId,
      deps,
      direction,
      hideCompleted,
      searchQuery,
      titleBatchKey,
    };
    setBatchGeneration(nextGeneration);
  }, [taskId, deps, direction, hideCompleted, searchQuery, titleBatchKey]);

  const invalidateCopyBatch = () => {
    const nextGeneration = copyGeneration.current.generation + 1;
    copyGeneration.current = {
      ...copyGeneration.current,
      generation: nextGeneration,
    };
    setBatchGeneration(nextGeneration);
    setBatchCopyFeedback(null);
    setPendingBatchCopy(null);
    setTitleBatchCopyFeedback(null);
    setPendingTitleBatchCopy(null);
  };

  useEffect(() => () => {
    copyGeneration.current = {
      ...copyGeneration.current,
      generation: copyGeneration.current.generation + 1,
    };
    pendingCopyRef.current = null;
    pendingTitleCopyRef.current = null;
  }, []);

  const currentGeneration = batchGeneration;
  const isBatchCopyPending = pendingBatchCopy?.generation === currentGeneration;
  const currentBatchCopyFeedback = batchCopyFeedback?.generation === currentGeneration
    ? batchCopyFeedback.result : null;
  const isTitleBatchCopyPending = pendingTitleBatchCopy?.generation === currentGeneration;
  const currentTitleBatchCopyFeedback = titleBatchCopyFeedback?.generation === currentGeneration
    ? titleBatchCopyFeedback.result : null;

  const copyVisibleTaskIds = async () => {
    const generation = copyGeneration.current.generation;
    if (visibleDeps.length === 0 || pendingCopyRef.current?.generation === generation) return;

    const attempt = { id: ++copyAttempt.current, generation };
    pendingCopyRef.current = attempt;
    setPendingBatchCopy(attempt);
    setBatchCopyFeedback(null);
    try {
      const clipboard = navigator.clipboard;
      if (typeof clipboard?.writeText !== 'function') throw new Error('Clipboard unavailable');
      await clipboard.writeText(visibleDeps.map((dep) => dep.otherTaskId).join('\n'));
      if (copyGeneration.current.generation === generation) {
        setBatchCopyFeedback({ generation, result: 'copied' });
      }
    } catch {
      if (copyGeneration.current.generation === generation) {
        setBatchCopyFeedback({ generation, result: 'failed' });
      }
    } finally {
      if (pendingCopyRef.current?.id === attempt.id) {
        pendingCopyRef.current = null;
        setPendingBatchCopy((current) => current?.id === attempt.id ? null : current);
      }
    }
  };

  const copyVisibleDependencyTitles = async () => {
    const generation = copyGeneration.current.generation;
    if (eligibleTitles.length === 0 || pendingTitleCopyRef.current?.generation === generation) return;

    const attempt = { id: ++copyAttempt.current, generation };
    pendingTitleCopyRef.current = attempt;
    setPendingTitleBatchCopy(attempt);
    setTitleBatchCopyFeedback(null);
    try {
      const clipboard = navigator.clipboard;
      if (typeof clipboard?.writeText !== 'function') throw new Error('Clipboard unavailable');
      await clipboard.writeText(eligibleTitles.join('\n'));
      if (copyGeneration.current.generation === generation) {
        setTitleBatchCopyFeedback({ generation, result: 'copied' });
      }
    } catch {
      if (copyGeneration.current.generation === generation) {
        setTitleBatchCopyFeedback({ generation, result: 'failed' });
      }
    } finally {
      if (pendingTitleCopyRef.current?.id === attempt.id) {
        pendingTitleCopyRef.current = null;
        setPendingTitleBatchCopy((current) => current?.id === attempt.id ? null : current);
      }
    }
  };

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor={`dependency-direction-${taskId}`} className="font-medium">
          Dependency direction
        </label>
        <select
          id={`dependency-direction-${taskId}`}
          value={direction}
          onChange={(event) => {
            invalidateCopyBatch();
            setDirection(event.target.value as typeof direction);
          }}
          className="rounded-md border bg-background px-2 py-1"
        >
          <option value="all">All dependencies</option>
          <option value="incoming">Incoming</option>
          <option value="outgoing">Outgoing</option>
        </select>
        <label htmlFor={hideCompletedId} className="inline-flex items-center gap-2">
          <input
            id={hideCompletedId}
            type="checkbox"
            checked={hideCompleted}
            onChange={(event) => {
              invalidateCopyBatch();
              setHideCompleted(event.target.checked);
            }}
          />
          Hide completed dependencies
        </label>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <label htmlFor={searchId} className="font-medium">Search loaded dependencies</label>
        <input
          id={searchId}
          type="text"
          value={searchQuery}
          onChange={(event) => {
            invalidateCopyBatch();
            onSearchQueryChange(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || event.nativeEvent.isComposing
                || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
                || searchQuery.length === 0) return;

            event.preventDefault();
            event.stopPropagation();
            invalidateCopyBatch();
            onSearchQueryChange('');
          }}
          aria-keyshortcuts="Escape"
          aria-describedby={`${searchId}-escape-help`}
          className="min-w-0 rounded-md border bg-background px-2 py-1"
        />
        <span id={`${searchId}-escape-help`} className="text-xs text-muted-foreground">
          Press Escape to clear search.
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            invalidateCopyBatch();
            onSearchQueryChange('');
          }}
          disabled={searchQuery.length === 0}
        >
          Clear search
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            invalidateCopyBatch();
            setDirection('all');
            setHideCompleted(false);
            onSearchQueryChange('');
          }}
          disabled={direction === 'all' && !hideCompleted && searchQuery.length === 0}
        >
          Show all loaded dependencies
        </Button>
        <span aria-live="polite" className="text-muted-foreground">
          Showing {visibleDeps.length}{normalizedQuery ? ' matching' : ''} of {deps.length} loaded dependencies.
        </span>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void copyVisibleTaskIds()}
          disabled={visibleDeps.length === 0 || isBatchCopyPending}
        >
          Copy visible dependency task IDs ({visibleDeps.length})
        </Button>
        {currentBatchCopyFeedback === 'copied' && (
          <span role="status" className="text-xs text-green-700">Dependency task IDs copied.</span>
        )}
        {currentBatchCopyFeedback === 'failed' && (
          <span role="alert" className="text-xs text-destructive">
            Could not copy dependency task IDs. Try again or copy them manually.
          </span>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void copyVisibleDependencyTitles()}
          disabled={eligibleTitles.length === 0 || isTitleBatchCopyPending}
        >
          Copy available dependency titles ({eligibleTitles.length})
        </Button>
        {currentTitleBatchCopyFeedback === 'copied' && (
          <span role="status" className="text-xs text-green-700">Dependency titles copied.</span>
        )}
        {currentTitleBatchCopyFeedback === 'failed' && (
          <span role="alert" className="text-xs text-destructive">
            Could not copy dependency titles. Try again or copy them manually.
          </span>
        )}
      </div>

      {visibleDeps.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No matching dependencies in the loaded list.{' '}
          {normalizedQuery
            ? 'Clear search or adjust the dependency filters to show more.'
            : hideCompleted
            ? 'Clear Hide completed dependencies or choose All dependencies to show more.'
            : 'Choose All dependencies to show the full list.'}
        </p>
      ) : (
        <ul className="space-y-2">
          {visibleDeps.map((dep) => (
            <DependencyRowItem
              key={dependencyRowIdentity(taskId, dep.id, dep.otherTaskId)}
              taskId={taskId}
              dep={dep}
              showFullTaskId={expandedRowIds.has(dependencyRowIdentity(taskId, dep.id, dep.otherTaskId))}
              onToggleFullTaskId={() => onToggleFullTaskId(dependencyRowIdentity(taskId, dep.id, dep.otherTaskId))}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function DependencyRowItem({
  taskId,
  dep,
  showFullTaskId,
  onToggleFullTaskId,
}: {
  taskId: string;
  dep: DependencyRow;
  showFullTaskId: boolean;
  onToggleFullTaskId: () => void;
}) {
  const config = typeLabels[dep.type];
  const label = config?.[dep.direction] ?? dep.type;
  const statusLabel = getTaskStatusLabel(dep.otherTaskStatus);
  const counterpartTitle = dep.otherTaskTitleWithheld === true ? null : dep.otherTaskTitle;
  const rowIdentity = dependencyRowIdentity(taskId, dep.id, dep.otherTaskId);
  const taskIdTextId = `dependency-task-id-${dep.id}`;

  return (
    <li className="flex flex-wrap items-center gap-2 text-sm">
      <span className={(config?.className ?? 'text-gray-600') + ' text-xs font-medium min-w-[80px]'}>
        {label}
      </span>
      <ArrowRight className="h-3 w-3 text-muted-foreground" />
      {counterpartTitle !== null && (
        <span className="min-w-0 break-words font-medium">{counterpartTitle}</span>
      )}
      <code
        id={taskIdTextId}
        className={
          showFullTaskId
            ? 'min-w-0 max-w-full break-all rounded bg-muted px-1.5 py-0.5 text-xs font-mono'
            : 'rounded bg-muted px-1.5 py-0.5 text-xs font-mono'
        }
      >
        {showFullTaskId ? dep.otherTaskId : dep.otherTaskId.slice(0, 8)}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-2 text-xs"
        aria-expanded={showFullTaskId}
        aria-controls={taskIdTextId}
        onClick={onToggleFullTaskId}
      >
        {showFullTaskId ? 'Hide full task ID' : 'Show full task ID'}
      </Button>
      {statusLabel && <Badge variant="secondary">{statusLabel}</Badge>}
      <CopyTaskIdButton key={rowIdentity} taskId={dep.otherTaskId} />
    </li>
  );
}
