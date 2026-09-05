// MUN-0040 (AUP-DAT-002 / AUP-DAT-003): typed error bodies for the migration
// import surface.
//
// Every failure the caller can act on carries a machine-readable `code`, so an
// unattended importer can branch on it without parsing prose. Each factory
// returns a NestJS HttpException whose response body is `{code, message, ...}`.

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';

export const MIGRATION_ERROR_CODES = [
  'BATCH_KEY_CONFLICT',
  'BATCH_NOT_FOUND',
  'BATCH_NOT_OPEN',
  'BOOTSTRAP_STAMP_IMMUTABLE',
  'BOOTSTRAP_STAMP_INVALID',
  'IDEMPOTENCY_KEY_CONFLICT',
  'INVALID_IDENTITY_DECISION',
  'IDENTITY_NOT_FOUND',
  'INVALID_STATUS_TRANSITION',
  'MAPPING_REVISION_STALE',
  'PROJECT_NOT_FOUND',
  'RAW_EXCERPT_TOO_LARGE',
  'STALE_REVISION',
  'UNKNOWN_STATUS_MAP_REVISION',
  'WORK_ITEM_NOT_FOUND',
] as const;

export type MigrationErrorCode = (typeof MIGRATION_ERROR_CODES)[number];

/** Same batch key, different request payload. The key is the unit of
 *  idempotency, so a changed payload under a reused key is a caller bug. */
export function batchKeyConflict(batchKey: string): ConflictException {
  return new ConflictException({
    code: 'BATCH_KEY_CONFLICT' satisfies MigrationErrorCode,
    message: `Batch key "${batchKey}" already exists with a different request payload.`,
    batchKey,
  });
}

export function batchNotFound(batchId: string): NotFoundException {
  return new NotFoundException({
    code: 'BATCH_NOT_FOUND' satisfies MigrationErrorCode,
    message: `Migration batch "${batchId}" does not exist.`,
    batchId,
  });
}

/** MIG-003: the bootstrap stamp is an immutable provenance receipt. */
/** A committed batch's receipt is write-once, so admitting a late occurrence
 *  would leave the receipt permanently understating the batch it describes. */
export function batchNotOpen(batchId: string, status: string): ConflictException {
  return new ConflictException({
    code: 'BATCH_NOT_OPEN' satisfies MigrationErrorCode,
    message:
      `Migration batch "${batchId}" is ${status}, not open. Its commit receipt is ` +
      'write-once, so it can accept no further occurrences; open a new batch.',
    batchId,
    status,
  });
}

export function bootstrapStampImmutable(taskId: string): ConflictException {
  return new ConflictException({
    code: 'BOOTSTRAP_STAMP_IMMUTABLE' satisfies MigrationErrorCode,
    message:
      `Work item "${taskId}" already carries a bootstrap stamp. ` +
      'The stamp is a write-once provenance receipt and cannot be replaced.',
    taskId,
  });
}

/** MIG-003 says the stamp is BOUNDED. Rejected here with a clear reason rather
 *  than left to surface as a raw CHECK-constraint failure from the database. */
export function bootstrapStampInvalid(reason: string): BadRequestException {
  return new BadRequestException({
    code: 'BOOTSTRAP_STAMP_INVALID' satisfies MigrationErrorCode,
    message: `bootstrapStamp is not a valid bounded provenance receipt: ${reason}`,
    reason,
  });
}

/** Same idempotency key, different request payload — the replay store cannot
 *  answer it, and inventing a second write would defeat the key. */
export function idempotencyKeyConflict(
  scope: string,
  idempotencyKey: string,
): ConflictException {
  return new ConflictException({
    code: 'IDEMPOTENCY_KEY_CONFLICT' satisfies MigrationErrorCode,
    message:
      `Idempotency key "${idempotencyKey}" was already used in scope "${scope}" ` +
      'with a different request payload.',
    scope,
    idempotencyKey,
  });
}

export function invalidIdentityDecision(reason: string): BadRequestException {
  return new BadRequestException({
    code: 'INVALID_IDENTITY_DECISION' satisfies MigrationErrorCode,
    message: `The identity decision is not well-formed: ${reason}`,
    reason,
  });
}

export function identityNotFound(identityId: string): NotFoundException {
  return new NotFoundException({
    code: 'IDENTITY_NOT_FOUND' satisfies MigrationErrorCode,
    message: `Legacy identity "${identityId}" does not exist.`,
    identityId,
  });
}

export function invalidStatusTransition(
  fromStatus: string,
  toStatus: string,
): BadRequestException {
  return new BadRequestException({
    code: 'INVALID_STATUS_TRANSITION' satisfies MigrationErrorCode,
    message: `"${fromStatus}" -> "${toStatus}" is not a valid task status transition.`,
    fromStatus,
    toStatus,
  });
}

export function mappingRevisionStale(
  identityId: string,
  currentMappingRevision: number,
): ConflictException {
  return new ConflictException({
    code: 'MAPPING_REVISION_STALE' satisfies MigrationErrorCode,
    message:
      `Identity "${identityId}" has moved on; re-read it and retry the decision ` +
      `against mapping revision ${currentMappingRevision}.`,
    identityId,
    currentMappingRevision,
  });
}

/** MUN-0043: the caller pinned a HistoricalStatusMap revision this build does
 *  not vendor. Refused rather than served under the current revision: the
 *  revision IS the provenance claim, and answering with a different one would
 *  file a projection under a rule that never produced it. */
export function unknownStatusMapRevision(
  requested: number,
  supported: readonly number[],
): BadRequestException {
  return new BadRequestException({
    code: 'UNKNOWN_STATUS_MAP_REVISION' satisfies MigrationErrorCode,
    message:
      `Status map revision ${requested} is not vendored in this build. ` +
      `Available revisions: ${supported.join(', ')}.`,
    requestedRevision: requested,
    supportedRevisions: [...supported],
  });
}

export function projectNotFound(projectId: string): NotFoundException {
  return new NotFoundException({
    code: 'PROJECT_NOT_FOUND' satisfies MigrationErrorCode,
    message: `Project "${projectId}" does not exist.`,
    projectId,
  });
}

/** The excerpt bound is in BYTES, because that is what the CHECK counts. A
 *  character bound would pass ~9 000 characters of Cyrillic straight into an
 *  untyped constraint failure. */
export function rawExcerptTooLarge(bytes: number, bound: number): BadRequestException {
  return new BadRequestException({
    code: 'RAW_EXCERPT_TOO_LARGE' satisfies MigrationErrorCode,
    message: `occurrence.rawExcerpt is ${bytes} bytes, over the ${bound}-byte bound.`,
    bytes,
    bound,
  });
}

/**
 * Compare-and-set failure.
 *
 * The CAS covers the OBSERVED STATE, not just the counter: `tasks.revision` is
 * bumped by this path alone, so an ordinary `PATCH /tasks/:id/status` moves the
 * status while leaving the revision untouched. Guarding on the revision only
 * would let a migration transition silently overwrite an operator's decision —
 * and even take a move the task state machine forbids. The current status is
 * therefore reported alongside the revision so the caller can retry correctly.
 */
export function staleRevision(
  taskId: string,
  currentRevision: number,
  currentStatus: string,
): ConflictException {
  return new ConflictException({
    code: 'STALE_REVISION' satisfies MigrationErrorCode,
    message:
      `Work item "${taskId}" has moved on; re-read it and retry against ` +
      `revision ${currentRevision} and status "${currentStatus}".`,
    taskId,
    currentRevision,
    currentStatus,
  });
}

export function workItemNotFound(where: {
  taskId?: string;
  sourceNamespace?: string;
  legacyId?: string;
}): NotFoundException {
  const subject = where.taskId
    ? `Work item "${where.taskId}"`
    : `Work item for ("${where.sourceNamespace}", "${where.legacyId}")`;
  return new NotFoundException({
    code: 'WORK_ITEM_NOT_FOUND' satisfies MigrationErrorCode,
    message: `${subject} does not exist.`,
    ...where,
  });
}
