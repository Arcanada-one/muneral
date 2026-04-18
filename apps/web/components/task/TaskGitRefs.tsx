'use client';

import { GitBranch, GitCommit, ExternalLink } from 'lucide-react';

interface GitRef {
  id: string;
  type: 'repo' | 'branch' | 'commit';
  url: string;
  label: string;
}

interface TaskGitRefsProps {
  refs: GitRef[];
}

const iconMap = {
  repo: ExternalLink,
  branch: GitBranch,
  commit: GitCommit,
};

export function TaskGitRefs({ refs }: TaskGitRefsProps) {
  if (refs.length === 0) return null;

  return (
    <div className="rounded-lg border p-4">
      <h4 className="mb-3 text-sm font-medium">Git References</h4>

      <ul className="space-y-2">
        {refs.map((ref) => {
          const Icon = iconMap[ref.type];
          return (
            <li key={ref.id}>
              <a
                href={ref.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-primary hover:underline"
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                <span className="truncate font-mono text-xs">{ref.label}</span>
                <ExternalLink className="h-3 w-3 flex-shrink-0 opacity-50" />
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
