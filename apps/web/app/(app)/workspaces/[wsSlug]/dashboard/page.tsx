'use client';

import { useParams } from 'next/navigation';
import { AgentActivityFeed } from '@/components/dashboard/AgentActivityFeed';
import { VelocityChart } from '@/components/dashboard/VelocityChart';
import { BlockersList } from '@/components/dashboard/BlockersList';
import { useProjectStore } from '@/store/project';

// Placeholder data for demo when no sprint data is available
const PLACEHOLDER_VELOCITY = [
  { sprint: 'Sprint 1', completed: 8, planned: 10 },
  { sprint: 'Sprint 2', completed: 12, planned: 12 },
  { sprint: 'Sprint 3', completed: 9, planned: 14 },
  { sprint: 'Sprint 4', completed: 15, planned: 15 },
];

export default function DashboardPage() {
  const { wsSlug } = useParams<{ wsSlug: string }>();
  const { currentProjectId, currentProjectSlug } = useProjectStore();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-muted-foreground">Agent activity and project health</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Agent activity — takes 1 col */}
        <div className="lg:col-span-1">
          <AgentActivityFeed wsSlug={wsSlug} />
        </div>

        {/* Velocity + blockers — take 2 cols */}
        <div className="space-y-6 lg:col-span-2">
          <VelocityChart data={PLACEHOLDER_VELOCITY} />

          {currentProjectId && currentProjectSlug ? (
            <BlockersList
              projectId={currentProjectId}
              wsSlug={wsSlug}
              projSlug={currentProjectSlug}
            />
          ) : (
            <div className="rounded-lg border p-4 text-center text-sm text-muted-foreground">
              Select a project to see blockers
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
