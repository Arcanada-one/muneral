// MUN-0021 adoption gate: Muneral-owned committed-result reference and
// deterministic completion receipt.
//
// Ratified in datarim/research/ARCA-0194/muneral-result-reference-consilium.md.
// Muneral authors the reference and the receipt in the same transaction as the
// accepted node mutation, transition journal, aggregate update and outbox fact.
// An execution adapter may propose an owned mutation and relay the resulting
// receipt; it may never fabricate the receipt or supply an authoritative digest.
//
// Round-5 boundary: these are immutable Muneral task facts. Nothing here
// discovers or addresses fleet instances, controls process lifecycle, places
// work, manages versions or staged rollout, detects hangs, aggregates fleet
// telemetry, or routes direct fleet commands.

/** Lowercase 64-character hexadecimal SHA-256 digest. */
export type Sha256Hex = string;

// ---------------------------------------------------------------------------
// Digest domains — the instruction, projection and result integrity domains
// are distinct. Binding completion to instructions is forbidden.
// ---------------------------------------------------------------------------

export const DOMAIN_CARD = 'task-card-v0';
export const DOMAIN_PROJECTION = 'task-card-projection-v0';
export const DOMAIN_RESULT_NODE = 'task-card-result-node-v0';
export const DOMAIN_RESULT_REF = 'muneral-result-ref-v0';
export const DOMAIN_RECEIPT = 'assembly-completion-receipt-v0';

/** Replay disposition for a pre-adoption transition that carries no result. */
export const LEGACY_NONE = 'legacy-none' as const;
export type LegacyNone = typeof LEGACY_NONE;

// ---------------------------------------------------------------------------
// Ratified minimum contract
// ---------------------------------------------------------------------------

export interface CommittedResultRefV0 {
  readonly schemaVersion: 'v0';
  readonly kind: 'task-card-result';
  readonly resultRefId: Sha256Hex;
  readonly taskId: string;
  readonly attemptId: string;
  readonly cardId: string;
  readonly cardDigest: Sha256Hex;
  readonly projectionId: string;
  readonly projectionDigest: Sha256Hex;
  readonly nodeId: string;
  readonly nodeVersion: number;
  readonly resultDigest: Sha256Hex;
  readonly mutationId: string;
  readonly principalId: string;
  readonly transitionId: string;
  readonly aggregateVersion: number;
}

/**
 * The receipt carries no result payload, storage locator, adapter mode,
 * timestamp, Supervisor command, bus subject or evidence body. Recorded time
 * and evidence references remain Muneral transition facts.
 */
export interface CompletionReceiptV0 {
  readonly schemaVersion: 'v0';
  readonly kind: 'completion-receipt';
  readonly receiptId: Sha256Hex;
  readonly outcome: 'committed';
  readonly resultRef: CommittedResultRefV0;
  readonly causationId: string;
  readonly correlationId: string;
}

/**
 * What an execution adapter is allowed to send. It proposes an owned mutation;
 * Muneral validates projection ownership, principal and expected version, then
 * computes every authoritative digest itself.
 */
export interface OwnedResultMutationV0 {
  readonly schemaVersion: 'v0';
  readonly kind: 'owned-result-mutation';
  readonly mutationId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly cardId: string;
  readonly cardDigest: Sha256Hex;
  readonly projectionId: string;
  readonly projectionDigest: Sha256Hex;
  readonly nodeId: string;
  /** 0 for the first commit of this node; otherwise the current node version. */
  readonly expectedNodeVersion: number;
  readonly principalId: string;
  readonly resultNode: Record<string, unknown>;
  readonly idempotencyKey: string;
  readonly causationId: string;
  readonly correlationId: string;
}

/** The exact field set of each closed message — used to reject unknown fields. */
export const COMMITTED_RESULT_REF_FIELDS: readonly string[] = [
  'schemaVersion',
  'kind',
  'resultRefId',
  'taskId',
  'attemptId',
  'cardId',
  'cardDigest',
  'projectionId',
  'projectionDigest',
  'nodeId',
  'nodeVersion',
  'resultDigest',
  'mutationId',
  'principalId',
  'transitionId',
  'aggregateVersion',
];

export const COMPLETION_RECEIPT_FIELDS: readonly string[] = [
  'schemaVersion',
  'kind',
  'receiptId',
  'outcome',
  'resultRef',
  'causationId',
  'correlationId',
];

export const OWNED_RESULT_MUTATION_FIELDS: readonly string[] = [
  'schemaVersion',
  'kind',
  'mutationId',
  'taskId',
  'attemptId',
  'cardId',
  'cardDigest',
  'projectionId',
  'projectionDigest',
  'nodeId',
  'expectedNodeVersion',
  'principalId',
  'resultNode',
  'idempotencyKey',
  'causationId',
  'correlationId',
];

/**
 * Fields only Muneral may author. An adapter that sends any of them is
 * attempting to claim a commit Muneral has not accepted.
 */
export const ADAPTER_FORBIDDEN_FIELDS: readonly string[] = [
  'receipt',
  'receiptId',
  'resultRef',
  'resultRefId',
  'resultDigest',
  'transitionId',
  'aggregateVersion',
  'nodeVersion',
  'outcome',
];

/**
 * The closed committed-result envelope stored on the transition and carried by
 * the outbox. It is a pointer, never a result body.
 */
export interface CommittedResultEnvelopeV0 {
  schema: 'muneral-committed-result-v0';
  resultRefId: Sha256Hex;
  receiptId: Sha256Hex;
  nodeId: string;
  nodeVersion: number;
  resultDigest: Sha256Hex;
}
