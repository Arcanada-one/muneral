import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { admitProjectIndex } from './project-index-admission.js';
import type { ProjectReadGrantEntry } from './project-read-grants.js';
import type { WorkspaceIndexGrantEntry, ProjectIndexGrant } from './workspace-index-grants.js';
import type { TaskProjectReadCapability } from './task-project-read-capabilities.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const taskReadDenied = () => new ForbiddenException({
  code: 'TASK_READ_GRANT_REQUIRED', message: 'This task is not in the read scope of this agent key.',
});
export interface GrantedTaskReadContext {
  projectId: string;
  workspaceId: string;
  capability: TaskProjectReadCapability;
  indexGrant: ProjectIndexGrant;
}

/** No write, activity, collection or ordinary owner authorization uses this capability. */
export async function admitGrantedTaskRead(
  db: Pick<Prisma.TransactionClient, 'agent' | 'project' | 'task'>,
  agentId: string,
  taskId: string,
  now: Date,
  capabilities: readonly TaskProjectReadCapability[],
  explicit: readonly ProjectReadGrantEntry[],
  workspace: readonly WorkspaceIndexGrantEntry[],
): Promise<GrantedTaskReadContext> {
  if (!uuid.test(agentId) || !uuid.test(taskId)) throw taskReadDenied();
  const matches = capabilities.filter(c => sameId(c.agentId, agentId));
  if (matches.length !== 1) throw taskReadDenied();
  const capability = matches[0];
  if (!uuid.test(capability.workspaceId) || !uuid.test(capability.anchorProjectId)) throw taskReadDenied();
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { workspaceId: true } });
  if (!agent || !sameId(agent.workspaceId, capability.workspaceId)) throw taskReadDenied();
  // Always check the capability's own anchor, including the exact-index-grant path.
  const anchor = await db.project.findFirst({
    where: { id: capability.anchorProjectId, workspaceId: capability.workspaceId }, select: { id: true },
  });
  const task = await db.task.findFirst({
    where: { id: taskId, project: { workspaceId: capability.workspaceId,
      slug: { notIn: [...capability.excludedProjectSlugs] } } }, select: { projectId: true },
  });
  if (!anchor || !task || !Number.isFinite(Date.parse(capability.until))) throw taskReadDenied();
  if (now.getTime() >= Date.parse(capability.until)) throw new ForbiddenException({
    code: 'TASK_READ_CAPABILITY_EXPIRED', message: 'The additional task/evidence read capability expired.',
    until: capability.until, decision: capability.decision,
  });
  try {
    const admitted = await admitProjectIndex(db, agentId, task.projectId, now, explicit, workspace, capability.workspaceId);
    return { projectId: task.projectId, workspaceId: admitted.workspaceId, capability, indexGrant: admitted.grant };
  } catch (error) {
    if (error instanceof NotFoundException) throw taskReadDenied();
    throw error;
  }
}
