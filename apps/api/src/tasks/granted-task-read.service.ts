import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { admitGrantedTaskRead, taskReadDenied } from '../auth/task-project-read-admission.js';
import type { GrantedTaskReadContext } from '../auth/task-project-read-admission.js';
import { TASK_PROJECT_READ_CAPABILITIES } from '../auth/task-project-read-capabilities.js';
import type { TaskProjectReadCapability } from '../auth/task-project-read-capabilities.js';
import { PROJECT_READ_GRANTS } from '../auth/project-read-grants.js';
import type { ProjectReadGrantEntry } from '../auth/project-read-grants.js';
import { WORKSPACE_INDEX_GRANTS } from '../auth/workspace-index-grants.js';
import type { WorkspaceIndexGrantEntry } from '../auth/workspace-index-grants.js';
import { WORK_ITEM_EVIDENCE_SCHEMA } from './evidence/task-evidence.service.js';

export const TASK_GRANTED_READ_ACTION = 'task:project_grant_read';
@Injectable()
export class GrantedTaskReadService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(TASK_PROJECT_READ_CAPABILITIES) private readonly capabilities: readonly TaskProjectReadCapability[],
    @Inject(PROJECT_READ_GRANTS) private readonly explicit: readonly ProjectReadGrantEntry[],
    @Inject(WORKSPACE_INDEX_GRANTS) private readonly workspace: readonly WorkspaceIndexGrantEntry[],
  ) {}

  async read(taskId: string, agentId: string, checked: GrantedTaskReadContext, kind: 'task' | 'evidence') {
    return this.prisma.$transaction(async tx => {
      // Lock order: actor, target task, sorted target/anchor projects. Fail the whole
      // transaction on serialization/deadlock; never retry only selection or audit.
      await tx.$queryRaw`SELECT id FROM public.agents WHERE id = ${agentId}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM public.tasks WHERE id = ${taskId}::uuid FOR SHARE`;
      const current = await tx.task.findUnique({ where: { id: taskId }, select: { projectId: true } });
      if (!current) throw taskReadDenied();
      const anchors = [
        ...this.capabilities.filter(c => c.agentId.toLowerCase() === agentId.toLowerCase()),
        ...this.workspace.filter(c => c.agentId.toLowerCase() === agentId.toLowerCase()),
      ].map(c => c.anchorProjectId);
      for (const id of [...new Set([current.projectId.toLowerCase(), ...anchors.map(x => x.toLowerCase())])].sort()) {
        await tx.$queryRaw`SELECT id FROM public.projects WHERE id = ${id}::uuid FOR SHARE`;
      }
      // Time is sampled AFTER lock waits; authority is linearized at this check.
      // Locks protect custody until commit, not wall-clock expiry or HTTP delivery.
      const admitted = await admitGrantedTaskRead(tx, agentId, taskId, new Date(), this.capabilities, this.explicit, this.workspace);
      if (JSON.stringify(admitted) !== JSON.stringify(checked)) throw taskReadDenied();
      const task = await tx.task.findFirst({ where: { id: taskId, projectId: admitted.projectId,
        project: { workspaceId: admitted.workspaceId, slug: { notIn: [...admitted.capability.excludedProjectSlugs] } } } });
      if (!task) throw taskReadDenied();
      let etag: string | null = null;
      const rows = kind === 'evidence' ? await tx.taskEvidenceAttachment.findMany({
        where: { taskId, task: { projectId: admitted.projectId, project: { workspaceId: admitted.workspaceId } } },
        orderBy: { createdAt: 'asc' },
      }) : [];
      if (kind === 'task') {
        const states = await tx.taskFieldState.findMany({ where: { taskId } });
        if (states.length) {
          const pairs = states.sort((a, b) => a.fieldName.localeCompare(b.fieldName)).map(s => `${s.fieldName}:${s.version}`).join('|');
          etag = createHash('sha256').update(`${pairs}|projectId:${task.projectId}|contractDigest:${task.contractDigest ?? 'null'}`, 'utf8').digest('hex');
        }
      }
      const evidence = { task_id: taskId, total: rows.length, evidence: rows.map(r => ({
        schema: WORK_ITEM_EVIDENCE_SCHEMA, evidence_id: r.id, task_id: r.taskId, uri: r.uri,
        sha256: r.sha256, content_type: r.contentType, created_by_agent_id: r.createdByAgentId,
        created_at: r.createdAt.toISOString(),
      })) };
      const audit = await tx.activityLog.create({
        data: { workspaceId: admitted.workspaceId, taskId, actorType: 'agent', actorId: agentId,
          action: TASK_GRANTED_READ_ACTION,
          payload: { projectId: admitted.projectId, route: kind, capabilityDecision: admitted.capability.decision,
            indexDecision: admitted.indexGrant.decision, rowCount: kind === 'task' ? 1 : rows.length } as Prisma.InputJsonValue },
        select: { id: true },
      });
      const auditReadCount = await tx.activityLog.count({
        where: { workspaceId: admitted.workspaceId, taskId, actorId: agentId, action: TASK_GRANTED_READ_ACTION },
      });
      return { task, evidence, etag, auditEventId: audit.id, auditReadCount };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
}
