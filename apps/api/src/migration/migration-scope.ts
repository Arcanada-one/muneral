import type { Prisma } from '@prisma/client';

/**
 * MUN-0053 — the workspace wall of the migration surface.
 *
 * Before MUN-0053 every migration route answered any valid key (and any JWT)
 * about any workspace: a key could CAS-move a task of another tenant, open a
 * batch on another tenant's project, and read identities, occurrences and
 * mappings across tenants. Every route now narrows to the CALLER'S workspaces —
 * the agent's own workspace for a key, the workspaces the user is a member of
 * for a JWT — and answers the not-found of that route for anything outside
 * them, the same answer an id that never existed gets.
 *
 * A legacy identity is global (unique on namespace + legacy id), so it belongs
 * to a workspace through what it is attached to: the task it is bound to, or,
 * while unbound, the batches its occurrences were recorded in.
 */
export function batchInWorkspacesWhere(workspaceIds: string[]): Prisma.MigrationBatchWhereInput {
  return { project: { workspaceId: { in: workspaceIds } } };
}

export function occurrenceInWorkspacesWhere(
  workspaceIds: string[],
): Prisma.SourceOccurrenceWhereInput {
  return { batch: batchInWorkspacesWhere(workspaceIds) };
}

export function identityInWorkspacesWhere(
  workspaceIds: string[],
): Prisma.LegacyIdentityWhereInput {
  return {
    OR: [
      { task: { project: { workspaceId: { in: workspaceIds } } } },
      { taskId: null, occurrences: { some: occurrenceInWorkspacesWhere(workspaceIds) } },
    ],
  };
}
