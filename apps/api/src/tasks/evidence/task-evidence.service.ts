import { Injectable, NotFoundException } from '@nestjs/common';
import { TaskEvidenceAttachment } from '@prisma/client';
import type { Actor } from '@muneral/types';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ActivityService } from '../../activity/activity.service.js';
import { AttachEvidenceDto } from './attach-evidence.dto.js';
import {
  agentKeyRequired,
  digestConflict,
  requireContentType,
  requireSha256,
  requireUri,
} from './task-evidence.errors.js';

/** A2-274 — the schema name of one attachment, carried on every record the
 *  route returns so a reader never has to infer the shape from the keys. */
export const WORK_ITEM_EVIDENCE_SCHEMA = 'WorkItemEvidenceAttachment/v1';

export const EVIDENCE_ATTACHED_ACTION = 'task:evidence_attached';

/**
 * WorkItemEvidenceAttachment/v1 — the record as the API returns it.
 *
 * snake_case, as `RedactionResult` next door. `idempotent` is present on the
 * POST answer and absent from the list: it is a fact about one call, not about
 * the stored row.
 */
export interface WorkItemEvidenceAttachment {
  schema: typeof WORK_ITEM_EVIDENCE_SCHEMA;
  evidence_id: string;
  task_id: string;
  uri: string;
  sha256: string;
  content_type: string;
  created_by_agent_id: string;
  created_at: string;
  idempotent?: boolean;
}

export interface WorkItemEvidenceList {
  task_id: string;
  total: number;
  evidence: WorkItemEvidenceAttachment[];
}

/**
 * A2-274 (MUN-EVIDENCE) — attach an artefact to a work item and read the list
 * back.
 *
 * Why this exists. A2-P4 ends with an executor that has finished a work item
 * and holds a `ReadinessReceipt/v1` for it. Before this route the only place on
 * the work item an agent key could write was a comment (MUN-0046): free text,
 * in which a reader cannot tell a receipt from a sentence describing one, and
 * which binds no bytes. This route records the three things a later reader
 * needs — where the artefact is, what it is, and which bytes were meant — and
 * who attached it.
 *
 * The digest is the identity. `UNIQUE (task_id, sha256)` is what makes the
 * route idempotent: an unattended executor that lost its answer and retries
 * gets the stored row with `idempotent: true` and 200, never a second record of
 * one artefact. The same index is what lets a repeat with a DIFFERENT uri or
 * media type be refused (409 `EVIDENCE_DIGEST_CONFLICT`) instead of silently
 * keeping the first — see `digestConflict`.
 *
 * What it does NOT do: fetch the uri, verify that the bytes there hash to
 * `sha256`, or change anything on the task. The server records a CLAIM about
 * an artefact, attributed to the agent that made it; it does not certify it,
 * and nothing here may be read as "the evidence was checked".
 */
@Injectable()
export class TaskEvidenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityService: ActivityService,
  ) {}

  async attach(
    taskId: string,
    actor: Actor,
    dto: AttachEvidenceDto,
  ): Promise<{ statusCode: 200 | 201; body: WorkItemEvidenceAttachment }> {
    // Attribution comes from the credential (ActorInterceptor), never from the
    // body — the DTO has no field a caller could use to claim another agent.
    if (actor.type !== 'agent') throw agentKeyRequired();

    const uri = requireUri(dto.uri);
    const sha256 = requireSha256(dto.sha256);
    const contentType = requireContentType(dto.contentType);

    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { id: true, project: { select: { workspaceId: true } } },
    });
    // Reachable by a JWT only: an agent key never gets here for a task it does
    // not own — AgentTaskScopeGuard answered 403 first, for an unknown id as
    // well as for a foreign one, so the route cannot enumerate task ids.
    if (!task) throw new NotFoundException('Task not found');

    const existing = await this.findRecord(taskId, sha256);
    if (existing) return this.repeat(existing, taskId, sha256, uri, contentType);

    try {
      const record = await this.prisma.$transaction(
        async (tx) => {
          const created = await tx.taskEvidenceAttachment.create({
            data: { taskId, uri, sha256, contentType, createdByAgentId: actor.id },
          });
          await this.activityService.log(
            {
              workspaceId: task.project.workspaceId,
              taskId,
              actor,
              action: EVIDENCE_ATTACHED_ACTION,
              payload: {
                evidence_id: created.id,
                uri,
                sha256,
                content_type: contentType,
              },
            },
            tx,
          );
          return created;
        },
        { timeout: 10_000, isolationLevel: 'ReadCommitted' },
      );
      return { statusCode: 201, body: present(record, false) };
    } catch (err) {
      // Two concurrent first calls: the unique index picks a winner, and the
      // loser re-reads and answers exactly as a later retry would.
      if (isUniqueViolation(err)) {
        const raced = await this.findRecord(taskId, sha256);
        if (raced) return this.repeat(raced, taskId, sha256, uri, contentType);
      }
      throw err;
    }
  }

  async list(taskId: string): Promise<WorkItemEvidenceList> {
    const rows = await this.prisma.taskEvidenceAttachment.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
    });
    return {
      task_id: taskId,
      total: rows.length,
      evidence: rows.map((r) => present(r)),
    };
  }

  /** A repeat of a digest already on the task: the same claim is the stored
   *  row, a different one is a conflict the caller must be told about. */
  private repeat(
    existing: TaskEvidenceAttachment,
    taskId: string,
    sha256: string,
    uri: string,
    contentType: string,
  ): { statusCode: 200; body: WorkItemEvidenceAttachment } {
    if (existing.uri !== uri || existing.contentType !== contentType) {
      throw digestConflict(
        taskId,
        sha256,
        { uri: existing.uri, contentType: existing.contentType },
        { uri, contentType },
      );
    }
    return { statusCode: 200, body: present(existing, true) };
  }

  private findRecord(taskId: string, sha256: string): Promise<TaskEvidenceAttachment | null> {
    return this.prisma.taskEvidenceAttachment.findUnique({
      where: { taskId_sha256: { taskId, sha256 } },
    });
  }
}

function present(
  r: TaskEvidenceAttachment,
  idempotent?: boolean,
): WorkItemEvidenceAttachment {
  const body: WorkItemEvidenceAttachment = {
    schema: WORK_ITEM_EVIDENCE_SCHEMA,
    evidence_id: r.id,
    task_id: r.taskId,
    uri: r.uri,
    sha256: r.sha256,
    content_type: r.contentType,
    created_by_agent_id: r.createdByAgentId,
    created_at: r.createdAt.toISOString(),
  };
  if (idempotent !== undefined) body.idempotent = idempotent;
  return body;
}

function isUniqueViolation(err: unknown): boolean {
  if (err === null || err === undefined || typeof err !== 'object') return false;
  return (err as { code?: string }).code === 'P2002';
}
