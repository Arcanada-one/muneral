function safeRepositoryUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /^https:\/\/[^/\\?#]+(?:\/|$)/i.test(value)
      && !/[\s\x00-\x1f\x7f\\]/.test(value)
      && url.protocol === 'https:' && Boolean(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

/** Display the persisted link; opening it does not certify repository access or sync. */
export function ProjectRepository({ repoUrl }: { repoUrl?: string | null }) {
  if (!repoUrl) return <p className="text-sm text-muted-foreground">No repository linked</p>;
  if (!safeRepositoryUrl(repoUrl))
    return <p role="alert" className="text-sm text-muted-foreground">Repository link unavailable</p>;
  return (
    <a href={repoUrl} target="_blank" rel="noopener noreferrer"
      className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4">
      Open repository
    </a>
  );
}
