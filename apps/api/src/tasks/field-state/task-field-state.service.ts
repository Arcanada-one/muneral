import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Tracked fields on the Task model.
 * Boot-time assertion (see onModuleInit) verifies each entry is a scalar
 * field present in the Prisma DMMF for Task.
 */
export const TRACKED_FIELDS = [
  'title',
  'description',
  'status',
  'priority',
  'dueDate',
  'estimateHours',
  'sprintId',
] as const;

export type TrackedField = (typeof TRACKED_FIELDS)[number];

/**
 * Special sentinel accepted by field-ack but NOT processed by recompute.
 * Represents the activity-log cursor (pseudo-field).
 */
export const ACTIVITY_SENTINEL = '__activity__';

/** Max optimistic-lock retry attempts before propagating error. */
const MAX_RETRIES = 3;

export type TaskLike = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueDate: string | null;
  estimateHours: unknown; // Prisma Decimal or null
  sprintId: string | null;
};

/**
 * TaskFieldStateService — per-field versioned hash tracker.
 *
 * Maintains a row in task_field_state for each TRACKED_FIELDS entry per task.
 * `recompute(tx, task)` must be called INSIDE a $transaction after task.update.
 * It is idempotent: no-op when the normalized value is unchanged.
 */
@Injectable()
export class TaskFieldStateService implements OnModuleInit {
  private readonly logger = new Logger(TaskFieldStateService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Boot-time assertion: every TRACKED_FIELDS entry must be a scalar field
   * on the Task model according to Prisma DMMF.
   */
  onModuleInit() {
    const taskModel = Prisma.dmmf.datamodel.models.find(
      (m) => m.name === 'Task',
    );
    if (!taskModel) {
      throw new Error('DMMF: Task model not found — schema mismatch');
    }
    const scalarFields = new Set(
      taskModel.fields
        .filter((f) => f.kind === 'scalar' || f.kind === 'enum')
        .map((f) => f.name),
    );
    for (const field of TRACKED_FIELDS) {
      if (!scalarFields.has(field)) {
        throw new Error(
          `TRACKED_FIELDS boot-assert failed: '${field}' is not a scalar field on Task model. ` +
            `Known scalars: ${[...scalarFields].join(', ')}`,
        );
      }
    }
    this.logger.log(
      `TRACKED_FIELDS boot-assert passed (${TRACKED_FIELDS.length} fields)`,
    );
  }

  /**
   * Normalize a raw field value to a canonical string for hashing.
   * - null/undefined → empty string
   * - strings: trim + NFC normalize
   * - enum-like strings (status/priority): lowercased
   * - Decimal/number: String(value)
   */
  normalizeFieldValue(fieldName: string, rawValue: unknown): string {
    if (rawValue === null || rawValue === undefined) {
      return '';
    }
    // Prisma Decimal objects have a toString()
    const str = String(rawValue).trim().normalize('NFC');
    // Enum fields: lowercase
    if (fieldName === 'status' || fieldName === 'priority') {
      return str.toLowerCase();
    }
    return str;
  }

  /** SHA-256 hex digest of a string. */
  sha256(input: string): string {
    return createHash('sha256').update(input, 'utf8').digest('hex');
  }

  /**
   * Recompute field state rows for a task inside an open transaction.
   *
   * @param tx   - Prisma transaction client (from $transaction callback)
   * @param task - Fully-resolved task entity (with defaults applied)
   *
   * For each field in TRACKED_FIELDS:
   *  1. Normalize value + compute hash
   *  2. If row exists and hash is unchanged → skip (no-op)
   *  3. If row missing → create with version=1
   *  4. If hash changed → optimistic updateMany on current version
   *     If count===0 (concurrent writer) → retry up to MAX_RETRIES
   */
  async recompute(
    tx: Prisma.TransactionClient,
    task: TaskLike,
  ): Promise<void> {
    for (const fieldName of TRACKED_FIELDS) {
      const rawValue = task[fieldName as keyof TaskLike];
      const normalized = this.normalizeFieldValue(fieldName, rawValue);
      const hash = this.sha256(normalized);

      await this._recomputeField(tx, task.id, fieldName, hash);
    }
  }

  private async _recomputeField(
    tx: Prisma.TransactionClient,
    taskId: string,
    fieldName: string,
    hash: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const cur = await tx.taskFieldState.findUnique({
        where: { taskId_fieldName: { taskId, fieldName } },
      });

      if (cur && cur.hash === hash) {
        // No change — skip
        return;
      }

      if (!cur) {
        // First write
        try {
          await tx.taskFieldState.create({
            data: { taskId, fieldName, hash, version: 1n },
          });
          return;
        } catch (err: unknown) {
          // P2002 = unique constraint — concurrent create, retry
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2002'
          ) {
            continue;
          }
          throw err;
        }
      }

      // Optimistic update on current version
      const result = await tx.taskFieldState.updateMany({
        where: {
          taskId,
          fieldName,
          version: cur.version,
        },
        data: {
          hash,
          version: cur.version + 1n,
        },
      });

      if (result.count === 0) {
        // Concurrent writer took the version — retry
        continue;
      }
      return;
    }

    // All retries exhausted
    throw new Error(
      `field-state optimistic lock failed after ${MAX_RETRIES} retries: taskId=${taskId} field=${fieldName}`,
    );
  }
}
