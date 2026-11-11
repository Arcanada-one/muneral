/**
 * PROPOSAL ONLY — TaskActivitySnapshot cursor / page contract helpers.
 *
 * This module is not imported by any Nest controller, module, or Prisma writer.
 * It exists so G01 Q3 can pin a typed request/response + refusal surface with
 * positive and refuting unit tests before an owner-approved route exists.
 *
 * Muneral task: 350b8ad2-45a4-4fae-82d1-1af3229fdf16
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const TASK_ACTIVITY_SNAPSHOT_PAGE_SCHEMA = 'TaskActivitySnapshotPage/v1' as const;
export const TASK_ACTIVITY_SNAPSHOT_CURSOR_MAX_BYTES = 512;
export const TASK_ACTIVITY_SNAPSHOT_DEFAULT_PAGE_SIZE = 100;
export const TASK_ACTIVITY_SNAPSHOT_PROPOSAL_MAX_PAGE_SIZE = 500;
export const TASK_ACTIVITY_SNAPSHOT_PROPOSAL_MAX_ROWS = 10_000;
export const TASK_ACTIVITY_SNAPSHOT_CURSOR_TTL_MS = 900_000;

export type SnapshotProposalConsistency = 'repeatable-read' | 'seq-prefix';
export type SnapshotProposalOrder = 'created_at_desc_id_desc' | 'task_seq_asc';

export type SnapshotProposalErrorCode =
  | 'PAGE_SIZE_INVALID'
  | 'CURSOR_MALFORMED'
  | 'NOT_AUTHORIZED'
  | 'TASK_NOT_FOUND'
  | 'SNAPSHOT_CHANGED'
  | 'CURSOR_EXPIRED'
  | 'TASK_DELETED'
  | 'SNAPSHOT_TOO_LARGE'
  | 'SNAPSHOT_UNAVAILABLE';

export class TaskActivitySnapshotProposalError extends Error {
  readonly code: SnapshotProposalErrorCode;
  readonly retryable: boolean;

  constructor(code: SnapshotProposalErrorCode, detail: string, retryable = false) {
    super(detail);
    this.name = 'TaskActivitySnapshotProposalError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface SnapshotHighWater {
  readonly task_seq: number | null;
  readonly kb_revision: number;
  readonly task_deleted: boolean;
}

export interface SnapshotCursorClaims {
  readonly snapshot_id: string;
  readonly task_id: string;
  readonly epoch: number;
  readonly high_water: SnapshotHighWater;
  readonly last_position: number;
  readonly last_seq: number | null;
  readonly key_id_hash: string;
  readonly expires_at_ms: number;
}

export interface SnapshotActivityRow {
  readonly id: string;
  readonly created_at: string;
  readonly task_seq: number | null;
  readonly position: number;
}

export interface SnapshotPageRequest {
  readonly task_id: string;
  readonly page_size?: number;
  readonly cursor?: string;
  readonly expected_digest?: string;
}

export interface SnapshotAuthorization {
  readonly authorized: boolean;
  readonly key_id_hash: string;
}

export interface SnapshotOpenState {
  readonly snapshot_id: string;
  readonly task_id: string;
  readonly epoch: number;
  readonly consistency: SnapshotProposalConsistency;
  readonly order: SnapshotProposalOrder;
  readonly high_water: SnapshotHighWater;
  readonly digest: string;
  readonly rows: readonly SnapshotActivityRow[];
  readonly captured_at_ms: number;
}

export interface SnapshotPageResponse {
  readonly schema: typeof TASK_ACTIVITY_SNAPSHOT_PAGE_SCHEMA;
  readonly snapshot_id: string;
  readonly task_id: string;
  readonly consistency: SnapshotProposalConsistency;
  readonly order: SnapshotProposalOrder;
  readonly high_water: SnapshotHighWater;
  readonly page: number;
  readonly total_pages: number;
  readonly page_size: number;
  readonly total: number;
  readonly rows: readonly SnapshotActivityRow[];
  readonly has_more: boolean;
  readonly next_cursor: string | null;
  readonly digest: string;
}

function fail(code: SnapshotProposalErrorCode, detail: string, retryable = false): never {
  throw new TaskActivitySnapshotProposalError(code, detail, retryable);
}

function encodeClaims(claims: SnapshotCursorClaims): string {
  return Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
}

function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Sign opaque cursor bytes. Production would use a rotated server secret. */
export function signSnapshotCursor(claims: SnapshotCursorClaims, secret: string): string {
  const payload = encodeClaims(claims);
  const cursor = `${payload}.${signPayload(payload, secret)}`;
  if (Buffer.byteLength(cursor, 'utf8') > TASK_ACTIVITY_SNAPSHOT_CURSOR_MAX_BYTES) {
    fail('CURSOR_MALFORMED', 'signed cursor exceeds 512 bytes');
  }
  return cursor;
}

export function verifySnapshotCursor(
  cursor: string,
  secret: string,
  nowMs: number,
  expectedTaskId: string,
  expectedKeyIdHash: string,
): SnapshotCursorClaims {
  if (Buffer.byteLength(cursor, 'utf8') > TASK_ACTIVITY_SNAPSHOT_CURSOR_MAX_BYTES) {
    fail('CURSOR_MALFORMED', 'cursor exceeds 512 bytes');
  }
  const parts = cursor.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    fail('CURSOR_MALFORMED', 'cursor must be payload.signature');
  }
  const [payload, signature] = parts;
  const expected = signPayload(payload, secret);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    fail('CURSOR_MALFORMED', 'cursor signature invalid');
  }

  let claims: SnapshotCursorClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SnapshotCursorClaims;
  } catch {
    fail('CURSOR_MALFORMED', 'cursor payload is not JSON');
  }

  if (claims.task_id !== expectedTaskId) {
    fail('NOT_AUTHORIZED', 'cursor task_id does not match path task');
  }
  if (claims.key_id_hash !== expectedKeyIdHash) {
    fail('NOT_AUTHORIZED', 'cursor key binding does not match caller');
  }
  if (nowMs > claims.expires_at_ms) {
    fail('CURSOR_EXPIRED', 'cursor past expires_at');
  }
  return claims;
}

export function normalizePageSize(pageSize: number | undefined): number {
  const value = pageSize === undefined ? TASK_ACTIVITY_SNAPSHOT_DEFAULT_PAGE_SIZE : pageSize;
  if (!Number.isInteger(value) || value < 1 || value > TASK_ACTIVITY_SNAPSHOT_PROPOSAL_MAX_PAGE_SIZE) {
    fail('PAGE_SIZE_INVALID', `page_size must be an integer in 1..${TASK_ACTIVITY_SNAPSHOT_PROPOSAL_MAX_PAGE_SIZE}`);
  }
  return value;
}

/**
 * Sort helper matching the codec requirement: created_at DESC, id DESC.
 * Used by proposal tests and as the documented adapter contract.
 */
export function compareActivityOrder(
  left: { created_at: string; id: string },
  right: { created_at: string; id: string },
): number {
  if (left.created_at !== right.created_at) {
    return left.created_at > right.created_at ? -1 : 1;
  }
  if (left.id === right.id) return 0;
  return left.id > right.id ? -1 : 1;
}

export function assertContiguousPositions(rows: readonly SnapshotActivityRow[]): void {
  for (let index = 0; index < rows.length; index += 1) {
    const expected = index + 1;
    if (rows[index]?.position !== expected) {
      fail('SNAPSHOT_CHANGED', `row positions must be contiguous from 1 (expected ${expected})`);
    }
  }
}

/**
 * Pure page turn over an already-opened in-memory snapshot.
 * Models the durable contract; a future route would open the snapshot under RR
 * or a seq-prefix high-water, then call this helper.
 */
export function turnSnapshotPage(
  request: SnapshotPageRequest,
  auth: SnapshotAuthorization,
  open: SnapshotOpenState,
  secret: string,
  nowMs: number,
): SnapshotPageResponse {
  if (!auth.authorized) {
    fail('NOT_AUTHORIZED', 'caller is not authorized for this task');
  }
  if (open.high_water.task_deleted) {
    fail('TASK_DELETED', 'task is deleted at high-water');
  }
  if (open.rows.length > TASK_ACTIVITY_SNAPSHOT_PROPOSAL_MAX_ROWS) {
    fail('SNAPSHOT_TOO_LARGE', 'snapshot exceeds 10,000 rows');
  }

  const pageSize = normalizePageSize(request.page_size);
  let startIndex = 0;

  if (request.cursor) {
    const claims = verifySnapshotCursor(request.cursor, secret, nowMs, request.task_id, auth.key_id_hash);
    if (claims.snapshot_id !== open.snapshot_id || claims.epoch !== open.epoch) {
      fail('SNAPSHOT_CHANGED', 'cursor epoch/snapshot no longer matches open cut');
    }
    if (
      claims.high_water.kb_revision !== open.high_water.kb_revision ||
      claims.high_water.task_seq !== open.high_water.task_seq
    ) {
      fail('SNAPSHOT_CHANGED', 'cursor high-water does not match open cut');
    }
    startIndex = claims.last_position;
  } else if (request.task_id !== open.task_id) {
    fail('TASK_NOT_FOUND', 'open snapshot task_id mismatch');
  }

  if (request.expected_digest && request.expected_digest !== open.digest) {
    fail('SNAPSHOT_CHANGED', 'expected_digest does not match open snapshot');
  }

  const total = open.rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.floor(startIndex / pageSize) + 1;
  const slice = open.rows.slice(startIndex, startIndex + pageSize);
  assertContiguousPositions(open.rows);
  const hasMore = startIndex + slice.length < total;
  const last = slice[slice.length - 1];
  const nextCursor = hasMore
    ? signSnapshotCursor(
        {
          snapshot_id: open.snapshot_id,
          task_id: open.task_id,
          epoch: open.epoch,
          high_water: open.high_water,
          last_position: startIndex + slice.length,
          last_seq: last?.task_seq ?? null,
          key_id_hash: auth.key_id_hash,
          expires_at_ms: open.captured_at_ms + TASK_ACTIVITY_SNAPSHOT_CURSOR_TTL_MS,
        },
        secret,
      )
    : null;

  return {
    schema: TASK_ACTIVITY_SNAPSHOT_PAGE_SCHEMA,
    snapshot_id: open.snapshot_id,
    task_id: open.task_id,
    consistency: open.consistency,
    order: open.order,
    high_water: open.high_water,
    page,
    total_pages: totalPages,
    page_size: pageSize,
    total,
    rows: slice,
    has_more: hasMore,
    next_cursor: nextCursor,
    digest: open.digest,
  };
}

/**
 * Simulates "opened snapshot ignores later inserts" for proposal tests.
 * Live offset paging is outside this module and remains NOT_MEASURED here.
 */
export function freezeActivitySet(
  rows: readonly Omit<SnapshotActivityRow, 'position'>[],
): SnapshotActivityRow[] {
  const ordered = [...rows].sort(compareActivityOrder);
  return ordered.map((row, index) => ({ ...row, position: index + 1 }));
}
