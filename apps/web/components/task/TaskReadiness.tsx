'use client';

import { useState } from 'react';
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

export function TaskReadiness({ taskId }: TaskReadinessProps) {
  const { data, isLoading, isError, isFetching, refetch } = useTaskReadiness(taskId);

  let content;
  if (!taskId || isError) {
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
    content = (
      <>
        <p className="text-sm text-muted-foreground">
          {data.blockedBy.length} of {data.dependencyCount} dependency links are blocking this task.
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          {data.blockedBy.map((edge) => {
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
