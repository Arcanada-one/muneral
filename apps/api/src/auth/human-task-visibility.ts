import type { Prisma } from '@prisma/client';

/** Reuse the existing WorkspaceMember relation at the actual data read. */
export function humanTaskWhere(userId?: string): Prisma.TaskWhereInput {
  return userId ? { project: { workspace: { members: { some: { userId } } } } } : {};
}
