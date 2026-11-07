'use client';

import { useId, useState } from 'react';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useTaskReadiness } from '@/lib/api/tasks';
import { getTaskStatusLabel } from '@/lib/task-status-labels';

interface TaskReadinessProps {
  taskId: string;
}

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

function blockerSearchText(edge: {
  otherTaskId: string;
  otherTaskTitle?: string | null;
  otherTaskTitleWithheld?: true;
  otherTaskStatus?: string | null;
}): string {
  const title = edge.otherTaskTitleWithheld === true ? null : edge.otherTaskTitle;
  const status = getTaskStatusLabel(edge.otherTaskStatus ?? '') ?? edge.otherTaskStatus ?? '';
  return [title || '', edge.otherTaskId, status].join('\n').toLowerCase();
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
  const searchInputId = useId();
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
    const visibleBlockers = normalizedSearchQuery
      ? loadedBlockers.filter((edge) => blockerSearchText(edge).includes(normalizedSearchQuery))
      : loadedBlockers;

    content = (
      <>
        <p className="text-sm text-muted-foreground">
          {data.blockedBy.length} of {data.dependencyCount} dependency links are blocking this task.
        </p>
        {loadedBlockers.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label htmlFor={searchInputId} className="text-sm">
              Search loaded blockers
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
              placeholder="Title, task ID, or status"
              className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
            <span id={`${searchInputId}-help`} className="basis-full text-xs text-muted-foreground">
              Filters the already-loaded readiness blockers locally. Press Escape to clear search.
            </span>
            {searchQuery !== '' && (
              <button
                type="button"
                className="rounded text-sm text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                onClick={() => setSearchQuery('')}
              >
                Clear search
              </button>
            )}
            <p className="basis-full text-xs text-muted-foreground">
              Showing {visibleBlockers.length} of {loadedBlockers.length} loaded readiness blockers.
            </p>
          </div>
        )}
        {visibleBlockers.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {loadedBlockers.length === 0
              ? 'No loaded readiness blockers.'
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
