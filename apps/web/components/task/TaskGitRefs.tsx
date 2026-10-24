'use client';

import { useState } from 'react';
import { Copy, GitBranch, GitCommit, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTaskGitRefs } from '@/lib/api/tasks';
import { safeRepositoryUrl } from '@/components/project/ProjectRepository';

const iconMap = {
  repo: ExternalLink,
  branch: GitBranch,
  commit: GitCommit,
};

const referenceLabels = {
  repo: 'repository',
  branch: 'branch',
  commit: 'commit',
};

function CopyGitReference({ value, label }: { value: string; label: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [isCopying, setIsCopying] = useState(false);

  const copyReference = async () => {
    setCopyState('idle');
    setIsCopying(true);
    try {
      await navigator.clipboard.writeText(value);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    } finally {
      setIsCopying(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        onClick={copyReference}
        disabled={isCopying}
        aria-label={`Copy ${label} reference ${value}`}
      >
        <Copy className="h-3 w-3" />
      </Button>
      {copyState === 'copied' && (
        <span role="status" className="basis-full text-xs text-green-700">Git reference copied.</span>
      )}
      {copyState === 'failed' && (
        <span role="alert" className="basis-full text-xs text-destructive">
          Could not copy Git reference. Try copying it manually.
        </span>
      )}
    </>
  );
}

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
              <li key={ref.id} className="flex flex-wrap items-center gap-2">
                <a
                  href={ref.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-w-0 flex-1 items-center gap-2 text-sm text-primary hover:underline"
                >
                  <Icon className="h-4 w-4 flex-shrink-0" />
                  <span className="truncate font-mono text-xs">{ref.ref || ref.url}</span>
                  <ExternalLink className="h-3 w-3 flex-shrink-0 opacity-50" />
                </a>
                <CopyGitReference
                  key={`${taskId}:${ref.id}:${ref.ref || ref.url}`}
                  value={ref.ref || ref.url}
                  label={referenceLabels[ref.type]}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
