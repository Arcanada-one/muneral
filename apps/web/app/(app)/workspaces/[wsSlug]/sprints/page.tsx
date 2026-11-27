'use client';

import { Zap } from 'lucide-react';
import { useSprints } from '@/lib/api/projects';
import { useProjectStore } from '@/store/project';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useI18n } from '@/lib/i18n/useI18n';

export default function SprintsPage() {
  const { t, te, dateLocale } = useI18n();
  const { currentProjectId } = useProjectStore();
  const { data: sprints = [], isLoading } = useSprints(currentProjectId ?? '');

  if (!currentProjectId) {
    return (
      <div className="rounded-lg border p-8 text-center text-muted-foreground">
        {t('Select a project to view sprints')}
      </div>
    );
  }

  if (isLoading) {
    return <p className="text-muted-foreground">{t('Loading sprints...')}</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Zap className="h-6 w-6" />
        <h1 className="text-2xl font-bold">{t('Sprints')}</h1>
      </div>

      {sprints.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed p-12 text-center text-muted-foreground">
          {t('No sprints configured')}
        </div>
      ) : (
        <div className="space-y-4">
          {sprints.map((sprint) => (
            <Card key={sprint.id}>
              <CardHeader className="flex flex-row items-center gap-3 py-4">
                <div className="flex-1">
                  <CardTitle className="text-base">{sprint.name}</CardTitle>
                </div>
                <div className="flex items-center gap-3">
                  <Badge
                    variant={
                      sprint.status === 'active'
                        ? 'info'
                        : sprint.status === 'completed'
                        ? 'success'
                        : 'secondary'
                    }
                  >
                    {te(sprint.status)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {new Date(sprint.startDate).toLocaleDateString(dateLocale)} —{' '}
                    {new Date(sprint.endDate).toLocaleDateString(dateLocale)}
                  </span>
                </div>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
