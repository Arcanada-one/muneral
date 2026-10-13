import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma, TaskArtifactRevision } from '@prisma/client';
import type { Actor } from '@muneral/types';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ActivityService } from '../../activity/activity.service.js';
import { ArtifactMetadataDto, UploadArtifactDto, StoreGraphDto } from './task-content.dto.js';
import { humanTaskWhere } from '../../auth/human-task-visibility.js';
import type { GraphDocument, GraphKind } from './task-graph.schema.js';
import { parseGraph, validateGraphReferences } from './task-graph.validation.js';

export const MAX_CONTENT_BYTES = 1024 * 1024;
const MAX_JSON_CONTENT_BYTES = 65536;
const MAX_TASK_BYTES = 16 * 1024 * 1024;
const MAX_TASK_REVISIONS = 1000;
export const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function decodeArtifact(dto: UploadArtifactDto): Buffer {
  const bytes = Buffer.from(dto.contentBase64, 'base64');
  if (bytes.toString('base64') !== dto.contentBase64) throw new BadRequestException('Canonical base64 required');
  if (bytes.length > MAX_JSON_CONTENT_BYTES) throw new PayloadTooLargeException('JSON artifact exceeds 64 KiB; use the bytes route');
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

function graphKind(kind: string): GraphKind {
  if (kind !== 'task_graph' && kind !== 'agent_graph') throw new BadRequestException('Unknown graph kind');
  return kind;
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

  /** TZ638: the whole work item and owned bytes, from one database snapshot. */
  open(taskId: string, actor: Actor) {
    return this.prisma.$transaction(async tx => {
      const custody = await this.authorize(tx, taskId, actor);
      const [task, chronology, checklist, agents, attempts, evidence, content, dependencies] = await Promise.all([
        tx.task.findUniqueOrThrow({ where: { id: taskId } }),
        tx.activityLog.findMany({ where: { taskId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
        tx.taskChecklist.findMany({ where: { taskId }, orderBy: [{ position: 'asc' }, { id: 'asc' }] }),
        tx.taskAgent.findMany({ where: { taskId }, orderBy: { agentId: 'asc' }, select: {
          agentId: true, role: true, assignedAt: true,
          agent: { select: { id: true, name: true, workspaceId: true } },
        } }),
        tx.taskExecutionAttempt.findMany({ where: { taskId }, orderBy: { ordinal: 'asc' } }),
        tx.taskEvidenceAttachment.findMany({ where: { taskId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
        tx.taskArtifactRevision.findMany({ where: { taskId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
        tx.taskDependency.findMany({ where: { OR: [{ fromTaskId: taskId }, { toTaskId: taskId }] }, orderBy: { id: 'asc' } }),
      ]);
      if (chronology.some(row => row.workspaceId !== custody.project.workspaceId) ||
          agents.some(row => row.agent.workspaceId !== custody.project.workspaceId)) {
        throw new ConflictException('WORK_ITEM_CUSTODY_MISMATCH');
      }
      // A dependency is disclosed only if this credential can read BOTH ends.
      const endpointIds = [...new Set([taskId, ...dependencies.flatMap(row => [row.fromTaskId, row.toTaskId])])];
      const endpoints = [];
      for (const id of endpointIds) {
        await this.authorize(tx, id, actor);
        endpoints.push(await tx.task.findUniqueOrThrow({ where: { id }, select: { id: true, title: true, status: true, projectId: true } }));
      }
      for (const row of content) {
        if (row.sizeBytes !== row.content.length || digest(row.content) !== row.sha256) {
          throw new ConflictException('STORED_CONTENT_DIGEST_MISMATCH');
        }
      }
      const graphs = Object.fromEntries((['task_graph', 'agent_graph'] as const).map(kind => {
        const revisions = content.filter(row => row.kind === kind).sort((a, b) => a.revision - b.revision)
          .map(row => ({ ...present(row, true), document: JSON.parse(Buffer.from(row.content).toString('utf8')) as unknown }));
        return [kind, { state: revisions.length ? 'present' : 'absent', latestRevision: revisions.at(-1)?.revision ?? null, revisions }];
      }));
      const artifacts = content.filter(row => row.kind === 'artifact').map(row => present(row, true));
      const evidenceWithAvailability = evidence.map(row => ({ ...row,
        availability: content.some(revision => revision.evidenceId === row.id) ? 'server_content' : 'legacy_pointer',
      }));
      return { schema: 'WorkItemOpen/v1', task, chronology, checklist, agents, attempts,
        artifacts, graphs, evidence: evidenceWithAvailability,
        dependencyGraph: { source: 'native_TaskDependency', nodes: endpoints, edges: dependencies },
        completeness: { complete: true, snapshot: 'repeatable_read', contentIntegrity: 'verified',
          counts: { chronology: chronology.length, checklist: checklist.length, agents: agents.length,
            attempts: attempts.length, evidence: evidence.length, artifacts: artifacts.length,
            contentRevisions: content.length, dependencies: dependencies.length } },
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 10000 });
  }

  uploadBytes(taskId: string, actor: Actor, dto: ArtifactMetadataDto, bytes: Buffer | undefined) {
    if (!Buffer.isBuffer(bytes)) throw new BadRequestException('One content file is required');
    if (dto.sha256 !== undefined && dto.sha256 !== digest(bytes)) throw new BadRequestException('ARTIFACT_DIGEST_MISMATCH');
    return this.store(taskId, actor, 'artifact', dto.name, dto.contentType, bytes);
  }

  storeGraph(taskId: string, actor: Actor, kind: string, dto: StoreGraphDto) {
    const document = parseGraph(graphKind(kind), taskId, dto.expectedRevision, dto.document);
    const bytes = Buffer.from(JSON.stringify(document), 'utf8');
    if (bytes.length > MAX_JSON_CONTENT_BYTES) throw new PayloadTooLargeException('Graph document exceeds 64 KiB');
    return this.store(taskId, actor, kind, 'graph', 'application/json', bytes, { expectedRevision: dto.expectedRevision, document });
  }

  async getGraph(taskId: string, actor: Actor, kind: string, revision?: number) {
    graphKind(kind);
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new BadRequestException('Invalid graph revision');
    return this.prisma.$transaction(async tx => {
      await this.authorize(tx, taskId, actor);
      const row = await tx.taskArtifactRevision.findFirst({ where: { taskId, kind, name: 'graph', ...(revision === undefined ? {} : { revision }) }, orderBy: { revision: 'desc' } });
      if (!row) throw new NotFoundException('Graph document revision not found');
      if (digest(row.content) !== row.sha256) throw new ConflictException('STORED_CONTENT_DIGEST_MISMATCH');
      return { ...present(row, true), document: JSON.parse(Buffer.from(row.content).toString('utf8')) as unknown };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  listGraphs(taskId: string, actor: Actor, kind: string, page: number) {
    graphKind(kind);
    return this.list(taskId, actor, kind, page);
  }

  private async store(taskId: string, actor: Actor, kind: string, name: string, contentType: string, bytes: Buffer,
    graph?: { expectedRevision: number; document: GraphDocument }) {
    if (bytes.length > MAX_CONTENT_BYTES) throw new PayloadTooLargeException('Content exceeds 1 MiB');
    if (actor.type !== 'agent') throw new ForbiddenException('Artifact uploads require an assigned agent key');
    const sha256 = digest(bytes);
    return this.prisma.$transaction(async tx => {
      // One task lock serializes revision allocation and quota checks across all content kinds.
      await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${taskId}::uuid FOR UPDATE`;
      const task = await this.authorize(tx, taskId, actor);
      const last = await tx.taskArtifactRevision.findFirst({ where: { taskId, kind, name }, orderBy: { revision: 'desc' } });
      if (graph) {
        if ((last?.revision ?? 0) !== graph.expectedRevision) throw new ConflictException('GRAPH_REVISION_CONFLICT');
        await validateGraphReferences(tx, graph.document);
      }
      if (last?.sha256 === sha256) {
        if (last.contentType !== contentType) throw new ConflictException('CONTENT_DIGEST_CONFLICT');
        return { ...present(last), idempotent: true };
      }
      const usage = await tx.taskArtifactRevision.aggregate({ where: { taskId }, _sum: { sizeBytes: true }, _count: true });
      if ((usage._sum.sizeBytes ?? 0) + bytes.length > MAX_TASK_BYTES || usage._count >= MAX_TASK_REVISIONS) {
        throw new PayloadTooLargeException('Task content quota exceeded (16 MiB / 1000 revisions)');
      }
      let evidence = await tx.taskEvidenceAttachment.findUnique({ where: { taskId_sha256: { taskId, sha256 } } });
      if (evidence && evidence.contentType !== contentType) throw new ConflictException('CONTENT_DIGEST_CONFLICT');
      if (!evidence) evidence = await tx.taskEvidenceAttachment.create({ data: { taskId, sha256, contentType,
        uri: kind === 'artifact' ? `muneral://tasks/${taskId}/artifacts/by-sha/${sha256}` : `muneral://tasks/${taskId}/graphs/${kind}/${graph!.document.graph_revision}`, createdByAgentId: actor.id } });
      const row = await tx.taskArtifactRevision.create({ data: { taskId, evidenceId: evidence.id, kind, name, contentType, content: new Uint8Array(bytes),
        sha256, sizeBytes: bytes.length, revision: (last?.revision ?? 0) + 1, actorType: actor.type, actorId: actor.id } });
      await this.activity.log({ workspaceId: task.project.workspaceId, taskId, actor, action: 'task:content_uploaded',
        payload: { id: row.id, kind, name, revision: row.revision, sha256, sizeBytes: bytes.length } }, tx);
      return { ...present(row), idempotent: false };
    }, { timeout: 10000 });
  }

  async list(taskId: string, actor: Actor, kind: string, page = 1) {
    if (kind !== 'artifact') graphKind(kind);
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
    // ReadArtifact(ref) also resolves typed graph content by its immutable ID/hash.
    const row = await this.prisma.taskArtifactRevision.findFirst({ where: { taskId, ...(bySha ? { sha256: value } : { id: value }) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    if (!row) throw new NotFoundException('Task content revision not found');
    if (digest(row.content) !== row.sha256) throw new ConflictException('STORED_CONTENT_DIGEST_MISMATCH');
    return present(row, true);
  }

}
