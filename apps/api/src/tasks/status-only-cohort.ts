import type { Prisma } from '@prisma/client';

export function statusOnlyCohortQuery(workspaceId: string, projectId?: string) {
  return {
    where: {
      project: { workspaceId },
      ...(projectId ? { projectId } : {}),
    },
    select: { status: true },
  } satisfies Prisma.TaskFindManyArgs;
}
