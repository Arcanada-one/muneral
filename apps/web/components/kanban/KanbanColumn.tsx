'use client';

import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { cn } from '@/lib/utils';
import { KanbanCard } from './KanbanCard';
import type { Task } from '@/lib/api/tasks';
import type { TaskStatus } from '@muneral/types';
import { useI18n } from '@/lib/i18n/useI18n';
import type { MessageKey } from '@/lib/i18n/messages';

interface KanbanColumnProps {
  status: TaskStatus;
  tasks: Task[];
  wsSlug: string;
  projSlug: string;
}

const COLUMN_CONFIG: Record<TaskStatus, { label: MessageKey; color: string; bg: string }> = {
  todo: { label: 'To Do', color: 'text-slate-600 dark:text-slate-300', bg: 'bg-slate-50 dark:bg-slate-950/30' },
  in_progress: { label: 'In Progress', color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950/30' },
  review: { label: 'Review', color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-950/30' },
  blocked: { label: 'Blocked', color: 'text-red-600 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-950/30' },
  done: { label: 'Done', color: 'text-green-600 dark:text-green-400', bg: 'bg-green-50 dark:bg-green-950/30' },
  cancelled: { label: 'Cancelled', color: 'text-gray-400', bg: 'bg-gray-50 dark:bg-gray-900/40' },
  // MUN-0043: archived cards have left the board, so `archived` is absent from
  // KANBAN_STATUSES and no column is rendered for it. The entry exists because
  // the config is total over TaskStatus — a card that reaches this component
  // by any other route still gets a label instead of an undefined config.
  archived: { label: 'Archived', color: 'text-gray-400', bg: 'bg-gray-50 dark:bg-gray-900/40' },
};

export function KanbanColumn({ status, tasks, wsSlug, projSlug }: KanbanColumnProps) {
  const { t } = useI18n();
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const config = COLUMN_CONFIG[status];
  const taskIds = tasks.map((t) => t.id);

  return (
    <div className={cn('flex flex-col rounded-xl p-3 min-w-[280px] w-72', config.bg)}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className={cn('text-sm font-semibold', config.color)}>{t(config.label)}</h3>
        <span className="rounded-full bg-white dark:bg-card px-2 py-0.5 text-xs font-medium text-muted-foreground shadow-sm">
          {tasks.length}
        </span>
      </div>

      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={cn(
            'flex flex-col gap-2 min-h-[200px] rounded-lg transition-colors',
            isOver && 'bg-white/70 dark:bg-card/70 ring-2 ring-primary/30',
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
