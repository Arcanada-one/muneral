import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { projectReadGrantState } from './project-read-grants.js';
import type { ProjectReadGrantEntry } from './project-read-grants.js';
import type { ProjectIndexGrant, WorkspaceIndexGrantEntry } from './workspace-index-grants.js';

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Reused only by the index guard and its transactional service boundary. */
export async function admitProjectIndex(
  db: Pick<Prisma.TransactionClient, 'agent' | 'project'>,
  agentId: string,
  projectId: string,
  now: Date,
  explicit: readonly ProjectReadGrantEntry[],
  workspace: readonly WorkspaceIndexGrantEntry[],
  checkedWorkspaceId?: string,
): Promise<{ workspaceId: string; grant: ProjectIndexGrant; excludedProjectSlugs: readonly string[] }> {
  const deny = () => new NotFoundException(`Project ${projectId} not found.`);
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { workspaceId: true } }).catch(() => null);
  if (!agent || (checkedWorkspaceId && !sameId(agent.workspaceId, checkedWorkspaceId))) throw deny();
  const project = await db.project.findFirst({
    where: { id: projectId, workspaceId: agent.workspaceId },
    select: { id: true, workspaceId: true, slug: true },
  }).catch(() => null);
  if (!project) throw deny();
  const candidates = workspace.filter(g => sameId(g.agentId, agentId));
  // Conflicting configured authority is held, never silently selected.
  if (candidates.length > 1) throw deny();
  const candidate = candidates[0];
  const excludedProjectSlugs = candidate?.excludedProjectSlugs ?? [];
  if (excludedProjectSlugs.includes(project.slug)) throw deny();
  const exact = projectReadGrantState(agentId, projectId, now, explicit);
  const expired = (entry: { until: string; decision: string }): never => {
    throw new ForbiddenException({
      code: 'GRANT_EXPIRED',
      message: `The project read grant for this key expired at ${entry.until}. It is renewed by a pull request citing a program decision, not by an environment edit (MUN-0055).`,
      projectId, until: entry.until, decision: entry.decision,
    });
  };
  if (exact.kind === 'expired') expired(exact.entry);
  if (exact.kind === 'live') return { workspaceId: agent.workspaceId, grant: exact.entry, excludedProjectSlugs };
  if (!candidate || !sameId(candidate.workspaceId, agent.workspaceId)) throw deny();
  const anchor = await db.project.findFirst({
    where: { id: candidate.anchorProjectId, workspaceId: candidate.workspaceId }, select: { id: true },
  }).catch(() => null);
  if (!anchor || !Number.isFinite(Date.parse(candidate.until))) throw deny();
  if (now.getTime() >= Date.parse(candidate.until)) expired(candidate);
  return {
    workspaceId: candidate.workspaceId, excludedProjectSlugs,
    grant: { agentId: candidate.agentId, agentName: candidate.agentName, projectId: project.id,
      until: candidate.until, decision: candidate.decision, evidence: candidate.evidence,
      kind: 'workspace-index', workspaceId: candidate.workspaceId, anchorProjectId: candidate.anchorProjectId },
  };
}
