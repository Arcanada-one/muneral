// MUN-0022: Task Card v0 — frozen contract types, sub-types, and bounded
// constants. Extends MUN-0020 execution-authority types without duplicating
// them. All fields are readonly; schemaVersion is a literal "v0".
//
// Hard exclusions (enforced at the type level):
// - No slot for credentials, API keys, provider config, or model parameters.
// - No slot for provider endpoint in PreparedInvocationV0.
// - No slot for fleet/process lifecycle, placement, rollout, watchdog, or
//   telemetry-aggregation fields (wrong-plane rejection).
// - No mutable state, no database references.
// - No Supervisor domain model import.

import type { EvidenceRef } from '../execution-authority/execution-authority.types';

// ---------------------------------------------------------------------------
// Bounded constants
// ---------------------------------------------------------------------------

/** Maximum length for string identity/correlation fields. */
export const MAX_FIELD_LENGTH = 256;

/** Maximum number of candidates in CandidateEvidence. */
export const MAX_CANDIDATES = 64;

/** Maximum attempt budget a request may authorize. */
export const MAX_ATTEMPT_BUDGET = 1000;

/** Maximum nesting depth for validated objects. */
export const MAX_NESTING_DEPTH = 10;

/** Maximum number of nodes in a Task Card graph. */
export const MAX_NODE_COUNT = 100;

/** Maximum number of concurrent actors for concurrency ownership tests. */
export const MAX_CONCURRENT_ACTORS = 5;

// ---------------------------------------------------------------------------
// AssemblyErrorCode — frozen codes
// ---------------------------------------------------------------------------

export type AssemblyErrorCode =
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'UNKNOWN_EXECUTION_FIELD'
  | 'AMBIGUOUS_CANONICAL_VALUE'
  | 'UNSAFE_SIZE'
  | 'UNSAFE_NESTING'
  | 'AUTHORITY_WIDENING'
  | 'INVALID_PROVENANCE'
  | 'EXPIRED_POLICY'
  | 'CREDENTIAL_IN_PROHIBITED_POSITION'
  | 'INVALID_DIGEST'
  | 'DEADLINE_EXCEEDED'
  | 'ATTEMPT_BUDGET_EXCEEDED'
  | 'INVALID_TRANSITION'
  | 'OUT_OF_SCOPE_MUTATION'
  | 'DUPLICATE_COMPLETION'
  | 'CONCURRENT_OWNERSHIP'
  | 'OUT_OF_BAND_RESULT'
  | 'WRONG_PLANE_CONTROL';

/** Exhaustive list of all 18 error codes for iteration/validation. */
export const ASSEMBLY_ERROR_CODES: AssemblyErrorCode[] = [
  'UNSUPPORTED_SCHEMA_VERSION',
  'UNKNOWN_EXECUTION_FIELD',
  'AMBIGUOUS_CANONICAL_VALUE',
  'UNSAFE_SIZE',
  'UNSAFE_NESTING',
  'AUTHORITY_WIDENING',
  'INVALID_PROVENANCE',
  'EXPIRED_POLICY',
  'CREDENTIAL_IN_PROHIBITED_POSITION',
  'INVALID_DIGEST',
  'DEADLINE_EXCEEDED',
  'ATTEMPT_BUDGET_EXCEEDED',
  'INVALID_TRANSITION',
  'OUT_OF_SCOPE_MUTATION',
  'DUPLICATE_COMPLETION',
  'CONCURRENT_OWNERSHIP',
  'OUT_OF_BAND_RESULT',
  'WRONG_PLANE_CONTROL',
];

// ---------------------------------------------------------------------------
// Supporting sub-types
// ---------------------------------------------------------------------------

/** Deterministic identity of a role/skill policy — not a learned selector. */
export interface RolePolicyIdentity {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly roleName: string;
}

/** Evidence of available skills/roles at assembly time — not a learned choice. */
export interface CandidateEvidence {
  readonly candidates: string[];
  readonly sourceDigest: string;
  readonly capturedAt: string;
}

/** Policy version provenance — binds assembly to a specific policy revision. */
export interface PolicyProvenance {
  readonly policyUri: string;
  readonly policyDigest: string;
  readonly issuedAt: string;
  readonly expiresAt?: string;
}

/** The authority carried through assembly — output must be equal or narrower. */
export interface AssemblyAuthority {
  readonly tenant: string;
  readonly principal: string;
  readonly purpose: string;
  readonly audience: string;
  readonly scope: string;
}

// ---------------------------------------------------------------------------
// Task Card graph model — owned nodes, projections, mutations, receipts
// ---------------------------------------------------------------------------

/** A single node in the Task Card graph — a unit of work for a subagent. */
export interface TaskCardNodeV0 {
  readonly nodeId: string;
  readonly nodeType: string;
  readonly ownedBy: string; // subagent identity
  readonly dependsOn: string[]; // nodeIds this node depends on
  readonly payload: Record<string, unknown>;
}

/** A directed edge between Task Card nodes. */
export interface TaskCardEdgeV0 {
  readonly from: string; // nodeId
  readonly to: string; // nodeId
}

// ---------------------------------------------------------------------------
// Primary contract types
// ---------------------------------------------------------------------------

/**
 * AssemblyRequestV0 — the input to the assembler.
 * All fields are authoritative unless marked NON-AUTHORITATIVE.
 * Forbidden: credentials, API keys, provider config, model parameters, secrets.
 */
export interface AssemblyRequestV0 {
  readonly schemaVersion: 'v0';
  readonly taskId: string;
  readonly causationId: string;
  readonly correlationId: string;
  readonly tenant: string;
  readonly principal: string;
  readonly purpose: string;
  readonly audience: string;
  readonly scope: string;
  readonly rolePolicy: RolePolicyIdentity;
  readonly candidateSet: CandidateEvidence;
  readonly deadline?: string;
  readonly attemptBudget?: number;
  /** NON-AUTHORITATIVE — excluded from decision-bearing bytes. */
  readonly traceFields?: Record<string, unknown>;
  readonly provenance: PolicyProvenance;
}

/**
 * TaskCardV0 — the output of successful assembly, built before orchestration.
 * Contains the work graph (nodes + edges) plus the prepared invocation.
 * All fields except traceFields are authoritative.
 */
export interface TaskCardV0 {
  readonly cardId: string;
  readonly canonicalBytes: string;
  readonly digest: string;
  readonly schemaVersion: 'v0';
  readonly taskId: string;
  readonly causationId: string;
  readonly correlationId: string;
  readonly nodes: TaskCardNodeV0[];
  readonly edges: TaskCardEdgeV0[];
  readonly preparedInvocation: PreparedInvocationV0;
  readonly authority: AssemblyAuthority;
  readonly rolePolicy: RolePolicyIdentity;
  readonly candidateSet: CandidateEvidence;
  /** NON-AUTHORITATIVE — preserved but excluded from decision bytes. */
  readonly traceFields?: Record<string, unknown>;
  readonly provenance: PolicyProvenance;
}

/**
 * TaskCardProjectionV0 — a capability-scoped view of the Task Card given to a
 * single subagent. Contains only the nodes the subagent owns plus their
 * dependency context. The subagent cannot see or mutate nodes it does not own.
 */
export interface TaskCardProjectionV0 {
  readonly projectionId: string;
  readonly cardId: string;
  readonly cardDigest: string;
  readonly schemaVersion: 'v0';
  readonly ownedNodes: TaskCardNodeV0[];
  readonly visibleEdges: TaskCardEdgeV0[];
  readonly authority: AssemblyAuthority;
  readonly deadline?: string;
  readonly attemptBudget?: number;
  readonly provenance: PolicyProvenance;
}

/**
 * OwnedResultMutationV0 — a mutation a subagent applies to its owned result
 * node. The subagent may only mutate nodes listed in its projection's
 * ownedNodes. The mutation references the exact node, version, and digest.
 */
export interface OwnedResultMutationV0 {
  readonly mutationId: string;
  readonly nodeId: string;
  readonly expectedVersion: number;
  readonly newDigest: string;
  readonly payload: Record<string, unknown>;
  readonly causationId: string;
  readonly correlationId: string;
}

/**
 * CompletionReceiptV0 — a typed receipt emitted by a subagent upon completion
 * of its work. References the exact committed node, version, and digest.
 * This is the ONLY legal result surface — no standalone prose, Markdown, or
 * arbitrary JSON result channel exists.
 */
export interface CompletionReceiptV0 {
  readonly receiptId: string;
  readonly nodeId: string;
  readonly version: number;
  readonly digest: string;
  readonly outcome: 'completed' | 'failed' | 'timeout' | 'cancelled';
  readonly completedAt: string;
  readonly causationId: string;
  readonly correlationId: string;
  readonly evidenceRefs: EvidenceRef[];
}

/** Structured error details. */
export interface ErrorDetails {
  readonly fieldName?: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly reason: string;
}

/**
 * AssemblyErrorV0 — typed fail-closed error.
 * Every validation failure produces this, never a thrown exception.
 */
export interface AssemblyErrorV0 {
  readonly errorId: string;
  readonly errorCode: AssemblyErrorCode;
  readonly message: string;
  readonly schemaVersion: 'v0';
  readonly taskId: string;
  readonly causationId: string;
  readonly correlationId: string;
  readonly failedAt: string;
  readonly details: ErrorDetails;
}

/** Invocation constraints — bounds only, no actual tool definitions. */
export interface InvocationConstraints {
  readonly budget?: number;
  readonly deadline?: string;
  readonly toolAllowlist?: string[];
  readonly toolDenylist?: string[];
}

/**
 * PreparedInvocationV0 — a provider-neutral invocation specification.
 * Never directly executable. Explicitly excludes provider endpoint,
 * credentials, model name, model parameters, tool implementations.
 */
export interface PreparedInvocationV0 {
  readonly invocationId: string;
  readonly targetRole: string;
  readonly canonicalPrompt: string;
  readonly constraints: InvocationConstraints;
  readonly evidenceRefs: EvidenceRef[];
}

/**
 * InvocationObservationV0 — records what was observed about an invocation,
 * for replay/falsification purposes.
 */
export interface InvocationObservationV0 {
  readonly observationId: string;
  readonly invocationId: string;
  readonly observedAt: string;
  readonly outcome: 'completed' | 'failed' | 'timeout' | 'cancelled';
  readonly resultDigest?: string;
  readonly evidenceRefs: EvidenceRef[];
}
