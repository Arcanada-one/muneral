// KCLIVE-10 AC4: subscriptions scoped by current project membership.
// Logged-in socket membership alone is insufficient.

export interface ProjectMembershipRow {
  userId: string;
  projectId: string;
  /** True when the user is a current WorkspaceMember of the project's workspace. */
  isMember: boolean;
}

/**
 * Pure gate used by WS join:project and any outbox/event subscription adapter.
 * A connected socket with a valid JWT still fails when isMember is false.
 */
export function maySubscribeToProject(
  connectedUserId: string | undefined,
  requestedProjectId: string | undefined,
  membership: ProjectMembershipRow | null,
): { allowed: boolean; reason: string } {
  if (!connectedUserId) {
    return { allowed: false, reason: 'not_authenticated' };
  }
  if (!requestedProjectId) {
    return { allowed: false, reason: 'project_id_missing' };
  }
  if (!membership) {
    return { allowed: false, reason: 'membership_not_measured' };
  }
  if (membership.userId !== connectedUserId) {
    return { allowed: false, reason: 'principal_mismatch' };
  }
  if (membership.projectId !== requestedProjectId) {
    return { allowed: false, reason: 'project_mismatch' };
  }
  if (!membership.isMember) {
    return { allowed: false, reason: 'not_project_workspace_member' };
  }
  return { allowed: true, reason: 'current_project_membership' };
}

/**
 * Filter outbox/event ids a subscriber may observe. Events whose projectId is
 * outside the caller's current membership set are dropped (not delivered).
 */
export function scopeOutboxEventsByMembership<
  T extends { projectId: string; eventId: string },
>(
  events: T[],
  memberProjectIds: ReadonlySet<string>,
): { delivered: T[]; withheld: T[] } {
  const delivered: T[] = [];
  const withheld: T[] = [];
  for (const event of events) {
    if (memberProjectIds.has(event.projectId)) delivered.push(event);
    else withheld.push(event);
  }
  return { delivered, withheld };
}
