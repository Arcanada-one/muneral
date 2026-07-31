// MUN-0021 adoption gate: per-message closed validators.
//
// These replace the global wrong-plane field denylist for the result plane. A
// valid Task Card `nodeId` is accepted; Supervisor lifecycle, placement,
// watchdog and command authority — and Supervisor principals — remain
// rejected. Every validator returns a typed error rather than throwing, so a
// rejected message is refused from a pre-mutation position with zero writes.

import { validatePayloadPlane } from '../outbox/outbox.types';
import { computeReceiptId, computeResultRefId, isSha256Hex } from './result-authority.canonical';
import {
  AdapterAuthorityError,
  ResultContractError,
  ResultPlaneError,
} from './result-authority.errors';
import {
  ADAPTER_FORBIDDEN_FIELDS,
  COMMITTED_RESULT_REF_FIELDS,
  COMPLETION_RECEIPT_FIELDS,
  LEGACY_NONE,
  OWNED_RESULT_MUTATION_FIELDS,
} from './result-authority.types';
import type {
  CommittedResultRefV0,
  CompletionReceiptV0,
  LegacyNone,
  OwnedResultMutationV0,
} from './result-authority.types';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** Reject any key outside the closed field set. */
function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  messageName: string,
): ResultContractError | null {
  const permitted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) {
      return new ResultContractError(
        key,
        `unknown field on the closed ${messageName} schema — the schema is closed, so an unrecognised field fails rather than being ignored`,
      );
    }
  }
  for (const key of allowed) {
    if (!(key in value)) {
      return new ResultContractError(
        key,
        `missing required field on ${messageName}`,
      );
    }
  }
  return null;
}

function requireNonEmptyString(
  value: Record<string, unknown>,
  field: string,
): ResultContractError | null {
  const raw = value[field];
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 256) {
    return new ResultContractError(
      field,
      'must be a non-empty string of at most 256 characters',
    );
  }
  return null;
}

function requireSha256(
  value: Record<string, unknown>,
  field: string,
): ResultContractError | null {
  if (!isSha256Hex(value[field])) {
    return new ResultContractError(
      field,
      'must be a 64-character lowercase hexadecimal SHA-256 digest',
    );
  }
  return null;
}

function requirePositiveInt(
  value: Record<string, unknown>,
  field: string,
  minimum: number,
): ResultContractError | null {
  const raw = value[field];
  if (
    typeof raw !== 'number' ||
    !Number.isSafeInteger(raw) ||
    raw < minimum
  ) {
    return new ResultContractError(
      field,
      `must be a safe integer of at least ${minimum}`,
    );
  }
  return null;
}

function first(
  ...checks: Array<ResultContractError | null>
): ResultContractError | null {
  for (const check of checks) {
    if (check !== null) return check;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Result-plane validation (round-5 boundary)
// ---------------------------------------------------------------------------

/**
 * Supervisor principals cannot commit Muneral task results. Fleet control is
 * owned by the separate round-5 Supervisor; Agent Arcana owns per-host
 * execution.
 */
const SUPERVISOR_PRINCIPAL = /^(supervisor|fleet|controller)([:/-]|$)/i;

/**
 * Per-message plane check for the result plane. Returns a reason string on
 * violation, null on pass. A valid Task Card `nodeId` passes — it is a result
 * addressing field, not a fleet addressing field.
 */
export function validateResultPlane(value: unknown): string | null {
  if (!isPlainRecord(value)) {
    return 'result-plane payload must be a plain JSON object';
  }
  return validatePayloadPlane(value);
}

/** Reject Supervisor-owned principals. Returns a reason string or null. */
export function validateResultPrincipal(principalId: unknown): string | null {
  if (typeof principalId !== 'string' || principalId.length === 0) {
    return 'principalId must be a non-empty string';
  }
  if (SUPERVISOR_PRINCIPAL.test(principalId)) {
    return `principal "${principalId}" belongs to the Supervisor plane — Muneral accepts result mutations only from execution principals`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// CommittedResultRefV0
// ---------------------------------------------------------------------------

export function validateCommittedResultRefV0(
  value: unknown,
): CommittedResultRefV0 | ResultContractError {
  if (!isPlainRecord(value)) {
    return new ResultContractError(
      '$',
      'CommittedResultRefV0 must be a plain JSON object',
    );
  }

  const shape = rejectUnknownFields(
    value,
    COMMITTED_RESULT_REF_FIELDS,
    'CommittedResultRefV0',
  );
  if (shape !== null) return shape;

  if (value.schemaVersion !== 'v0') {
    return new ResultContractError('schemaVersion', 'must be "v0"');
  }
  if (value.kind !== 'task-card-result') {
    return new ResultContractError('kind', 'must be "task-card-result"');
  }

  const fieldErr = first(
    requireNonEmptyString(value, 'taskId'),
    requireNonEmptyString(value, 'attemptId'),
    requireNonEmptyString(value, 'cardId'),
    requireNonEmptyString(value, 'projectionId'),
    requireNonEmptyString(value, 'nodeId'),
    requireNonEmptyString(value, 'mutationId'),
    requireNonEmptyString(value, 'principalId'),
    requireNonEmptyString(value, 'transitionId'),
    requireSha256(value, 'resultRefId'),
    requireSha256(value, 'cardDigest'),
    requireSha256(value, 'projectionDigest'),
    requireSha256(value, 'resultDigest'),
    requirePositiveInt(value, 'nodeVersion', 1),
    requirePositiveInt(value, 'aggregateVersion', 1),
  );
  if (fieldErr !== null) return fieldErr;

  const principalErr = validateResultPrincipal(value.principalId);
  if (principalErr !== null) {
    return new ResultContractError('principalId', principalErr);
  }

  const ref: CommittedResultRefV0 = {
    schemaVersion: 'v0',
    kind: 'task-card-result',
    resultRefId: value.resultRefId as string,
    taskId: value.taskId as string,
    attemptId: value.attemptId as string,
    cardId: value.cardId as string,
    cardDigest: value.cardDigest as string,
    projectionId: value.projectionId as string,
    projectionDigest: value.projectionDigest as string,
    nodeId: value.nodeId as string,
    nodeVersion: value.nodeVersion as number,
    resultDigest: value.resultDigest as string,
    mutationId: value.mutationId as string,
    principalId: value.principalId as string,
    transitionId: value.transitionId as string,
    aggregateVersion: value.aggregateVersion as number,
  };

  const { resultRefId: _stated, ...withoutId } = ref;
  if (computeResultRefId(withoutId) !== ref.resultRefId) {
    return new ResultContractError(
      'resultRefId',
      'does not match the identity recomputed from the reference fields',
    );
  }

  return ref;
}

// ---------------------------------------------------------------------------
// CompletionReceiptV0
// ---------------------------------------------------------------------------

export function validateCompletionReceiptV0(
  value: unknown,
): CompletionReceiptV0 | ResultContractError {
  if (!isPlainRecord(value)) {
    return new ResultContractError(
      '$',
      'CompletionReceiptV0 must be a plain JSON object — prose, Markdown and arbitrary scalars are not receipts',
    );
  }

  const shape = rejectUnknownFields(
    value,
    COMPLETION_RECEIPT_FIELDS,
    'CompletionReceiptV0',
  );
  if (shape !== null) return shape;

  if (value.schemaVersion !== 'v0') {
    return new ResultContractError('schemaVersion', 'must be "v0"');
  }
  if (value.kind !== 'completion-receipt') {
    return new ResultContractError('kind', 'must be "completion-receipt"');
  }
  if (value.outcome !== 'committed') {
    return new ResultContractError(
      'outcome',
      'must be "committed" — failure, timeout and cancellation are typed invocation observations plus Muneral attempt transitions, never completion receipts',
    );
  }

  const fieldErr = first(
    requireSha256(value, 'receiptId'),
    requireNonEmptyString(value, 'causationId'),
    requireNonEmptyString(value, 'correlationId'),
  );
  if (fieldErr !== null) return fieldErr;

  const ref = validateCommittedResultRefV0(value.resultRef);
  if (ref instanceof ResultContractError) return ref;

  const receipt: CompletionReceiptV0 = {
    schemaVersion: 'v0',
    kind: 'completion-receipt',
    receiptId: value.receiptId as string,
    outcome: 'committed',
    resultRef: ref,
    causationId: value.causationId as string,
    correlationId: value.correlationId as string,
  };

  const { receiptId: _stated, ...withoutId } = receipt;
  if (computeReceiptId(withoutId) !== receipt.receiptId) {
    return new ResultContractError(
      'receiptId',
      'does not match the identity recomputed from the receipt fields',
    );
  }

  return receipt;
}

// ---------------------------------------------------------------------------
// OwnedResultMutationV0 — what an adapter may propose
// ---------------------------------------------------------------------------

export function validateOwnedResultMutationV0(
  value: unknown,
): OwnedResultMutationV0 | ResultContractError | AdapterAuthorityError | ResultPlaneError {
  if (!isPlainRecord(value)) {
    return new ResultContractError(
      '$',
      'OwnedResultMutationV0 must be a plain JSON object',
    );
  }

  // An adapter that sends a Muneral-authored field is claiming a commit
  // Muneral has not accepted. Check this before the shape check so the
  // diagnosis names the authority violation rather than "unknown field".
  for (const field of ADAPTER_FORBIDDEN_FIELDS) {
    if (field in value) {
      return new AdapterAuthorityError(field);
    }
  }

  const shape = rejectUnknownFields(
    value,
    OWNED_RESULT_MUTATION_FIELDS,
    'OwnedResultMutationV0',
  );
  if (shape !== null) return shape;

  if (value.schemaVersion !== 'v0') {
    return new ResultContractError('schemaVersion', 'must be "v0"');
  }
  if (value.kind !== 'owned-result-mutation') {
    return new ResultContractError('kind', 'must be "owned-result-mutation"');
  }

  const fieldErr = first(
    requireNonEmptyString(value, 'mutationId'),
    requireNonEmptyString(value, 'taskId'),
    requireNonEmptyString(value, 'attemptId'),
    requireNonEmptyString(value, 'cardId'),
    requireNonEmptyString(value, 'projectionId'),
    requireNonEmptyString(value, 'nodeId'),
    requireNonEmptyString(value, 'principalId'),
    requireNonEmptyString(value, 'idempotencyKey'),
    requireNonEmptyString(value, 'causationId'),
    requireNonEmptyString(value, 'correlationId'),
    requireSha256(value, 'cardDigest'),
    requireSha256(value, 'projectionDigest'),
    requirePositiveInt(value, 'expectedNodeVersion', 0),
  );
  if (fieldErr !== null) return fieldErr;

  if (!isPlainRecord(value.resultNode)) {
    return new ResultContractError(
      'resultNode',
      'must be a plain JSON object — prose, Markdown and arbitrary scalars cannot be committed as a result node',
    );
  }

  // The declared node must be the node the adapter actually committed.
  const declaredNodeId = (value.resultNode as Record<string, unknown>).nodeId;
  if (declaredNodeId !== undefined && declaredNodeId !== value.nodeId) {
    return new ResultContractError(
      'resultNode.nodeId',
      `must equal the proposal nodeId "${String(value.nodeId)}", got "${String(declaredNodeId)}"`,
    );
  }

  const principalErr = validateResultPrincipal(value.principalId);
  if (principalErr !== null) {
    return new ResultPlaneError('principalId', principalErr);
  }

  const planeErr = validateResultPlane(value.resultNode);
  if (planeErr !== null) {
    return new ResultPlaneError('resultNode', planeErr);
  }

  return {
    schemaVersion: 'v0',
    kind: 'owned-result-mutation',
    mutationId: value.mutationId as string,
    taskId: value.taskId as string,
    attemptId: value.attemptId as string,
    cardId: value.cardId as string,
    cardDigest: value.cardDigest as string,
    projectionId: value.projectionId as string,
    projectionDigest: value.projectionDigest as string,
    nodeId: value.nodeId as string,
    expectedNodeVersion: value.expectedNodeVersion as number,
    principalId: value.principalId as string,
    resultNode: value.resultNode as Record<string, unknown>,
    idempotencyKey: value.idempotencyKey as string,
    causationId: value.causationId as string,
    correlationId: value.correlationId as string,
  };
}

// ---------------------------------------------------------------------------
// Legacy replay
// ---------------------------------------------------------------------------

/**
 * Pre-adoption transitions carry an empty committed result. Those replay as
 * `legacy-none`. Arbitrary legacy JSON is never silently promoted into a
 * completion receipt — it has no reference, no digest domain and no principal.
 */
export function replayLegacyCommittedResult(
  committedResult: unknown,
): LegacyNone | ResultContractError {
  if (!isPlainRecord(committedResult)) {
    return new ResultContractError(
      'committedResult',
      'legacy committed results must be plain JSON objects',
    );
  }
  if (Object.keys(committedResult).length === 0) {
    return LEGACY_NONE;
  }
  return new ResultContractError(
    'committedResult',
    'legacy result data cannot be promoted into a completion receipt — it carries no committed-result reference, digest domain or accepting principal',
  );
}
