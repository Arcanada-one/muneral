'use client';

import { ArrowRight, Link2, Copy } from 'lucide-react';
import { useDependencies } from '@/lib/api/tasks';

interface TaskDependenciesProps {
  taskId: string;
}

const typeLabels: Record<string, { label: string; className: string }> = {
  depends_on: { label: 'Depends on', className: 'text-blue-600' },
  blocks: { label: 'Blocks', className: 'text-red-600' },
  related_to: { label: 'Related to', className: 'text-gray-600' },
  duplicates: { label: 'Duplicates', className: 'text-amber-600' },
};

export function TaskDependencies({ taskId }: TaskDependenciesProps) {
  const { data: deps = [], isLoading } = useDependencies(taskId);

  if (isLoading) return null;
  if (deps.length === 0) return null;

  return (
    <div className="rounded-lg border p-4">
      <h4 className="mb-3 flex items-center gap-2 text-sm font-medium">
        <Link2 className="h-4 w-4" />
        Dependencies
      </h4>

      <ul className="space-y-2">
        {deps.map((dep) => {
          const config = typeLabels[dep.type] ?? { label: dep.type, className: 'text-gray-600' };
          const targetId =
            dep.fromTaskId === taskId ? dep.toTaskId : dep.fromTaskId;

          return (
            <li key={dep.id} className="flex items-center gap-2 text-sm">
              <span className={config.className + ' text-xs font-medium min-w-[80px]'}>
                {config.label}
              </span>
              <ArrowRight className="h-3 w-3 text-muted-foreground" />
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                {targetId.slice(0, 8)}
              </code>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
