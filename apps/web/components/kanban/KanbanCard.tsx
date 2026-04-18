'use client';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Bot, User, AlertCircle } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { Task } from '@/lib/api/tasks';

interface KanbanCardProps {
  task: Task;
  wsSlug: string;
  projSlug: string;
}

const priorityConfig = {
  critical: { label: 'Critical', variant: 'destructive' as const },
  high: { label: 'High', variant: 'warning' as const },
  medium: { label: 'Medium', variant: 'info' as const },
  low: { label: 'Low', variant: 'secondary' as const },
};

export function KanbanCard({ task, wsSlug, projSlug }: KanbanCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const pConfig = priorityConfig[task.priority];

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group relative rounded-lg border bg-card p-3 shadow-sm hover:shadow-md transition-shadow',
        isDragging && 'opacity-50 ring-2 ring-primary',
      )}
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        className="absolute left-1 top-1/2 -translate-y-1/2 cursor-grab touch-none opacity-0 group-hover:opacity-40 hover:opacity-100 transition-opacity"
        aria-label="Drag task"
        tabIndex={-1}
      >
        <GripVertical className="h-4 w-4" />
      </button>

      <div className="pl-4">
        <Link
          href={`/workspaces/${wsSlug}/projects/${projSlug}/tasks/${task.id}`}
          className="text-sm font-medium leading-tight hover:underline line-clamp-2"
        >
          {task.title}
        </Link>

        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <Badge variant={pConfig.variant} className="text-xs">
            {pConfig.label}
          </Badge>

          {task.actorType === 'agent' ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Bot className="h-3 w-3" />
              Agent
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <User className="h-3 w-3" />
              Human
            </span>
          )}

          {task.status === 'blocked' && (
            <AlertCircle className="h-3.5 w-3.5 text-destructive" />
          )}
        </div>

        {task.dueDate && (
          <p className="mt-1 text-xs text-muted-foreground">
            Due {new Date(task.dueDate).toLocaleDateString()}
          </p>
        )}
      </div>
    </div>
  );
}
