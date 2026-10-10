import type { Prisma } from '@prisma/client';
import type { Actor } from '@muneral/types';
import type { TaskFieldStateService } from '../tasks/field-state/task-field-state.service.js';
import { normalizeRawStatus } from './status-map/status-map.js';

/** DEC-AUP-0102 R-ARCHIVE: reconcile only a newly imported revision-4 identity.
 * Earlier projections and explicit native transitions remain authoritative. */
export async function projectArchiveForNewImport(
  tx: Prisma.TransactionClient,
  identityId: string,
  taskId: string,
  legacyId: string,
  revision: number,
  actor: Actor,
  fieldState: TaskFieldStateService,
): Promise<void> {
  if (revision !== 4) return;
  // Serialize with native task updates as well as the import's identity lock.
  await tx.$queryRaw`SELECT id FROM public.tasks WHERE id = ${taskId}::uuid FOR UPDATE`;
  const task = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
  if (task.importedAt === null || task.status === 'archived') return;
  const explicitlyTransitioned = await tx.activityLog.count({
    where: { taskId, action: { in: ['task:status_changed', 'migration.transition'] } },
  });
  if (explicitlyTransitioned > 0) return;
  const occurrences = await tx.sourceOccurrence.findMany({
    where: { legacyIdentityId: identityId },
    select: { statusMapRevision: true, historicalStatus: true, sourceKey: true, sourceLocator: true },
  });
  if (occurrences.some((o) => o.statusMapRevision !== 4)) return;
  const hasArchive = occurrences.some((o) =>
    o.sourceKey === `archive:${legacyId}` &&
    o.sourceLocator.startsWith('../documentation/archive/') &&
    o.sourceLocator.endsWith(`/archive-${legacyId}.md`) &&
    normalizeRawStatus(o.historicalStatus) === 'archived',
  );
  if (!hasArchive) return;
  const updated = await tx.task.updateMany({
    where: { id: taskId, status: task.status, revision: task.revision },
    data: { status: 'archived', revision: { increment: 1 } },
  });
  if (updated.count !== 1) throw new Error('archive projection lost its locked task');
  const projected = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
  await fieldState.recompute(tx, projected);
  const { workspaceId } = await tx.project.findUniqueOrThrow({
    where: { id: task.projectId }, select: { workspaceId: true },
  });
  await tx.activityLog.create({
    data: {
      workspaceId, taskId, actorType: actor.type, actorId: actor.id,
      action: 'migration.archive_projected',
      payload: { from: task.status, to: 'archived', statusMapRevision: 4, basis: 'DEC-AUP-0102 R-ARCHIVE' },
    },
  });
}
