'use client';

import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { useTasks } from '@/lib/api/tasks';
import { Badge } from '@/components/ui/badge';
import { useI18n } from '@/lib/i18n/useI18n';

interface BlockersListProps {
  projectId: string;
  wsSlug: string;
  projSlug: string;
}

export function BlockersList({ projectId, wsSlug, projSlug }: BlockersListProps) {
  const { t, dateLocale } = useI18n();
  const { data: result, isLoading, isError } = useTasks(projectId, { status: 'blocked' });
  const blockers = result?.data ?? [];

  return (
    <div className="rounded-lg border">
      <div className="border-b px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-medium text-destructive">
          <AlertTriangle className="h-4 w-4" />
          {t('Blockers')}
          {!isError && !isLoading && blockers.length > 0 && (
            <Badge variant="destructive" className="ml-auto">
              {blockers.length}
            </Badge>
          )}
        </h3>
      </div>

      {isError ? (
        <div role="alert" className="px-4 py-8 text-center text-xs text-muted-foreground">
          {t('Blockers are unavailable. Try again later.')}
        </div>
      ) : isLoading ? (
        <div className="px-4 py-8 text-center text-xs text-muted-foreground">
          {t('Loading blockers...')}
        </div>
      ) : blockers.length === 0 ? (
        <div className="px-4 py-8 text-center text-xs text-muted-foreground">
          {t('No blockers — keep going!')}
        </div>
      ) : (
        <ul className="divide-y">
          {blockers.map((task) => (
            <li key={task.id} className="flex items-center gap-3 px-4 py-3">
              <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <Link
                  href={`/workspaces/${wsSlug}/projects/${projSlug}/tasks/${task.id}`}
                  className="text-sm font-medium hover:underline truncate block"
                >
                  {task.title}
                </Link>
                {task.dueDate && (
                  <p className="text-xs text-muted-foreground">
                    {t('Due {date}', { date: new Date(task.dueDate).toLocaleDateString(dateLocale) })}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
