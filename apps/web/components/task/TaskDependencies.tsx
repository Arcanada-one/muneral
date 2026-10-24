'use client';

import { ArrowRight, Link2 } from 'lucide-react';
import { useDependencyGraph } from '@/lib/api/tasks';

interface TaskDependenciesProps {
  taskId: string;
}

const typeLabels: Record<string, { incoming: string; outgoing: string; className: string }> = {
  depends_on: { incoming: 'Required by', outgoing: 'Depends on', className: 'text-blue-600' },
  blocks: { incoming: 'Blocked by', outgoing: 'Blocks', className: 'text-red-600' },
  related_to: { incoming: 'Related to', outgoing: 'Related to', className: 'text-gray-600' },
  duplicates: { incoming: 'Duplicates', outgoing: 'Duplicates', className: 'text-amber-600' },
};

export function TaskDependencies({ taskId }: TaskDependenciesProps) {
  const { data: deps = [], isLoading, isError } = useDependencyGraph(taskId);

  if (isError) {
    return (
      <div role="alert" className="rounded-lg border p-4 text-sm text-muted-foreground">
        Dependencies are unavailable. Try again later.
      </div>
    );
  }
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
          const config = typeLabels[dep.type];
          const label = config?.[dep.direction] ?? dep.type;

          return (
            <li key={dep.id} className="flex items-center gap-2 text-sm">
              <span className={(config?.className ?? 'text-gray-600') + ' text-xs font-medium min-w-[80px]'}>
                {label}
              </span>
              <ArrowRight className="h-3 w-3 text-muted-foreground" />
              <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                {dep.otherTaskId.slice(0, 8)}
              </code>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
