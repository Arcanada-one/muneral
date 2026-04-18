'use client';

import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { cn } from '@/lib/utils';
import { KanbanCard } from './KanbanCard';
import type { Task } from '@/lib/api/tasks';
import type { TaskStatus } from '@muneral/types';

interface KanbanColumnProps {
  status: TaskStatus;
  tasks: Task[];
  wsSlug: string;
  projSlug: string;
}

const COLUMN_CONFIG: Record<TaskStatus, { label: string; color: string; bg: string }> = {
  todo: { label: 'To Do', color: 'text-slate-600', bg: 'bg-slate-50' },
  in_progress: { label: 'In Progress', color: 'text-blue-600', bg: 'bg-blue-50' },
  review: { label: 'Review', color: 'text-amber-600', bg: 'bg-amber-50' },
  blocked: { label: 'Blocked', color: 'text-red-600', bg: 'bg-red-50' },
  done: { label: 'Done', color: 'text-green-600', bg: 'bg-green-50' },
  cancelled: { label: 'Cancelled', color: 'text-gray-400', bg: 'bg-gray-50' },
};

export function KanbanColumn({ status, tasks, wsSlug, projSlug }: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const config = COLUMN_CONFIG[status];
  const taskIds = tasks.map((t) => t.id);

  return (
    <div className={cn('flex flex-col rounded-xl p-3 min-w-[280px] w-72', config.bg)}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className={cn('text-sm font-semibold', config.color)}>{config.label}</h3>
        <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-muted-foreground shadow-sm">
          {tasks.length}
        </span>
      </div>

      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={cn(
            'flex flex-col gap-2 min-h-[200px] rounded-lg transition-colors',
            isOver && 'bg-white/70 ring-2 ring-primary/30',
          )}
        >
          {tasks.map((task) => (
            <KanbanCard
              key={task.id}
              task={task}
              wsSlug={wsSlug}
              projSlug={projSlug}
            />
          ))}
        </div>
      </SortableContext>
    </div>
  );
}
