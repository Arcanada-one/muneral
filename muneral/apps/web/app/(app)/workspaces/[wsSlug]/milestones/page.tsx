'use client';

import { useParams } from 'next/navigation';
import { Flag, CheckCircle2, Circle } from 'lucide-react';
import { useMilestones } from '@/lib/api/projects';
import { useProjectStore } from '@/store/project';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function MilestonesPage() {
  const { wsSlug } = useParams<{ wsSlug: string }>();
  const { currentProjectId } = useProjectStore();
  const { data: milestones = [], isLoading } = useMilestones(currentProjectId ?? '');

  if (!currentProjectId) {
    return (
      <div className="rounded-lg border p-8 text-center text-muted-foreground">
        Select a project to view milestones
      </div>
    );
  }

  if (isLoading) {
    return <p className="text-muted-foreground">Loading milestones...</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Flag className="h-6 w-6" />
        <h1 className="text-2xl font-bold">Milestones</h1>
      </div>

      {milestones.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed p-12 text-center text-muted-foreground">
          No milestones defined for this project
        </div>
      ) : (
        <div className="space-y-4">
          {milestones.map((milestone) => (
            <Card key={milestone.id}>
              <CardHeader className="flex flex-row items-center gap-3 py-4">
                {milestone.status === 'closed' ? (
                  <CheckCircle2 className="h-5 w-5 text-green-500" />
                ) : (
                  <Circle className="h-5 w-5 text-muted-foreground" />
                )}
                <div className="flex-1">
                  <CardTitle className="text-base">{milestone.title}</CardTitle>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant={milestone.status === 'closed' ? 'success' : 'info'}>
                    {milestone.status}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {milestone.taskCount} tasks
                  </span>
                  {milestone.dueDate && (
                    <span className="text-xs text-muted-foreground">
                      Due {new Date(milestone.dueDate).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
