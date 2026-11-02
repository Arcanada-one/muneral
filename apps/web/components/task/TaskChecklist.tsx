'use client';

import { useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useChecklist, useToggleChecklistItem } from '@/lib/api/tasks';
import { cn } from '@/lib/utils';

interface TaskChecklistProps {
  taskId: string;
}

export function TaskChecklist({ taskId }: TaskChecklistProps) {
  const [expanded, setExpanded] = useState(true);
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);
  const pendingToggleKeysRef = useRef(new Set<string>());
  const [pendingToggleKeys, setPendingToggleKeys] = useState<Set<string>>(new Set());
  const { data, isPending, isError, isFetching, refetch } = useChecklist(taskId);
  const items = data ?? [];
  const toggle = useToggleChecklistItem();

  const completed = items.filter((i) => i.checked).length;
  const total = items.length;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
  const toggleFailedForTask = toggle.isError && toggle.variables?.taskId === taskId;
  const isRetrying = retryingTaskId === taskId;

  const toggleChecklistItem = (itemId: string, checked: boolean) => {
    const key = `${taskId}:${itemId}`;
    if (pendingToggleKeysRef.current.has(key)) return;

    pendingToggleKeysRef.current.add(key);
    setPendingToggleKeys(new Set(pendingToggleKeysRef.current));

    const releasePending = () => {
      if (!pendingToggleKeysRef.current.delete(key)) return;
      setPendingToggleKeys(new Set(pendingToggleKeysRef.current));
    };

    void toggle.mutateAsync({ taskId, itemId, checked }).then(
      releasePending,
      releasePending,
    );
  };

  const retryChecklist = () => {
    if (isFetching || isRetrying) return;

    setRetryingTaskId(taskId);
    const finishRetry = () => setRetryingTaskId((currentTaskId) =>
      currentTaskId === taskId ? null : currentTaskId,
    );
    void refetch().then(finishRetry, finishRetry);
  };

  if (isError || isRetrying) {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        {isRetrying ? (
          <p role="status">Retrying checklist…</p>
        ) : (
          <p role="alert">Checklist is unavailable. Try again later.</p>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={retryChecklist}
          disabled={isFetching || isRetrying}
        >
          {isRetrying ? 'Retrying checklist…' : 'Retry checklist'}
        </Button>
      </div>
    );
  }

  if (taskId && data === undefined && isPending) {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        <p role="status">Loading checklist…</p>
      </div>
    );
  }

  if (total === 0) return null;

  return (
    <div className="rounded-lg border p-4">
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between text-sm font-medium"
      >
        <span className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          Checklist
        </span>
        <span className="text-xs text-muted-foreground">
          {completed}/{total} ({percentage}%)
        </span>
      </button>

      {/* Progress bar */}
      <div className="mt-2 h-1.5 w-full rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${percentage}%` }}
        />
      </div>

      {expanded && (
        <ul className="mt-3 space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-center gap-2"
              aria-busy={pendingToggleKeys.has(`${taskId}:${item.id}`)}
            >
              <input
                type="checkbox"
                id={`checklist-${item.id}`}
                checked={item.checked}
                disabled={pendingToggleKeys.has(`${taskId}:${item.id}`)}
                onChange={(e) => toggleChecklistItem(item.id, e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
              />
              <label
                htmlFor={`checklist-${item.id}`}
                className={cn(
                  'text-sm cursor-pointer',
                  item.checked && 'line-through text-muted-foreground',
                )}
              >
                {item.label}
              </label>
            </li>
          ))}
        </ul>
      )}

      {toggleFailedForTask && (
        <p role="alert" className="mt-3 rounded-lg border p-3 text-sm text-destructive">
          Unable to update checklist. Please try again.
        </p>
      )}
    </div>
  );
}
