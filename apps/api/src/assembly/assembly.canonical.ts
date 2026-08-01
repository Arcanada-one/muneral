// MUN-0022 Assembly projections over the neutral strict canonical JSON v1.

import { createHash } from 'node:crypto';
import type { EvidenceRef } from '../execution-authority/execution-authority.types';
import {
  CanonicalJsonV1Error,
  assertCanonicalJsonV1RawBounds,
  canonicalJsonV1,
  captureCanonicalJsonV1,
  parseCanonicalJsonV1,
  type CanonicalJsonV1Object,
  type CanonicalJsonV1Value,
} from '../execution-authority/canonical-json-v1';
import type {
  AssemblyAuthority,
  AssemblyErrorV0,
  AssemblyRequestV0,
  CandidateEvidence,
  InvocationConstraints,
  PolicyProvenance,
  PreparedInvocationV0,
  RolePolicyIdentity,
} from './assembly.types';
import { createAssemblyError } from './assembly.errors';

export { CanonicalJsonV1Error as AssemblyCanonicalJsonError };
export const assemblyCanonicalJson = canonicalJsonV1;
export const assemblyParseCanonicalJson = parseCanonicalJsonV1;
export const assertRawCanonicalResourceBounds = assertCanonicalJsonV1RawBounds;

export interface PromptProjectionV0 extends CanonicalJsonV1Object {
  readonly kind: 'assembly-prompt-v0';
}

export interface InvocationProjectionV0 extends CanonicalJsonV1Object {
  readonly kind: 'prepared-invocation-v0';
}

export interface AssemblyDecisionV0 extends CanonicalJsonV1Object {
  readonly kind: 'assembly-artifact-v0';
}

export function validateCanonicalValue(
  value: unknown,
  path: string,
  taskId: string,
  causationId: string,
  correlationId: string,
): AssemblyErrorV0 | null {
  try {
    captureCanonicalJsonV1(value);
    return null;
  } catch (error) {
    if (error instanceof CanonicalJsonV1Error) {
      return createAssemblyError(error.kind, taskId, causationId, correlationId, {
        reason: `canonical input refused at ${path || error.path}`,
        fieldName: path || error.path,
      });
    }
    return createAssemblyError('AMBIGUOUS_CANONICAL_VALUE', '', '', '', {
      reason: 'canonical input could not be inspected safely',
      fieldName: path || '<root>',
    });
  }
}

export function createInvocationConstraints(request: AssemblyRequestV0): InvocationConstraints {
  return {
    ...(request.deadline === undefined ? {} : { deadline: request.deadline }),
    ...(request.attemptBudget === undefined ? {} : { budget: request.attemptBudget }),
  };
}

export function createPromptProjection(request: AssemblyRequestV0): PromptProjectionV0 {
  return {
    kind: 'assembly-prompt-v0',
    schemaVersion: request.schemaVersion,
    taskId: request.taskId,
    causationId: request.causationId,
    correlationId: request.correlationId,
    evaluatedAt: request.evaluatedAt,
    authority: canonicalAuthority(request.requestedAuthority),
    rolePolicy: canonicalRolePolicy(request.rolePolicy),
    candidateSet: canonicalCandidateSet(request.candidateSet),
    constraints: createInvocationConstraints(request) as CanonicalJsonV1Object,
    evidenceRefs: request.evidenceRefs.map(canonicalEvidenceRef),
    provenance: canonicalProvenance(request.provenance),
  };
}

export function createPreparedInvocation(request: AssemblyRequestV0): PreparedInvocationV0 {
  const canonicalPrompt = canonicalJsonV1(createPromptProjection(request));
  const constraints = createInvocationConstraints(request);
  const evidenceRefs = request.evidenceRefs.map(cloneEvidenceRef);
  const invocationProjection: InvocationProjectionV0 = {
    kind: 'prepared-invocation-v0',
    targetRole: request.rolePolicy.roleName,
    canonicalPrompt,
    constraints: constraints as CanonicalJsonV1Object,
    evidenceRefs: evidenceRefs.map(canonicalEvidenceRef),
  };
  const invocationId = sha256Hex(canonicalJsonV1(invocationProjection));
  return {
    invocationId,
    targetRole: request.rolePolicy.roleName,
    canonicalPrompt,
    constraints,
    evidenceRefs,
  };
}

export function createAssemblyDecision(
  request: AssemblyRequestV0,
  preparedInvocation: PreparedInvocationV0 = createPreparedInvocation(request),
): AssemblyDecisionV0 {
  return {
    kind: 'assembly-artifact-v0',
    schemaVersion: request.schemaVersion,
    taskId: request.taskId,
    causationId: request.causationId,
    correlationId: request.correlationId,
    evaluatedAt: request.evaluatedAt,
    authorityCeiling: canonicalAuthority(request.authorityCeiling),
    authority: canonicalAuthority(request.requestedAuthority),
    rolePolicy: canonicalRolePolicy(request.rolePolicy),
    candidateSet: canonicalCandidateSet(request.candidateSet),
    ...(request.deadline === undefined ? {} : { deadline: request.deadline }),
    ...(request.attemptBudget === undefined ? {} : { attemptBudget: request.attemptBudget }),
    provenance: canonicalProvenance(request.provenance),
    preparedInvocation: canonicalPreparedInvocation(preparedInvocation),
  };
}

export function canonicalizeDecisionFields(request: AssemblyRequestV0): string {
  return canonicalJsonV1(createAssemblyDecision(request));
}

export function computeCardDigest(request: AssemblyRequestV0): string {
  return sha256Hex(canonicalizeDecisionFields(request));
}

export const computeAssemblyDigest = computeCardDigest;

function canonicalAuthority(authority: AssemblyAuthority): CanonicalJsonV1Object {
  return {
    tenant: authority.tenant,
    principal: authority.principal,
    purpose: authority.purpose,
    audience: authority.audience,
    scope: authority.scope,
  };
}

function canonicalRolePolicy(policy: RolePolicyIdentity): CanonicalJsonV1Object {
  return {
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    roleName: policy.roleName,
  };
}

function canonicalCandidateSet(candidateSet: CandidateEvidence): CanonicalJsonV1Object {
  return {
    candidates: [...candidateSet.candidates],
    sourceDigest: candidateSet.sourceDigest,
    capturedAt: candidateSet.capturedAt,
  };
}

function canonicalProvenance(provenance: PolicyProvenance): CanonicalJsonV1Object {
  return {
    policyUri: provenance.policyUri,
    policyDigest: provenance.policyDigest,
    issuedAt: provenance.issuedAt,
    ...(provenance.expiresAt === undefined ? {} : { expiresAt: provenance.expiresAt }),
  };
}

function canonicalEvidenceRef(reference: Readonly<EvidenceRef>): CanonicalJsonV1Object {
  return {
    uri: reference.uri,
    digest: reference.digest,
    contentType: reference.contentType,
    ...(reference.label === undefined ? {} : { label: reference.label }),
  };
}

function cloneEvidenceRef(reference: Readonly<EvidenceRef>): EvidenceRef {
  return {
    uri: reference.uri,
    digest: reference.digest,
    contentType: reference.contentType,
    ...(reference.label === undefined ? {} : { label: reference.label }),
  };
}

function canonicalPreparedInvocation(invocation: PreparedInvocationV0): CanonicalJsonV1Value {
  return {
    invocationId: invocation.invocationId,
    targetRole: invocation.targetRole,
    canonicalPrompt: invocation.canonicalPrompt,
    constraints: invocation.constraints as CanonicalJsonV1Object,
    evidenceRefs: invocation.evidenceRefs.map(canonicalEvidenceRef),
  };
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
