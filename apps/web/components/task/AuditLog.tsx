'use client';

import { useState } from 'react';
import { Bot, User, Clock } from 'lucide-react';
import { TASK_STATUSES, type TaskStatus } from '@muneral/types';
import { useActivity } from '@/lib/api/tasks';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';

interface AuditLogProps {
  taskId: string;
}

const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
  archived: 'Archived',
};

function isTaskStatus(value: unknown): value is TaskStatus {
  return TASK_STATUSES.some((status) => status === value);
}

function isStatusTransitionPayload(
  value: unknown,
): value is { from: unknown; to: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, 'from') &&
    Object.prototype.hasOwnProperty.call(value, 'to')
  );
}

function formatStatusTransition(payload: unknown): string | undefined {
  if (!isStatusTransitionPayload(payload)) return undefined;
  if (!isTaskStatus(payload.from) || !isTaskStatus(payload.to)) return undefined;

  return `${TASK_STATUS_LABELS[payload.from]} → ${TASK_STATUS_LABELS[payload.to]}`;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 0) {
    const timeUntil = -diffMs;
    if (timeUntil < 60_000) return 'just now';
    const minutesUntil = Math.ceil(timeUntil / 60_000);
    if (minutesUntil < 60) return `in ${minutesUntil}m`;
    const hoursUntil = Math.ceil(minutesUntil / 60);
    if (hoursUntil < 24) return `in ${hoursUntil}h`;
    return date.toLocaleDateString();
  }
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleDateString();
}

export function AuditLog({ taskId }: AuditLogProps) {
  const [pageState, setPageState] = useState({ taskId, page: 1 });
  if (pageState.taskId !== taskId) setPageState({ taskId, page: 1 });
  const page = pageState.taskId === taskId ? pageState.page : 1;
  const { data, isLoading, isError } = useActivity(taskId, page);
  const total = data !== undefined && Number.isSafeInteger(data.total) && data.total >= 0
    ? data.total
    : undefined;
  const limit = data !== undefined && Number.isSafeInteger(data.limit) && data.limit > 0
    ? data.limit
    : undefined;
  const responsePageMatches = data !== undefined && Number.isSafeInteger(data.page) && data.page === page;
  const responsePageIsUsable = data?.page === undefined || responsePageMatches;
  const pageCount = total !== undefined && limit !== undefined
    ? Math.max(1, Math.ceil(total / limit))
    : undefined;
  const pageOutOfRange = responsePageMatches && pageCount !== undefined && page > pageCount;
  if (pageOutOfRange) setPageState({ taskId, page: 1 });
  const entries = responsePageIsUsable && !pageOutOfRange
    ? (data?.data ?? []).filter((entry) => !entry.taskId || entry.taskId === taskId)
    : [];

  const setPage = (nextPage: number) => setPageState({ taskId, page: nextPage });

  if (isError) return <div role="alert" className="rounded-lg border p-4 text-sm text-muted-foreground">Activity is unavailable. Try again later.</div>;

  if (isLoading) {
    return (
      <div className="rounded-lg border p-4">
        <h4 className="mb-3 text-sm font-medium">Activity</h4>
        <p className="text-xs text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (pageOutOfRange) {
    return (
      <div className="rounded-lg border p-4" aria-live="polite">
        <h4 className="mb-3 text-sm font-medium">Activity Log</h4>
        <p className="text-xs text-muted-foreground">Showing the newest activity...</p>
      </div>
    );
  }

  const firstEntry = total === undefined || total === 0 || limit === undefined
    ? 0
    : (page - 1) * limit + 1;
  const lastEntry = total === undefined || limit === undefined
    ? 0
    : Math.min(page * limit, total);
  const canGoPrevious = !isLoading && responsePageMatches && page > 1;
  const canGoNext = !isLoading && responsePageMatches && pageCount !== undefined && page < pageCount;

  return (
    <div className="rounded-lg border p-4">
      <h4 className="mb-3 flex items-center gap-2 text-sm font-medium">
        <Clock className="h-4 w-4" />
        Activity Log
      </h4>

      <ScrollArea className="h-64">
        <ul className="space-y-3">
          {entries.map((entry) => (
            <li key={entry.id} className="flex gap-3">
              <Avatar className="h-6 w-6 flex-shrink-0 mt-0.5">
                <AvatarFallback className="text-xs">
                  {entry.actorType === 'agent' ? (
                    <Bot className="h-3 w-3" />
                  ) : (
                    <User className="h-3 w-3" />
                  )}
                </AvatarFallback>
              </Avatar>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-medium">{entry.actorName}</span>
                  {entry.actorType === 'agent' && (
                    <span className="rounded bg-blue-100 px-1 py-0.5 text-xs text-blue-700">
                      agent
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {entry.action === 'task:status_changed'
                      ? formatStatusTransition(entry.payload) ?? entry.action
                      : entry.action}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {formatRelativeTime(entry.createdAt)}
                </p>
              </div>
            </li>
          ))}
        </ul>
        {entries.length === 0 && (
          <p className="py-3 text-xs text-muted-foreground">No activity on this page.</p>
        )}
      </ScrollArea>

      <nav aria-label="Activity pagination" className="mt-3 flex items-center justify-between gap-3 text-xs">
        <span aria-live="polite" className="text-muted-foreground">
          {total !== undefined && limit !== undefined && responsePageMatches
            ? `Showing ${firstEntry}–${lastEntry} of ${total}`
            : `Page ${page}`}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Previous activity page"
            disabled={!canGoPrevious}
            onClick={() => setPage(page - 1)}
            className="rounded border px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Newer
          </button>
          {pageCount !== undefined && <span>Page {page} of {pageCount}</span>}
          <button
            type="button"
            aria-label="Next activity page"
            disabled={!canGoNext}
            onClick={() => setPage(page + 1)}
            className="rounded border px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Older
          </button>
        </div>
      </nav>
    </div>
  );
}
