'use client';

import { useId, useRef, useState } from 'react';
import { Copy, GitBranch, GitCommit, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTaskGitRefs, type TaskGitRef } from '@/lib/api/tasks';
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

type GitReferenceKind = 'all' | TaskGitRef['type'];

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

function CopyGitReferenceLink({
  reference,
  url,
  label,
}: {
  reference: string;
  url: string;
  label: string;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [isCopying, setIsCopying] = useState(false);
  const isCopyingRef = useRef(false);

  const copyLink = async () => {
    if (isCopyingRef.current) return;

    isCopyingRef.current = true;
    setCopyState('idle');
    setIsCopying(true);
    try {
      await navigator.clipboard.writeText(url);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    } finally {
      isCopyingRef.current = false;
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
        onClick={copyLink}
        disabled={isCopying}
        aria-label={`Copy Git reference link for ${label} ${reference}`}
      >
        <Copy className="h-3 w-3" />
      </Button>
      {copyState === 'copied' && (
        <span role="status" className="basis-full text-xs text-green-700">Git reference link copied.</span>
      )}
      {copyState === 'failed' && (
        <span role="alert" className="basis-full text-xs text-destructive">
          Could not copy Git reference link. Try copying the link manually.
        </span>
      )}
    </>
  );
}

export function TaskGitRefs({ taskId }: { taskId: string }) {
  return <TaskGitRefsForTask key={taskId} taskId={taskId} />;
}

function TaskGitRefsForTask({ taskId }: { taskId: string }) {
  const [selectedKind, setSelectedKind] = useState<GitReferenceKind>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [wrapReferenceText, setWrapReferenceText] = useState(false);
  const kindSelectId = useId();
  const searchInputId = useId();
  const { data: refs, isLoading, isError, isFetching, refetch } = useTaskGitRefs(taskId);
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const visibleRefs = (refs ?? []).filter((ref) => {
    if (selectedKind !== 'all' && ref.type !== selectedKind) return false;
    if (!normalizedSearchQuery) return true;

    if (!safeRepositoryUrl(ref.url)) {
      return 'Reference link unavailable'.toLowerCase().includes(normalizedSearchQuery);
    }

    const referenceText = ref.ref || ref.url;
    return `${referenceText}\n${ref.url}`.toLowerCase().includes(normalizedSearchQuery);
  });

  return (
    <div className="rounded-lg border p-4">
      <h4 className="mb-3 text-sm font-medium">Git References</h4>
      {isLoading || (isError && isFetching) ? (
        <p className="text-sm text-muted-foreground">Loading Git references…</p>
      ) : isError ? (
        <>
          <p role="alert" className="text-sm text-muted-foreground">Git references are unavailable.</p>
          <button
            type="button"
            aria-label="Retry Git references"
            className="mt-2 rounded text-sm text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isFetching}
            onClick={() => { void refetch(); }}
          >
            Retry
          </button>
        </>
      ) : refs === undefined ? (
        <p className="text-sm text-muted-foreground">Git references have not been loaded.</p>
      ) : refs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Git references.</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <label htmlFor={kindSelectId} className="text-sm">
              Git reference kind
            </label>
            <select
              id={kindSelectId}
              aria-label="Git reference kind"
              className="rounded border bg-background px-2 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              value={selectedKind}
              onChange={(event) => setSelectedKind(event.target.value as GitReferenceKind)}
            >
              <option value="all">All references</option>
              <option value="repo">Repositories</option>
              <option value="branch">Branches</option>
              <option value="commit">Commits</option>
            </select>
            <label htmlFor={searchInputId} className="text-sm">
              Search loaded Git references
            </label>
            <input
              id={searchInputId}
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="min-w-0 rounded border bg-background px-2 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
            {searchQuery !== '' && (
              <Button type="button" variant="outline" size="sm" onClick={() => setSearchQuery('')}>
                Clear search
              </Button>
            )}
            <label htmlFor={`${kindSelectId}-wrap`} className="inline-flex items-center gap-2 text-sm">
              <input
                id={`${kindSelectId}-wrap`}
                type="checkbox"
                checked={wrapReferenceText}
                onChange={(event) => setWrapReferenceText(event.target.checked)}
              />
              Wrap Git reference text
            </label>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            Showing {visibleRefs.length} of {refs.length} loaded Git references.
          </p>
          {visibleRefs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No matching Git references in the loaded list.{' '}
              {searchQuery !== ''
                ? 'Clear search or choose All references to show more.'
                : 'Choose All references to show more.'}
            </p>
          ) : (
            <ul className="space-y-2">
              {visibleRefs.map((ref) => {
                const Icon = iconMap[ref.type];
                const referenceText = ref.ref || ref.url;
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
                      <span className={wrapReferenceText
                        ? 'min-w-0 flex-1 whitespace-normal break-all font-mono text-xs'
                        : 'truncate font-mono text-xs'}>{referenceText}</span>
                      <ExternalLink className="h-3 w-3 flex-shrink-0 opacity-50" />
                    </a>
                    <CopyGitReference
                      key={`${taskId}:${ref.id}:${referenceText}`}
                      value={referenceText}
                      label={referenceLabels[ref.type]}
                    />
                    {typeof ref.ref === 'string' && ref.ref.trim() !== '' && ref.ref !== ref.url && (
                      <CopyGitReferenceLink
                        key={JSON.stringify([taskId, ref.id, ref.ref, ref.url])}
                        reference={ref.ref}
                        url={ref.url}
                        label={referenceLabels[ref.type]}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
