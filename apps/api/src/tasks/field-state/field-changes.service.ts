import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  TRACKED_FIELDS,
  ACTIVITY_SENTINEL,
} from './task-field-state.service';

export interface FieldChangesQuery {
  taskId: string;
  agentId: string;
}

export interface FieldChangeEntry {
  field: string;
  version: number;
  hash: string;
  value: string | null;
  changed: boolean;
}

export interface ActivityEntry {
  field: typeof ACTIVITY_SENTINEL;
  changed: boolean;
  latestActivityId: string | null;
  lastSeenActivityId: string | null;
}

export interface FieldChangesResponse {
  taskId: string;
  etag: string;
  fields: FieldChangeEntry[];
  activity: ActivityEntry;
}

export interface AckField {
  field: string;
  version: number;
}

export interface AckBody {
  agentId: string;
  fields: AckField[];
}

@Injectable()
export class FieldChangesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /tasks/:taskId/field-changes?agentId=X
   * Returns per-field change status for the agent.
   * changed=true when version > agent's lastSeenVersion, or field never acked.
   */
  async getFieldChanges(query: FieldChangesQuery): Promise<FieldChangesResponse> {
    const { taskId, agentId } = query;

    // Verify task exists
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException('Task not found');
    }

    // Fetch all field state rows for this task
    const fieldStates = await this.prisma.taskFieldState.findMany({
      where: { taskId },
    });
    const fieldStateMap = new Map(
      fieldStates.map((fs) => [fs.fieldName, fs]),
    );

    // Fetch agent's read receipts for this task
    const agentReads = await this.prisma.agentFieldRead.findMany({
      where: { agentId, taskId },
    });
    const agentReadMap = new Map(
      agentReads.map((r) => [r.fieldName, r]),
    );

    // Build field entries for TRACKED_FIELDS
    const fields: FieldChangeEntry[] = TRACKED_FIELDS.map((fieldName) => {
      const state = fieldStateMap.get(fieldName);
      const agentRead = agentReadMap.get(fieldName);

      const version = state ? Number(state.version) : 0;
      const hash = state?.hash ?? '';
      const rawVal = task[fieldName as keyof typeof task];
      const value =
        rawVal === null || rawVal === undefined ? null : String(rawVal);
      const lastSeen = agentRead ? Number(agentRead.lastSeenVersion) : -1;
      const changed = version > lastSeen;

      return { field: fieldName, version, hash, value, changed };
    });

    // Activity pseudo-entry: latest activity_log entry for this task
    // lastSeenActivityId stored in agentFieldRead.lastSeenHash for the sentinel row
    const latestActivity = await this.prisma.activityLog.findFirst({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    const agentActivityRead = agentReadMap.get(ACTIVITY_SENTINEL);
    // lastSeenHash doubles as lastSeenActivityId for the sentinel row
    const lastSeenActivityId = agentActivityRead?.lastSeenHash ?? null;
    const activityEntry: ActivityEntry = {
      field: ACTIVITY_SENTINEL,
      changed:
        latestActivity !== null &&
        lastSeenActivityId !== latestActivity.id,
      latestActivityId: latestActivity?.id ?? null,
      lastSeenActivityId,
    };

    // ETag: SHA-256 of sorted field:version pairs
    const etag = this._computeEtag(fields);

    return { taskId, etag, fields, activity: activityEntry };
  }

  /**
   * POST /tasks/:taskId/field-ack
   * Upsert agent_field_reads for the given fields.
   * IDOR guard: agentId must equal req.apiKeyAgent.id (enforced in controller).
   */
  async ackFields(
    taskId: string,
    requestingAgentId: string,
    body: AckBody,
  ): Promise<void> {
    // IDOR guard
    if (body.agentId !== requestingAgentId) {
      throw new ForbiddenException(
        'agentId in body must match the authenticated agent',
      );
    }

    // Verify task exists
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException('Task not found');
    }

    // Validate fields — must be in TRACKED_FIELDS or the activity sentinel
    const allowed = new Set<string>([...TRACKED_FIELDS, ACTIVITY_SENTINEL]);
    for (const { field } of body.fields) {
      if (!allowed.has(field)) {
        throw new BadRequestException(
          `Unknown or untracked field: '${field}'. Allowed: ${[...allowed].join(', ')}`,
        );
      }
    }

    // Upsert each field read receipt
    for (const { field, version } of body.fields) {
      if (field === ACTIVITY_SENTINEL) {
        // For __activity__: fetch the latest activity entry and store its ID in lastSeenHash
        const latestActivity = await this.prisma.activityLog.findFirst({
          where: { taskId },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        const activityId = latestActivity?.id ?? '';

        await this.prisma.agentFieldRead.upsert({
          where: {
            agentId_taskId_fieldName: {
              agentId: body.agentId,
              taskId,
              fieldName: field,
            },
          },
          create: {
            agentId: body.agentId,
            taskId,
            fieldName: field,
            lastSeenVersion: BigInt(version),
            lastSeenHash: activityId, // stores latest activity ID as cursor
            acknowledgedAt: new Date(),
          },
          update: {
            lastSeenVersion: BigInt(version),
            lastSeenHash: activityId,
            acknowledgedAt: new Date(),
          },
        });
      } else {
        // Regular tracked field — fetch current hash from field_state
        const state = await this.prisma.taskFieldState.findUnique({
          where: { taskId_fieldName: { taskId, fieldName: field } },
        });

        await this.prisma.agentFieldRead.upsert({
          where: {
            agentId_taskId_fieldName: {
              agentId: body.agentId,
              taskId,
              fieldName: field,
            },
          },
          create: {
            agentId: body.agentId,
            taskId,
            fieldName: field,
            lastSeenVersion: BigInt(version),
            lastSeenHash: state?.hash ?? '',
            acknowledgedAt: new Date(),
          },
          update: {
            lastSeenVersion: BigInt(version),
            lastSeenHash: state?.hash ?? '',
            acknowledgedAt: new Date(),
          },
        });
      }
    }
  }

  /**
   * Compute ETag for GET /tasks/:taskId (ETag = SHA-256 of sorted field:version pairs).
   */
  async computeTaskEtag(taskId: string): Promise<string | null> {
    const fieldStates = await this.prisma.taskFieldState.findMany({
      where: { taskId },
    });
    if (fieldStates.length === 0) return null;

    const pairs = [...fieldStates]
      .sort((a, b) => a.fieldName.localeCompare(b.fieldName))
      .map((fs) => `${fs.fieldName}:${fs.version}`)
      .join('|');

    return createHash('sha256').update(pairs, 'utf8').digest('hex');
  }

  private _computeEtag(fields: FieldChangeEntry[]): string {
    const pairs = [...fields]
      .sort((a, b) => a.field.localeCompare(b.field))
      .map((f) => `${f.field}:${f.version}`)
      .join('|');
    return createHash('sha256').update(pairs, 'utf8').digest('hex');
  }
}
