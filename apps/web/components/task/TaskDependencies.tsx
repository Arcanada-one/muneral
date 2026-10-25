'use client';

import { useState } from 'react';
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
  const { data: deps = [], isLoading, isError, isFetching, refetch } = useDependencyGraph(taskId);
  const isRetrying = retryingTaskId === taskId;

  const retryDependencies = () => {
    if (isFetching || isRetrying) return;

    setRetryingTaskId(taskId);
    const finishRetry = () => setRetryingTaskId((currentTaskId) =>
      currentTaskId === taskId ? null : currentTaskId,
    );
    void refetch().then(finishRetry, finishRetry);
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
  if (isLoading) return null;
  if (deps.length === 0) return null;

  return (
    <div className="rounded-lg border p-4">
      <h4 className="mb-3 flex items-center gap-2 text-sm font-medium">
        <Link2 className="h-4 w-4" />
        Dependencies
      </h4>

      <ul className="space-y-2">
        {deps.map((dep) => {
          const config = typeLabels[dep.type];
          const label = config?.[dep.direction] ?? dep.type;
          const statusLabel = getTaskStatusLabel(dep.otherTaskStatus);
          const counterpartTitle = dep.otherTaskTitleWithheld === true ? null : dep.otherTaskTitle;

          return (
            <li key={dep.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className={(config?.className ?? 'text-gray-600') + ' text-xs font-medium min-w-[80px]'}>
                {label}
              </span>
              <ArrowRight className="h-3 w-3 text-muted-foreground" />
              {counterpartTitle !== null && (
                <span className="min-w-0 break-words font-medium">{counterpartTitle}</span>
              )}
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                {dep.otherTaskId.slice(0, 8)}
              </code>
              {statusLabel && <Badge variant="secondary">{statusLabel}</Badge>}
              <CopyTaskIdButton key={`${taskId}:${dep.id}:${dep.otherTaskId}`} taskId={dep.otherTaskId} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
