// MUN-0022 fail-closed validator. It captures one inert detached snapshot before
// reading schema fields, so caller mutation cannot create validation/compile TOCTOU.

import type { EvidenceRef } from '../execution-authority/execution-authority.types';
import { types as utilTypes } from 'node:util';
import { validateEvidenceRef } from '../execution-authority/evidence-ref.validator';
import {
  CanonicalJsonV1Error,
  canonicalJsonV1,
  captureCanonicalJsonV1,
  type CanonicalJsonV1Object,
  type CanonicalJsonV1Value,
} from '../execution-authority/canonical-json-v1';
import type {
  AssemblyAuthority,
  AssemblyErrorCode,
  AssemblyErrorV0,
  AssemblyRequestV0,
  CanonicalJsonObject,
} from './assembly.types';
import {
  MAX_ATTEMPT_BUDGET,
  MAX_CANDIDATES,
  MAX_FIELD_BYTES,
  MAX_NESTING_DEPTH,
} from './assembly.types';
import {
  createAssemblyError,
  createAssemblyErrorOpaqueIdentity,
  credentialRuleId,
} from './assembly.errors';

const REQUEST_FIELDS = new Set([
  'schemaVersion', 'taskId', 'causationId', 'correlationId', 'evaluatedAt',
  'authorityCeiling', 'requestedAuthority', 'rolePolicy', 'candidateSet',
  'evidenceRefs', 'deadline', 'attemptBudget', 'traceFields', 'provenance',
]);
const AUTHORITY_FIELDS = new Set(['tenant', 'principal', 'purpose', 'audience', 'scope']);
const ROLE_POLICY_FIELDS = new Set(['policyId', 'policyVersion', 'roleName']);
const CANDIDATE_FIELDS = new Set(['candidates', 'sourceDigest', 'capturedAt']);
const PROVENANCE_FIELDS = new Set(['policyUri', 'policyDigest', 'issuedAt', 'expiresAt']);
const TRACE_FIELD_BLOCKLIST = new Set([
  ...REQUEST_FIELDS,
  'providerConfig', 'modelParameters', 'credentials', 'apiKey', 'secret',
  'token', 'endpoint',
]);
const DIGEST_PATH = /^(candidateSet\.sourceDigest|provenance\.policyDigest|evidenceRefs\[[0-9]+\]\.digest)$/;
const SCOPE_TOKEN = /^[a-z][a-z0-9._:-]{0,63}$/;

export function validateAssemblyRequest(input: unknown): AssemblyRequestV0 | AssemblyErrorV0 {
  const failureIdentities = captureFailureIdentities(input);
  let captured: CanonicalJsonV1Value;
  try {
    captured = captureCanonicalJsonV1(input);
  } catch (error) {
    return canonicalFailure(error, failureIdentities);
  }
  if (captured === null || Array.isArray(captured) || typeof captured !== 'object') {
    return error('UNSUPPORTED_SCHEMA_VERSION', undefined, undefined, undefined, 'request', 'request must be a plain object');
  }
  return validateSnapshot(captured as CanonicalJsonV1Object);
}

function validateSnapshot(req: CanonicalJsonV1Object): AssemblyRequestV0 | AssemblyErrorV0 {
  const taskIdentity = req.taskId;
  const causationIdentity = req.causationId;
  const correlationIdentity = req.correlationId;
  const evaluatedAt = typeof req.evaluatedAt === 'string' && isCanonicalUtcInstant(req.evaluatedAt)
    ? req.evaluatedAt
    : undefined;
  const fail = (
    code: AssemblyErrorCode,
    field: string,
    reason: string,
    expected?: unknown,
    actual?: unknown,
  ): AssemblyErrorV0 => withFailedAt(
    createAssemblyError(code, taskIdentity, causationIdentity, correlationIdentity, {
      reason,
      ...(field ? { fieldName: field } : {}),
      ...(expected === undefined ? {} : { expected }),
      ...(actual === undefined ? {} : { actual }),
    }),
    evaluatedAt,
  );

  if (req.schemaVersion !== 'v0') {
    return fail('UNSUPPORTED_SCHEMA_VERSION', 'schemaVersion', 'schemaVersion must be v0');
  }

  const requiredTypeError = validateRequiredTypes(req, fail);
  if (requiredTypeError) return requiredTypeError;
  const boundedFieldError = validateBoundedFields(req, fail);
  if (boundedFieldError) return boundedFieldError;

  const taskId = req.taskId as string;
  const causationId = req.causationId as string;
  const correlationId = req.correlationId as string;
  const instantError = validateInstantFields(req, fail);
  if (instantError) return instantError;
  const evaluatedMs = Date.parse(evaluatedAt as string);

  if (req.deadline !== undefined) {
    if (Date.parse(req.deadline as string) < evaluatedMs) {
      return fail('DEADLINE_EXCEEDED', 'deadline', 'deadline is earlier than evaluatedAt');
    }
  }
  if (req.attemptBudget !== undefined && (
    typeof req.attemptBudget !== 'number'
    || !Number.isSafeInteger(req.attemptBudget)
    || req.attemptBudget < 1
    || req.attemptBudget > MAX_ATTEMPT_BUDGET
  )) {
    return fail('ATTEMPT_BUDGET_EXCEEDED', 'attemptBudget', 'attempt budget is outside the admitted range');
  }

  const provenanceError = validateProvenance(req.provenance, evaluatedMs, fail);
  if (provenanceError) return provenanceError;
  const candidateError = validateCandidateSet(req.candidateSet, fail);
  if (candidateError) return candidateError;

  for (const key of Object.keys(req)) {
    if (!REQUEST_FIELDS.has(key)) return fail('UNKNOWN_EXECUTION_FIELD', key, 'unknown execution field');
  }
  const closedFieldError = validateNestedClosedFields(req, fail);
  if (closedFieldError) return closedFieldError;

  const credentialError = scanCredentials(req, '', taskId, causationId, correlationId);
  if (credentialError) return withFailedAt(credentialError, evaluatedAt);

  const ceilingResult = validateAuthority(req.authorityCeiling, 'authorityCeiling', fail);
  if (isError(ceilingResult)) return ceilingResult;
  const requestedResult = validateAuthority(req.requestedAuthority, 'requestedAuthority', fail);
  if (isError(requestedResult)) return requestedResult;
  const authorityError = validateNarrowing(ceilingResult, requestedResult, fail);
  if (authorityError) return authorityError;

  const evidenceError = validateEvidenceRefs(req.evidenceRefs, fail);
  if (evidenceError) return evidenceError;

  if (req.traceFields !== undefined) {
    if (req.traceFields === null || Array.isArray(req.traceFields) || typeof req.traceFields !== 'object') {
      return fail('AMBIGUOUS_CANONICAL_VALUE', 'traceFields', 'traceFields must be a plain object');
    }
    for (const key of Object.keys(req.traceFields)) {
      if (TRACE_FIELD_BLOCKLIST.has(key)) {
        return fail('UNKNOWN_EXECUTION_FIELD', `traceFields.${key}`, 'trace field shadows a protected name');
      }
    }
    try {
      canonicalJsonV1(req.traceFields);
    } catch (failure) {
      return fail(
        failure instanceof CanonicalJsonV1Error ? failure.kind : 'AMBIGUOUS_CANONICAL_VALUE',
        'traceFields',
        'traceFields exceeds canonical output bounds',
      );
    }
  }

  return req as unknown as AssemblyRequestV0;
}

type Fail = (
  code: AssemblyErrorCode,
  field: string,
  reason: string,
  expected?: unknown,
  actual?: unknown,
) => AssemblyErrorV0;

function validateRequiredTypes(req: CanonicalJsonV1Object, fail: Fail): AssemblyErrorV0 | null {
  for (const field of ['taskId', 'causationId', 'correlationId'] as const) {
    if (typeof req[field] !== 'string') {
      return fail('UNSAFE_SIZE', field, 'identity field must be a required string');
    }
  }
  if (typeof req.evaluatedAt !== 'string') {
    return fail('AMBIGUOUS_CANONICAL_VALUE', 'evaluatedAt', 'evaluated instant must be a required string');
  }
  for (const [field, value] of [
    ['authorityCeiling', req.authorityCeiling],
    ['requestedAuthority', req.requestedAuthority],
  ] as const) {
    if (!isObject(value)) return fail('AUTHORITY_WIDENING', field, 'authority must be a required object');
    for (const authorityField of AUTHORITY_FIELDS) {
      if (typeof value[authorityField] !== 'string') {
        return fail('AUTHORITY_WIDENING', `${field}.${authorityField}`, 'authority field must be a required string');
      }
    }
  }
  if (!isObject(req.rolePolicy)) return fail('UNSAFE_SIZE', 'rolePolicy', 'role policy must be a required object');
  for (const field of ROLE_POLICY_FIELDS) {
    if (typeof req.rolePolicy[field] !== 'string') {
      return fail('UNSAFE_SIZE', `rolePolicy.${field}`, 'role policy field must be a required string');
    }
  }
  if (!isObject(req.candidateSet)) return fail('UNSAFE_SIZE', 'candidateSet', 'candidate set must be a required object');
  if (!Array.isArray(req.candidateSet.candidates)) {
    return fail('UNSAFE_SIZE', 'candidateSet.candidates', 'candidates must be a required array');
  }
  if (req.candidateSet.candidates.some((candidate) => typeof candidate !== 'string')) {
    return fail('UNSAFE_SIZE', 'candidateSet.candidates', 'candidate entries must be strings');
  }
  if (typeof req.candidateSet.sourceDigest !== 'string') {
    return fail('INVALID_DIGEST', 'candidateSet.sourceDigest', 'candidate source digest must be a required string');
  }
  if (typeof req.candidateSet.capturedAt !== 'string') {
    return fail('AMBIGUOUS_CANONICAL_VALUE', 'candidateSet.capturedAt', 'candidate capture instant must be a required string');
  }
  if (!Array.isArray(req.evidenceRefs)) {
    return fail('INVALID_PROVENANCE', 'evidenceRefs', 'evidenceRefs must be a required array');
  }
  if (!isObject(req.provenance)) {
    return fail('INVALID_PROVENANCE', 'provenance', 'provenance must be a required object');
  }
  for (const field of ['policyUri', 'policyDigest', 'issuedAt'] as const) {
    if (typeof req.provenance[field] !== 'string') {
      return fail('INVALID_PROVENANCE', `provenance.${field}`, 'provenance field must be a required string');
    }
  }
  return null;
}

function validateBoundedFields(req: CanonicalJsonV1Object, fail: Fail): AssemblyErrorV0 | null {
  for (const field of ['taskId', 'causationId', 'correlationId'] as const) {
    const value = req[field] as string;
    if (value.length === 0 || utf8Bytes(value) > MAX_FIELD_BYTES) {
      return fail('UNSAFE_SIZE', field, 'identity field must be a bounded non-empty string');
    }
  }
  for (const [path, authority] of [
    ['authorityCeiling', req.authorityCeiling],
    ['requestedAuthority', req.requestedAuthority],
  ] as const) {
    for (const field of AUTHORITY_FIELDS) {
      const value = (authority as CanonicalJsonV1Object)[field] as string;
      if (value.length === 0 || utf8Bytes(value) > MAX_FIELD_BYTES) {
        return fail('AUTHORITY_WIDENING', `${path}.${field}`, 'authority field must be a bounded non-empty string');
      }
    }
  }
  for (const field of ROLE_POLICY_FIELDS) {
    const value = (req.rolePolicy as CanonicalJsonV1Object)[field] as string;
    if (value.length === 0 || utf8Bytes(value) > 128) {
      return fail('UNSAFE_SIZE', `rolePolicy.${field}`, 'role policy field must be a bounded non-empty string');
    }
  }
  const candidates = (req.candidateSet as CanonicalJsonV1Object).candidates as CanonicalJsonV1Value[];
  for (const candidate of candidates as string[]) {
    if (candidate.length === 0 || utf8Bytes(candidate) > 128) {
      return fail('UNSAFE_SIZE', 'candidateSet.candidates', 'candidate must be a bounded non-empty string');
    }
  }
  const policyUri = (req.provenance as CanonicalJsonV1Object).policyUri as string;
  if (policyUri.length === 0 || utf8Bytes(policyUri) > MAX_FIELD_BYTES) {
    return fail('INVALID_PROVENANCE', 'provenance.policyUri', 'policy URI must be a bounded non-empty string');
  }
  return null;
}

function validateInstantFields(req: CanonicalJsonV1Object, fail: Fail): AssemblyErrorV0 | null {
  if (!isCanonicalUtcInstant(req.evaluatedAt as string)) {
    return fail('AMBIGUOUS_CANONICAL_VALUE', 'evaluatedAt', 'instant must use exact millisecond UTC');
  }
  const candidateSet = req.candidateSet as CanonicalJsonV1Object;
  if (!isCanonicalUtcInstant(candidateSet.capturedAt as string)) {
    return fail('AMBIGUOUS_CANONICAL_VALUE', 'candidateSet.capturedAt', 'capture instant must use exact millisecond UTC');
  }
  const provenance = req.provenance as CanonicalJsonV1Object;
  if (!isCanonicalUtcInstant(provenance.issuedAt as string)) {
    return fail('INVALID_PROVENANCE', 'provenance.issuedAt', 'issue instant must use exact millisecond UTC');
  }
  if (provenance.expiresAt !== undefined && (
    typeof provenance.expiresAt !== 'string' || !isCanonicalUtcInstant(provenance.expiresAt)
  )) {
    return fail('EXPIRED_POLICY', 'provenance.expiresAt', 'expiry instant must use exact millisecond UTC');
  }
  if (req.deadline !== undefined && (
    typeof req.deadline !== 'string' || !isCanonicalUtcInstant(req.deadline)
  )) {
    return fail('DEADLINE_EXCEEDED', 'deadline', 'deadline must use exact millisecond UTC');
  }
  return null;
}

function validateNestedClosedFields(req: CanonicalJsonV1Object, fail: Fail): AssemblyErrorV0 | null {
  for (const [path, value, fields] of [
    ['rolePolicy', req.rolePolicy, ROLE_POLICY_FIELDS],
    ['candidateSet', req.candidateSet, CANDIDATE_FIELDS],
    ['provenance', req.provenance, PROVENANCE_FIELDS],
  ] as const) {
    for (const key of Object.keys(value as CanonicalJsonV1Object)) {
      if (!(fields as ReadonlySet<string>).has(key)) {
        return fail('UNKNOWN_EXECUTION_FIELD', `${path}.${key}`, `${path} has an unknown field`);
      }
    }
  }
  return null;
}

function validateEvidenceRefs(value: CanonicalJsonV1Value | undefined, fail: Fail): AssemblyErrorV0 | null {
  const evidenceRefs = value as CanonicalJsonV1Value[];
  if (evidenceRefs.length > 64) {
    return fail('INVALID_PROVENANCE', 'evidenceRefs', 'evidenceRefs exceeds maximum count');
  }
  let priorBytes: Buffer | undefined;
  const identities = new Set<string>();
  for (let index = 0; index < evidenceRefs.length; index++) {
    const reference = evidenceRefs[index];
    if (validateEvidenceRef(reference) !== null) {
      return fail('INVALID_PROVENANCE', `evidenceRefs[${index}]`, 'invalid evidence reference');
    }
    const typed = reference as unknown as Readonly<EvidenceRef>;
    const identity = `${typed.uri}\x00${typed.digest}`;
    if (identities.has(identity)) {
      return fail('INVALID_PROVENANCE', `evidenceRefs[${index}]`, 'duplicate evidence identity');
    }
    identities.add(identity);
    const bytes = Buffer.from(canonicalJsonV1(reference), 'utf8');
    if (priorBytes !== undefined && Buffer.compare(priorBytes, bytes) >= 0) {
      return fail('INVALID_PROVENANCE', `evidenceRefs[${index}]`, 'evidence references must be strictly ordered');
    }
    priorBytes = bytes;
  }
  return null;
}

function validateAuthority(
  value: CanonicalJsonV1Value | undefined,
  path: string,
  fail: Fail,
): AssemblyAuthority | AssemblyErrorV0 {
  const authority = value as CanonicalJsonV1Object;
  for (const key of Object.keys(authority)) {
    if (!AUTHORITY_FIELDS.has(key)) {
      return fail('AUTHORITY_WIDENING', `${path}.${key}`, 'authority has an unknown field');
    }
  }
  const scope = authority.scope as string;
  if (!isCanonicalScope(scope)) return fail('AUTHORITY_WIDENING', `${path}.scope`, 'scope is not a canonical token set');
  return authority as unknown as AssemblyAuthority;
}

function validateNarrowing(ceiling: AssemblyAuthority, requested: AssemblyAuthority, fail: Fail): AssemblyErrorV0 | null {
  for (const field of ['tenant', 'principal', 'purpose', 'audience'] as const) {
    if (ceiling[field] !== requested[field]) {
      return fail('AUTHORITY_WIDENING', `requestedAuthority.${field}`, 'authority identity must equal the ceiling');
    }
  }
  const ceilingScopes = new Set(ceiling.scope.split(','));
  if (requested.scope.split(',').some((token) => !ceilingScopes.has(token))) {
    return fail('AUTHORITY_WIDENING', 'requestedAuthority.scope', 'requested scope exceeds the authority ceiling');
  }
  return null;
}

function validateCandidateSet(value: CanonicalJsonV1Value | undefined, fail: Fail): AssemblyErrorV0 | null {
  const candidateSet = value as CanonicalJsonV1Object;
  const candidates = candidateSet.candidates as CanonicalJsonV1Value[];
  if (candidates.length === 0 || candidates.length > MAX_CANDIDATES) {
    return fail('UNSAFE_SIZE', 'candidateSet.candidates', 'candidate set must contain a bounded non-empty array');
  }
  if (!isSha256(candidateSet.sourceDigest as string)) {
    return fail('INVALID_DIGEST', 'candidateSet.sourceDigest', 'candidate source digest is invalid');
  }
  return null;
}

function validateProvenance(
  value: CanonicalJsonV1Value | undefined,
  evaluatedMs: number,
  fail: Fail,
): AssemblyErrorV0 | null {
  const provenance = value as CanonicalJsonV1Object;
  if (!isSha256(provenance.policyDigest as string)) {
    return fail('INVALID_PROVENANCE', 'provenance.policyDigest', 'policy digest is invalid');
  }
  if (Date.parse(provenance.issuedAt as string) > evaluatedMs) {
    return fail('INVALID_PROVENANCE', 'provenance.issuedAt', 'policy was issued after evaluation');
  }
  if (provenance.expiresAt !== undefined) {
    if (Date.parse(provenance.expiresAt as string) < evaluatedMs) {
      return fail('EXPIRED_POLICY', 'provenance.expiresAt', 'policy expired before evaluation');
    }
  }
  return null;
}

export function assemblyScanForCredentials(
  obj: unknown,
  path: string,
  taskId: string,
  causationId: string,
  correlationId: string,
): AssemblyErrorV0 | null {
  try {
    return scanCredentials(captureCanonicalJsonV1(obj), path, taskId, causationId, correlationId);
  } catch (failure) {
    return canonicalFailure(failure, [taskId, causationId, correlationId]);
  }
}

function scanCredentials(
  value: CanonicalJsonV1Value,
  path: string,
  taskId: string,
  causationId: string,
  correlationId: string,
): AssemblyErrorV0 | null {
  if (typeof value === 'string') {
    if (isSha256(value) && DIGEST_PATH.test(path)) return null;
    const ruleId = credentialRuleId(value);
    return ruleId !== null
      ? error('CREDENTIAL_IN_PROHIBITED_POSITION', taskId, causationId, correlationId, path, `credential rule ${ruleId} matched`)
      : null;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = scanCredentials(value[index], `${path}[${index}]`, taskId, causationId, correlationId);
      if (found) return found;
    }
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const keyRuleId = credentialRuleId(key);
      if (keyRuleId !== null) {
        return error(
          'CREDENTIAL_IN_PROHIBITED_POSITION', taskId, causationId, correlationId,
          path ? `${path}.<redacted>` : '<redacted>', `credential rule ${keyRuleId} matched`,
        );
      }
      const found = scanCredentials(child, path ? `${path}.${key}` : key, taskId, causationId, correlationId);
      if (found) return found;
    }
  }
  return null;
}

type FailureIdentities = readonly [unknown, unknown, unknown];

function captureFailureIdentity(input: unknown, field: string): unknown {
  if (input === null || (typeof input !== 'object' && typeof input !== 'function')) return undefined;
  if (utilTypes.isProxy(input)) return createAssemblyErrorOpaqueIdentity('request-proxy');
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, field);
    if (descriptor === undefined) return undefined;
    return 'value' in descriptor
      ? descriptor.value
      : createAssemblyErrorOpaqueIdentity('identity-accessor');
  } catch {
    return createAssemblyErrorOpaqueIdentity('uninspectable-request');
  }
}

function captureFailureIdentities(input: unknown): FailureIdentities {
  return [
    captureFailureIdentity(input, 'taskId'),
    captureFailureIdentity(input, 'causationId'),
    captureFailureIdentity(input, 'correlationId'),
  ];
}

function canonicalFailure(failure: unknown, identities: FailureIdentities): AssemblyErrorV0 {
  const [taskId, causationId, correlationId] = identities;
  if (failure instanceof CanonicalJsonV1Error) {
    return error(failure.kind, taskId, causationId, correlationId, failure.path, 'canonical boundary refused input');
  }
  return error('AMBIGUOUS_CANONICAL_VALUE', taskId, causationId, correlationId, 'request', 'input could not be inspected safely');
}

function error(
  code: AssemblyErrorCode,
  taskId: unknown,
  causationId: unknown,
  correlationId: unknown,
  fieldName: string,
  reason: string,
): AssemblyErrorV0 {
  return createAssemblyError(code, taskId, causationId, correlationId, { reason, fieldName });
}

function withFailedAt(value: AssemblyErrorV0, evaluatedAt: string | undefined): AssemblyErrorV0 {
  return evaluatedAt === undefined ? value : { ...value, failedAt: evaluatedAt };
}

function isObject(value: CanonicalJsonV1Value | undefined): value is CanonicalJsonV1Object {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value);
}

function isError(value: AssemblyAuthority | AssemblyErrorV0): value is AssemblyErrorV0 {
  return 'errorCode' in value;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function isCanonicalScope(value: string): boolean {
  if (utf8Bytes(value) > 256) return false;
  const tokens = value.split(',');
  if (tokens.length < 1 || tokens.length > 64 || tokens.some((token) => !SCOPE_TOKEN.test(token))) return false;
  return tokens.every((token, index) => index === 0 || tokens[index - 1] < token);
}

function isCanonicalUtcInstant(value: string): boolean {
  if (!/^(?:[0-9]{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/.test(value)) return false;
  if (value.startsWith('0000-')) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

// Re-exported only for focused boundary tests; the public package index does
// not expose validators or helpers.
export const ASSEMBLY_VALIDATOR_MAX_NESTING_DEPTH = MAX_NESTING_DEPTH;
export type AssemblyTraceFields = CanonicalJsonObject;
