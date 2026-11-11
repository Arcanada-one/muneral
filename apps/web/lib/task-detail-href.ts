export function taskDetailHref(wsSlug: string, projSlug: string, taskId: string): string {
  return `/workspaces/${wsSlug}/projects/${projSlug}/tasks/${taskId}`;
}
