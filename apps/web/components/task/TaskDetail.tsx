'use client';

import { useEffect, useRef, useState } from 'react';
import { Bot, User, AlertCircle, Calendar } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { TaskChecklist } from './TaskChecklist';
import { TaskDependencies } from './TaskDependencies';
import { AuditLog } from './AuditLog';
import { TaskGitRefs } from './TaskGitRefs';
import { useUpdateTaskStatus, type Task } from '@/lib/api/tasks';
import { TASK_STATUSES, TASK_TRANSITIONS, type TaskStatus } from '@muneral/types';
import { cn } from '@/lib/utils';

interface TaskDetailProps {
  task: Task;
}

// MUN-0043: typed Record<TaskStatus, ...> so a status added to the union fails the
// build at this literal instead of at the indexing site below. Before rev 3 this was
// an untyped object literal and adding `archived` broke `statusConfig[task.status]`.
const statusConfig: Record<
  TaskStatus,
  { label: string; variant: 'secondary' | 'info' | 'warning' | 'destructive' | 'success' | 'outline' }
> = {
  todo: { label: 'To Do', variant: 'secondary' },
  in_progress: { label: 'In Progress', variant: 'info' },
  review: { label: 'Review', variant: 'warning' },
  blocked: { label: 'Blocked', variant: 'destructive' },
  done: { label: 'Done', variant: 'success' },
  cancelled: { label: 'Cancelled', variant: 'outline' },
  // archived is terminal and distinct from done (status map rev 3): it is rendered,
  // never dropped, and never styled as a success.
  archived: { label: 'Archived', variant: 'outline' },
};

const priorityConfig = {
  critical: { label: 'Critical', variant: 'destructive' as const },
  high: { label: 'High', variant: 'warning' as const },
  medium: { label: 'Medium', variant: 'info' as const },
  low: { label: 'Low', variant: 'secondary' as const },
};

function isTaskStatus(value: string): value is TaskStatus {
  return TASK_STATUSES.some((status) => status === value);
}

export function TaskDetail({ task }: TaskDetailProps) {
  const pConfig = priorityConfig[task.priority];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{task.title}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <TaskStatusAction key={`${task.id}:${task.status}:${task.updatedAt}`} task={task} />
          <Badge variant={pConfig.variant}>{pConfig.label}</Badge>

          {task.actorType === 'agent' ? (
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <Bot className="h-4 w-4" />
              Agent task
            </span>
          ) : task.actorType === 'human' ? (
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <User className="h-4 w-4" />
              Human task
            </span>
          ) : <span className="text-sm text-muted-foreground">Actor not specified</span>}

          {task.dueDate && (
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <Calendar className="h-4 w-4" />
              Due {Number.isNaN(Date.parse(task.dueDate)) ? task.dueDate : new Date(task.dueDate).toLocaleDateString()}
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
      {task.tags && task.tags.length > 0 && (
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
        {task.estimateHours !== undefined && task.estimateHours !== null && (
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

function TaskStatusAction({ task }: TaskDetailProps) {
  const [confirmedStatus, setConfirmedStatus] = useState<TaskStatus | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [hasError, setHasError] = useState(false);
  const pendingRef = useRef(false);
  const currentVisitRef = useRef(true);
  const statusMutation = useUpdateTaskStatus();
  const currentStatus = confirmedStatus ?? task.status;
  const currentConfig = statusConfig[currentStatus];
  const allowedTargets = TASK_TRANSITIONS[currentStatus];

  useEffect(() => {
    currentVisitRef.current = true;
    return () => {
      currentVisitRef.current = false;
    };
  }, []);

  const updateTaskStatus = (nextStatus: string) => {
    if (!isTaskStatus(nextStatus) || !allowedTargets.includes(nextStatus) || pendingRef.current) {
      return;
    }

    pendingRef.current = true;
    setIsPending(true);
    setHasError(false);
    statusMutation.mutate(
      { taskId: task.id, status: nextStatus },
      {
        onSuccess: (updatedTask) => {
          if (!currentVisitRef.current) return;
          const responseStatusIsKnown = TASK_STATUSES.some(
            (status) => status === updatedTask.status,
          );
          if (
            updatedTask.id !== task.id ||
            !responseStatusIsKnown ||
            updatedTask.status !== nextStatus
          ) {
            setHasError(true);
            return;
          }
          setConfirmedStatus(updatedTask.status);
        },
        onError: () => {
          if (currentVisitRef.current) setHasError(true);
        },
        onSettled: () => {
          pendingRef.current = false;
          if (currentVisitRef.current) setIsPending(false);
        },
      },
    );
  };

  return (
    <>
      <Badge variant={currentConfig.variant}>{currentConfig.label}</Badge>
      {allowedTargets.length > 0 ? (
        <div className="flex items-center gap-2">
          <label htmlFor={`task-status-${task.id}`} className="text-sm text-muted-foreground">
            Change task status
          </label>
          <select
            id={`task-status-${task.id}`}
            value={currentStatus}
            disabled={isPending}
            onChange={(event) => updateTaskStatus(event.currentTarget.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value={currentStatus}>Current: {currentConfig.label}</option>
            {allowedTargets.map((status) => (
              <option key={status} value={status}>
                {statusConfig[status].label}
              </option>
            ))}
          </select>
          {isPending && (
            <span aria-live="polite" className="text-sm text-muted-foreground">
              Updating status…
            </span>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No status changes are available.</p>
      )}
      {hasError && (
        <p role="alert" className="text-sm text-destructive">
          Could not update status. Reload the task to confirm its current status before trying again.
        </p>
      )}
    </>
  );
}
