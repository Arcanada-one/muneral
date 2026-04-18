'use client';

import { Bot, User, AlertCircle, Calendar } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { TaskChecklist } from './TaskChecklist';
import { TaskDependencies } from './TaskDependencies';
import { AuditLog } from './AuditLog';
import { TaskGitRefs } from './TaskGitRefs';
import type { Task } from '@/lib/api/tasks';
import { cn } from '@/lib/utils';

interface TaskDetailProps {
  task: Task;
}

const statusConfig = {
  todo: { label: 'To Do', variant: 'secondary' as const },
  in_progress: { label: 'In Progress', variant: 'info' as const },
  review: { label: 'Review', variant: 'warning' as const },
  blocked: { label: 'Blocked', variant: 'destructive' as const },
  done: { label: 'Done', variant: 'success' as const },
  cancelled: { label: 'Cancelled', variant: 'outline' as const },
};

const priorityConfig = {
  critical: { label: 'Critical', variant: 'destructive' as const },
  high: { label: 'High', variant: 'warning' as const },
  medium: { label: 'Medium', variant: 'info' as const },
  low: { label: 'Low', variant: 'secondary' as const },
};

export function TaskDetail({ task }: TaskDetailProps) {
  const sConfig = statusConfig[task.status];
  const pConfig = priorityConfig[task.priority];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{task.title}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Badge variant={sConfig.variant}>{sConfig.label}</Badge>
          <Badge variant={pConfig.variant}>{pConfig.label}</Badge>

          {task.actorType === 'agent' ? (
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <Bot className="h-4 w-4" />
              Agent task
            </span>
          ) : (
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <User className="h-4 w-4" />
              Human task
            </span>
          )}

          {task.dueDate && (
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <Calendar className="h-4 w-4" />
              Due {new Date(task.dueDate).toLocaleDateString()}
            </span>
          )}
        </div>
      </div>

      {/* Description */}
      {task.description && (
        <div className="rounded-lg border p-4">
          <h3 className="mb-2 text-sm font-medium">Description</h3>
          <div className="prose prose-sm max-w-none text-sm text-muted-foreground">
            <p className="whitespace-pre-wrap">{task.description}</p>
          </div>
        </div>
      )}

      {/* Tags */}
      {task.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {task.tags.map((tag) => (
            <Badge key={tag} variant="outline" className="text-xs">
              {tag}
            </Badge>
          ))}
        </div>
      )}

      {/* Metadata grid */}
      <div className="grid grid-cols-2 gap-4 rounded-lg border p-4 text-sm">
        <div>
          <p className="text-xs text-muted-foreground">Created</p>
          <p>{new Date(task.createdAt).toLocaleString()}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Updated</p>
          <p>{new Date(task.updatedAt).toLocaleString()}</p>
        </div>
        {task.estimateHours !== undefined && (
          <div>
            <p className="text-xs text-muted-foreground">Estimate</p>
            <p>{task.estimateHours}h</p>
          </div>
        )}
      </div>

      {/* Checklist */}
      <TaskChecklist taskId={task.id} />

      {/* Dependencies */}
      <TaskDependencies taskId={task.id} />

      {/* Git refs — empty by default (would be loaded separately) */}
      <TaskGitRefs refs={[]} />

      {/* Audit log */}
      <AuditLog taskId={task.id} />
    </div>
  );
}
