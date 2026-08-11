'use client';

import { Bot } from 'lucide-react';
import { useAgentActivity } from '@/lib/api/agents';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';

interface AgentActivityFeedProps {
  wsSlug: string;
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(dateStr).toLocaleDateString();
}

export function AgentActivityFeed({ wsSlug }: AgentActivityFeedProps) {
  const { data: entries = [], isLoading } = useAgentActivity(wsSlug, 50);

  // Group by agent
  const grouped = entries.reduce<Record<string, typeof entries>>(
    (acc, entry) => {
      const key = entry.agentName;
      if (!acc[key]) acc[key] = [];
      acc[key].push(entry);
      return acc;
    },
    {},
  );

  if (isLoading) {
    return (
      <div className="rounded-lg border p-4">
        <h3 className="mb-3 text-sm font-medium">Agent Activity</h3>
        <p className="text-xs text-muted-foreground">Loading...</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border">
      <div className="border-b px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Bot className="h-4 w-4" />
          Agent Activity
        </h3>
      </div>

      <ScrollArea className="h-72">
        <div className="divide-y">
          {entries.map((entry) => (
            <div key={entry.id} className="flex gap-3 px-4 py-3">
              <Avatar className="h-7 w-7 flex-shrink-0">
                <AvatarFallback className="text-xs bg-blue-100 text-blue-700">
                  <Bot className="h-4 w-4" />
                </AvatarFallback>
              </Avatar>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">{entry.agentName}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatRelativeTime(entry.createdAt)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {entry.action}
                  {entry.taskTitle && (
                    <span className="ml-1 font-medium text-foreground">
                      &ldquo;{entry.taskTitle}&rdquo;
                    </span>
                  )}
                </p>
              </div>
            </div>
          ))}

          {entries.length === 0 && (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">
              No agent activity yet
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
