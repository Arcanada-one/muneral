'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useChecklist, useToggleChecklistItem } from '@/lib/api/tasks';
import { cn } from '@/lib/utils';

interface TaskChecklistProps {
  taskId: string;
}

export function TaskChecklist({ taskId }: TaskChecklistProps) {
  const [expanded, setExpanded] = useState(true);
  const { data: items = [], isLoading } = useChecklist(taskId);
  const toggle = useToggleChecklistItem();

  const completed = items.filter((i) => i.checked).length;
  const total = items.length;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  if (isLoading) return null;
  if (total === 0) return null;

  return (
    <div className="rounded-lg border p-4">
      <button
        onClick={() => setExpanded((v) => !v)}
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

      {expanded && (
        <ul className="mt-3 space-y-2">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-2">
              <input
                type="checkbox"
                id={`checklist-${item.id}`}
                checked={item.checked}
                onChange={(e) =>
                  toggle.mutate({ taskId, itemId: item.id, checked: e.target.checked })
                }
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
