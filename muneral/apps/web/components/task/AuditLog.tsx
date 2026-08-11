'use client';

import { Bot, User, Clock } from 'lucide-react';
import { useActivity } from '@/lib/api/tasks';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';

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
  const { data, isLoading } = useActivity(taskId);
  const entries = data?.data ?? [];

  if (isLoading) {
    return (
      <div className="rounded-lg border p-4">
        <h4 className="mb-3 text-sm font-medium">Activity</h4>
        <p className="text-xs text-muted-foreground">Loading...</p>
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
    </div>
  );
}
