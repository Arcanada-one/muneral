'use client';

import { useState } from 'react';
import { Bot, User, Clock } from 'lucide-react';
import { useActivity } from '@/lib/api/tasks';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';

const ACTIVITY_PAGE_SIZE = 20;

interface AuditLogProps {
  taskId: string;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleDateString();
}

export function AuditLog({ taskId }: AuditLogProps) {
  return <TaskActivityLog key={taskId} taskId={taskId} />;
}

function TaskActivityLog({ taskId }: AuditLogProps) {
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, isFetching } = useActivity(taskId, page);
  const entries = data?.data ?? [];
  const total = data?.total ?? 0;
  const limit = data?.limit ?? ACTIVITY_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const pageOutOfRange = Boolean(data && page > pageCount);
  const currentPage = Math.min(page, pageCount);
  const firstEntry = total === 0 ? 0 : (currentPage - 1) * limit + 1;
  const lastEntry = Math.min(currentPage * limit, total);
  const activityLabel = total === 1 ? 'activity' : 'activities';

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
      <div className="rounded-lg border p-4">
        <h4 className="mb-3 flex items-center gap-2 text-sm font-medium">
          <Clock className="h-4 w-4" />
          Activity Log
        </h4>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p role="status" className="text-xs text-muted-foreground">
            Activity changed. Return to the newest available page.
          </p>
          <button
            type="button"
            aria-label="Show newest activity"
            onClick={() => setPage(pageCount)}
            disabled={isFetching}
            className="min-h-11 rounded border px-3 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Show newest
          </button>
        </div>
      </div>
    );
  }

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
                  <span className="text-xs text-muted-foreground">{entry.action}</span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {formatRelativeTime(entry.createdAt)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </ScrollArea>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
          Showing {firstEntry}–{lastEntry} of {total} {activityLabel}
        </p>
        <nav aria-label="Activity history pagination" className="flex gap-2">
          <button
            type="button"
            aria-label="Newer activity"
            onClick={() => setPage(currentPage - 1)}
            disabled={isFetching || currentPage <= 1}
            className="min-h-11 rounded border px-3 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Newer
          </button>
          <button
            type="button"
            aria-label="Older activity"
            onClick={() => setPage(currentPage + 1)}
            disabled={isFetching || currentPage >= pageCount}
            className="min-h-11 rounded border px-3 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Older
          </button>
        </nav>
      </div>
    </div>
  );
}
