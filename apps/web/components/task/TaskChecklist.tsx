'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useChecklist, useToggleChecklistItem, type ChecklistItem } from '@/lib/api/tasks';
import { cn } from '@/lib/utils';

interface TaskChecklistProps {
  taskId: string;
}

interface ChecklistItemsProps {
  taskId: string;
  items: ChecklistItem[];
  expanded: boolean;
  hideCompleted: boolean;
  searchQuery: string;
  pendingToggleKeys: Set<string>;
  onToggle: (itemId: string, checked: boolean) => void;
  onHideCompletedChange: (hideCompleted: boolean) => void;
  onSearchQueryChange: (searchQuery: string) => void;
}

function ChecklistItems({
  taskId,
  items,
  expanded,
  hideCompleted,
  searchQuery,
  pendingToggleKeys,
  onToggle,
  onHideCompletedChange,
  onSearchQueryChange,
}: ChecklistItemsProps) {
  if (!expanded) return null;

  const eligibleItems = hideCompleted ? items.filter((item) => !item.checked) : items;
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const visibleItems = eligibleItems.filter((item) =>
    item.label.toLowerCase().includes(normalizedSearchQuery),
  );
  const hasSearch = normalizedSearchQuery.length > 0;
  const searchId = `task-checklist-search-${taskId}`;

  return (
    <div className="mt-3 space-y-3">
      <div className="space-y-2">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <label htmlFor={searchId} className="text-sm font-medium">
              Search loaded checklist items
            </label>
            <input
              id={searchId}
              type="search"
              value={searchQuery}
              onChange={(event) => onSearchQueryChange(event.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onSearchQueryChange('')}
            disabled={searchQuery.length === 0}
          >
            Clear search
          </Button>
        </div>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          Showing {visibleItems.length} of {items.length} loaded checklist items.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={hideCompleted}
            onClick={() => onHideCompletedChange(!hideCompleted)}
          >
            Hide completed items
          </Button>
          {hideCompleted && (
            <Button type="button" variant="outline" size="sm" onClick={() => onHideCompletedChange(false)}>
              Show all items
            </Button>
          )}
        </div>
      </div>

      {visibleItems.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {hasSearch
            ? hideCompleted
              ? 'No incomplete loaded checklist items match this search. Clear search or show all items.'
              : 'No loaded checklist items match this search. Clear search to show the loaded items.'
            : 'No incomplete items in this loaded checklist.'}
        </p>
      ) : (
        <ul className="space-y-2">
          {visibleItems.map((item) => (
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
                onChange={(e) => onToggle(item.id, e.target.checked)}
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
    </div>
  );
}

export function TaskChecklist({ taskId }: TaskChecklistProps) {
  const [expanded, setExpanded] = useState(true);
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);
  const [filterState, setFilterState] = useState({ taskId, hideCompleted: false, searchQuery: '' });
  const filterTaskIdRef = useRef(taskId);
  const pendingToggleKeysRef = useRef(new Set<string>());
  const [pendingToggleKeys, setPendingToggleKeys] = useState<Set<string>>(new Set());
  const { data, isPending, isError, isFetching, refetch } = useChecklist(taskId);
  const hideCompleted = filterState.taskId === taskId && filterState.hideCompleted;
  const searchQuery = filterState.taskId === taskId ? filterState.searchQuery : '';
  const items = data ?? [];
  const toggle = useToggleChecklistItem();

  const completed = items.filter((i) => i.checked).length;
  const total = items.length;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;
  const toggleFailedForTask = toggle.isError && toggle.variables?.taskId === taskId;
  const isRetrying = retryingTaskId === taskId;

  useEffect(() => {
    if (filterTaskIdRef.current === taskId) return;
    filterTaskIdRef.current = taskId;
    setFilterState({ taskId, hideCompleted: false, searchQuery: '' });
  }, [taskId]);

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

      <ChecklistItems
        key={taskId}
        taskId={taskId}
        items={items}
        expanded={expanded}
        hideCompleted={hideCompleted}
        searchQuery={searchQuery}
        pendingToggleKeys={pendingToggleKeys}
        onToggle={toggleChecklistItem}
        onHideCompletedChange={(nextHideCompleted) => setFilterState((current) => ({
          taskId,
          hideCompleted: nextHideCompleted,
          searchQuery: current.taskId === taskId ? current.searchQuery : '',
        }))}
        onSearchQueryChange={(nextSearchQuery) => setFilterState((current) => ({
          taskId,
          hideCompleted: current.taskId === taskId && current.hideCompleted,
          searchQuery: nextSearchQuery,
        }))}
      />

      {toggleFailedForTask && (
        <p role="alert" className="mt-3 rounded-lg border p-3 text-sm text-destructive">
          Unable to update checklist. Please try again.
        </p>
      )}
    </div>
  );
}
