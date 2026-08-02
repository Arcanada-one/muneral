// MUN-0022: frozen, topology-neutral Assembly Package v0 contracts.
// This module describes compilation input/output only. It intentionally owns
// no runtime adapter, process capability, mutable state, persistence, or
// invocation-owner decision.

import type { EvidenceRef } from '../execution-authority/execution-authority.types';
export {
  CANONICAL_JSON_V1_MAX_DEPTH as MAX_NESTING_DEPTH,
  CANONICAL_JSON_V1_MAX_CONTAINER_ENTRIES as MAX_CONTAINER_ENTRIES,
  CANONICAL_JSON_V1_MAX_ENTRIES as MAX_CANONICAL_ENTRIES,
  CANONICAL_JSON_V1_MAX_BYTES as MAX_CANONICAL_BYTES,
} from '../execution-authority/canonical-json-v1';

export const MAX_FIELD_BYTES = 256;
export const MAX_CANDIDATES = 64;
export const MAX_ATTEMPT_BUDGET = 1000;
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
  | 'ATTEMPT_BUDGET_EXCEEDED';

export const ASSEMBLY_ERROR_CODES: readonly AssemblyErrorCode[] = [
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
];

export type Sha256Hex = string;
export type CanonicalJsonPrimitive = null | boolean | number | string;
export type CanonicalJsonArray = readonly CanonicalJsonValue[];
export interface CanonicalJsonObject {
  readonly [key: string]: CanonicalJsonValue;
}
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | CanonicalJsonArray
  | CanonicalJsonObject;

export interface RolePolicyIdentity {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly roleName: string;
}

export interface CandidateEvidence {
  readonly candidates: readonly string[];
  readonly sourceDigest: string;
  readonly capturedAt: string;
}

export interface PolicyProvenance {
  readonly policyUri: string;
  readonly policyDigest: string;
  readonly issuedAt: string;
  readonly expiresAt?: string;
}

export interface AssemblyAuthority {
  readonly tenant: string;
  readonly principal: string;
  readonly purpose: string;
  readonly audience: string;
  readonly scope: string;
}

export interface AssemblyRequestV0 {
  readonly schemaVersion: 'v0';
  readonly taskId: string;
  readonly causationId: string;
  readonly correlationId: string;
  readonly evaluatedAt: string;
  readonly authorityCeiling: AssemblyAuthority;
  readonly requestedAuthority: AssemblyAuthority;
  readonly rolePolicy: RolePolicyIdentity;
  readonly candidateSet: CandidateEvidence;
  readonly evidenceRefs: readonly Readonly<EvidenceRef>[];
  readonly deadline?: string;
  readonly attemptBudget?: number;
  /** Non-authoritative: preserved but excluded from decision bytes. */
  readonly traceFields?: CanonicalJsonObject;
  readonly provenance: PolicyProvenance;
}

export interface InvocationConstraints {
  readonly budget?: number;
  readonly deadline?: string;
  readonly toolAllowlist?: readonly string[];
  readonly toolDenylist?: readonly string[];
}

/** Provider-neutral data. It is a specification, never an executable. */
export interface PreparedInvocationV0 {
  readonly invocationId: string;
  readonly targetRole: string;
  readonly canonicalPrompt: string;
  readonly constraints: InvocationConstraints;
  readonly evidenceRefs: readonly Readonly<EvidenceRef>[];
}

export interface AssemblyArtifactV0 {
  readonly artifactId: string;
  readonly canonicalBytes: string;
  readonly digest: string;
  readonly schemaVersion: 'v0';
  readonly taskId: string;
  readonly causationId: string;
  readonly correlationId: string;
  readonly evaluatedAt: string;
  readonly preparedInvocation: PreparedInvocationV0;
  readonly authorityCeiling: AssemblyAuthority;
  readonly authority: AssemblyAuthority;
  readonly rolePolicy: RolePolicyIdentity;
  readonly candidateSet: CandidateEvidence;
  readonly traceFields?: CanonicalJsonObject;
  readonly provenance: PolicyProvenance;
}

export interface ErrorDetails {
  readonly fieldName?: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly reason: string;
}

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

/** Replay/falsification data only; this type does not activate observation. */
export interface InvocationObservationV0 {
  readonly observationId: string;
  readonly invocationId: string;
  readonly observedAt: string;
  readonly outcome: 'completed' | 'failed' | 'timeout' | 'cancelled';
  readonly resultDigest?: Sha256Hex;
  readonly evidenceRefs: readonly Readonly<EvidenceRef>[];
}

export type AssemblyCompileResultV0 =
  | { readonly ok: true; readonly artifact: AssemblyArtifactV0 }
  | { readonly ok: false; readonly error: AssemblyErrorV0 };
