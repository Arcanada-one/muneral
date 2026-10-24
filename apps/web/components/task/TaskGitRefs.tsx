'use client';

import { GitBranch, GitCommit, ExternalLink } from 'lucide-react';
import { useTaskGitRefs } from '@/lib/api/tasks';
import { safeRepositoryUrl } from '@/components/project/ProjectRepository';

const iconMap = {
  repo: ExternalLink,
  branch: GitBranch,
  commit: GitCommit,
};

export function TaskGitRefs({ taskId }: { taskId: string }) {
  const { data: refs, isLoading, isError } = useTaskGitRefs(taskId);

  return (
    <div className="rounded-lg border p-4">
      <h4 className="mb-3 text-sm font-medium">Git References</h4>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading Git references…</p>
      ) : isError ? (
        <p role="alert" className="text-sm text-muted-foreground">Git references are unavailable.</p>
      ) : refs === undefined || refs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Git references.</p>
      ) : (
        <ul className="space-y-2">
          {refs.map((ref) => {
            const Icon = iconMap[ref.type];
            if (!safeRepositoryUrl(ref.url)) {
              return (
                <li key={ref.id}>
                  <span role="alert" className="text-sm text-muted-foreground">
                    Reference link unavailable
                  </span>
                </li>
              );
            }

            return (
              <li key={ref.id}>
                <a
                  href={ref.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-sm text-primary hover:underline"
                >
                  <Icon className="h-4 w-4 flex-shrink-0" />
                  <span className="truncate font-mono text-xs">{ref.ref || ref.url}</span>
                  <ExternalLink className="h-3 w-3 flex-shrink-0 opacity-50" />
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
