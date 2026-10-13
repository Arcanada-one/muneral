import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma, TaskArtifactRevision } from '@prisma/client';
import type { Actor } from '@muneral/types';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ActivityService } from '../../activity/activity.service.js';
import { UploadArtifactDto } from './task-content.dto.js';
import { humanTaskWhere } from '../../auth/human-task-visibility.js';

export const MAX_CONTENT_BYTES = 262144;
const MAX_TASK_BYTES = 16 * 1024 * 1024;
const MAX_TASK_REVISIONS = 1000;
export const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function decodeArtifact(dto: UploadArtifactDto): Buffer {
  const bytes = Buffer.from(dto.contentBase64, 'base64');
  if (bytes.toString('base64') !== dto.contentBase64) throw new BadRequestException('Canonical base64 required');
  if (bytes.length > MAX_CONTENT_BYTES) throw new PayloadTooLargeException('Artifact exceeds 256 KiB');
  if (dto.sha256 !== undefined && dto.sha256 !== digest(bytes)) throw new BadRequestException('ARTIFACT_DIGEST_MISMATCH');
  return bytes;
}

function present(row: TaskArtifactRevision, includeContent = false) {
  return {
    schema: 'WorkItemContentRevision/v1', id: row.id, taskId: row.taskId, kind: row.kind,
    name: row.name, revision: row.revision, sha256: row.sha256, contentType: row.contentType,
    sizeBytes: row.sizeBytes, actorType: row.actorType, actorId: row.actorId, createdAt: row.createdAt.toISOString(),
    ...(includeContent ? { contentBase64: Buffer.from(row.content).toString('base64') } : {}),
  };
}

@Injectable()
export class TaskContentService {
  constructor(private readonly prisma: PrismaService, private readonly activity: ActivityService) {}

  /** Recheck credential-derived membership inside the transaction/read, independent of route guard. */
  private async authorize(tx: Prisma.TransactionClient, taskId: string, actor: Actor) {
    const where: Prisma.TaskWhereInput = actor.type === 'human' ? { id: taskId, ...humanTaskWhere(actor.id) } : {
      id: taskId, agents: { some: { agentId: actor.id } },
      project: { workspace: { agents: { some: { id: actor.id } } } },
    };
    const task = await tx.task.findFirst({ where, select: { id: true, project: { select: { workspaceId: true } } } });
    if (!task) throw new ForbiddenException('Task content is outside credential scope');
    return task;
  }

  uploadArtifact(taskId: string, actor: Actor, dto: UploadArtifactDto) {
    return this.store(taskId, actor, 'artifact', dto.name, dto.contentType, decodeArtifact(dto));
  }

  private async store(taskId: string, actor: Actor, kind: string, name: string, contentType: string, bytes: Buffer) {
    if (bytes.length > MAX_CONTENT_BYTES) throw new PayloadTooLargeException('Content exceeds 256 KiB');
    if (actor.type !== 'agent') throw new ForbiddenException('Artifact uploads require an assigned agent key');
    const sha256 = digest(bytes);
    return this.prisma.$transaction(async tx => {
      // One task lock serializes revision allocation and quota checks across all content kinds.
      await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${taskId}::uuid FOR UPDATE`;
      const task = await this.authorize(tx, taskId, actor);
      const existing = await tx.taskArtifactRevision.findUnique({ where: { taskId_kind_name_sha256: { taskId, kind, name, sha256 } } });
      if (existing) {
        if (existing.contentType !== contentType) throw new ConflictException('CONTENT_DIGEST_CONFLICT');
        return { ...present(existing), idempotent: true };
      }
      const usage = await tx.taskArtifactRevision.aggregate({ where: { taskId }, _sum: { sizeBytes: true }, _count: true });
      if ((usage._sum.sizeBytes ?? 0) + bytes.length > MAX_TASK_BYTES || usage._count >= MAX_TASK_REVISIONS) {
        throw new PayloadTooLargeException('Task content quota exceeded (16 MiB / 1000 revisions)');
      }
      const last = await tx.taskArtifactRevision.findFirst({ where: { taskId, kind, name }, orderBy: { revision: 'desc' }, select: { revision: true } });
      let evidence = await tx.taskEvidenceAttachment.findUnique({ where: { taskId_sha256: { taskId, sha256 } } });
      if (evidence && evidence.contentType !== contentType) throw new ConflictException('CONTENT_DIGEST_CONFLICT');
      if (!evidence) evidence = await tx.taskEvidenceAttachment.create({ data: { taskId, sha256, contentType,
        uri: `muneral://tasks/${taskId}/artifacts/by-sha/${sha256}`, createdByAgentId: actor.id } });
      const row = await tx.taskArtifactRevision.create({ data: { taskId, evidenceId: evidence.id, kind, name, contentType, content: new Uint8Array(bytes),
        sha256, sizeBytes: bytes.length, revision: (last?.revision ?? 0) + 1, actorType: actor.type, actorId: actor.id } });
      await this.activity.log({ workspaceId: task.project.workspaceId, taskId, actor, action: 'task:content_uploaded',
        payload: { id: row.id, kind, name, revision: row.revision, sha256, sizeBytes: bytes.length } }, tx);
      return { ...present(row), idempotent: false };
    }, { timeout: 10000 });
  }

  async list(taskId: string, actor: Actor, kind: string, page = 1) {
    if (kind !== 'artifact') throw new BadRequestException('Unknown content kind');
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new BadRequestException('Invalid page');
    await this.authorize(this.prisma, taskId, actor);
    const where = { taskId, kind };
    const [rows, total] = await Promise.all([
      this.prisma.taskArtifactRevision.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: (page - 1) * 100, take: 100 }),
      this.prisma.taskArtifactRevision.count({ where }),
    ]);
    return { taskId, kind, total, page, nextPage: page * 100 < total ? page + 1 : null, data: rows.map(r => present(r)) };
  }

  async get(taskId: string, actor: Actor, kind: string, value: string, bySha = false) {
    if (kind !== 'artifact') throw new BadRequestException('Unknown content kind');
    await this.authorize(this.prisma, taskId, actor);
    const row = await this.prisma.taskArtifactRevision.findFirst({ where: { taskId, kind, ...(bySha ? { sha256: value } : { id: value }) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    if (!row) throw new NotFoundException('Task content revision not found');
    if (digest(row.content) !== row.sha256) throw new ConflictException('STORED_CONTENT_DIGEST_MISMATCH');
    return present(row, true);
  }

}
