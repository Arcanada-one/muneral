// MUN-0022: Fail-closed request validation. Every validation failure produces a
// typed AssemblyErrorV0 — no exceptions thrown, no silent fallback, no coercion.
// Pure function — zero side effects.

import { createHash } from 'node:crypto';
import type {
  AssemblyRequestV0,
  AssemblyErrorV0,
  AssemblyErrorCode,
  PolicyProvenance,
  CandidateEvidence,
  RolePolicyIdentity,
} from './assembly.types';
import {
  MAX_FIELD_LENGTH,
  MAX_CANDIDATES,
  MAX_ATTEMPT_BUDGET,
  MAX_NESTING_DEPTH,
} from './assembly.types';
import { createAssemblyError } from './assembly.errors';

// ---------------------------------------------------------------------------
// Known authoritative fields — any other top-level key that could affect
// execution is rejected as UNKNOWN_EXECUTION_FIELD.
// ---------------------------------------------------------------------------

const KNOWN_REQUEST_FIELDS = new Set([
  'schemaVersion',
  'taskId',
  'causationId',
  'correlationId',
  'tenant',
  'principal',
  'purpose',
  'audience',
  'scope',
  'rolePolicy',
  'candidateSet',
  'deadline',
  'attemptBudget',
  'traceFields',
  'provenance',
]);

// Fields that are allowed to appear in traceFields without shadowing authoritative names
const TRACE_FIELD_BLOCKLIST = new Set([
  'schemaVersion', 'taskId', 'causationId', 'correlationId',
  'tenant', 'principal', 'purpose', 'audience', 'scope',
  'rolePolicy', 'candidateSet', 'deadline', 'attemptBudget',
  'provenance', 'providerConfig', 'modelParameters', 'credentials',
  'apiKey', 'secret', 'token', 'endpoint',
]);

// Credential-like patterns to reject in authoritative fields
const CREDENTIAL_PATTERNS = [
  /^Bearer\s+/i,
  /^sk-/i,
  /^api[_-]?key/i,
  /^akid-/i,
  /^[A-Za-z0-9+/]{40,}={0,2}$/,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate an unknown input against the AssemblyRequestV0 contract.
 * Returns the typed request on success, or a typed AssemblyErrorV0 on failure.
 * Pure function — no side effects.
 */
export function validateAssemblyRequest(
  input: unknown,
): AssemblyRequestV0 | AssemblyErrorV0 {
  // 1. Must be a non-null object
  if (input === null || input === undefined || typeof input !== 'object') {
    return makeError('UNSUPPORTED_SCHEMA_VERSION', '', '', '', {
      reason: 'input must be a non-null object',
      actual: typeof input,
    });
  }

  const req = input as Record<string, unknown>;

  // 2. schemaVersion must be exactly "v0"
  if (req.schemaVersion !== 'v0') {
    return makeError('UNSUPPORTED_SCHEMA_VERSION',
      String(req.taskId ?? ''),
      String(req.causationId ?? ''),
      String(req.correlationId ?? ''),
      {
        reason: 'schemaVersion must be "v0"',
        fieldName: 'schemaVersion',
        expected: 'v0',
        actual: String(req.schemaVersion ?? 'undefined'),
      },
    );
  }

  const taskId = String(req.taskId ?? '');
  const causationId = String(req.causationId ?? '');
  const correlationId = String(req.correlationId ?? '');

  // 3. Required string fields must be present and non-empty
  const requiredStrings = [
    'taskId', 'causationId', 'correlationId',
    'tenant', 'principal', 'purpose', 'audience', 'scope',
  ] as const;

  for (const field of requiredStrings) {
    const val = req[field];
    if (typeof val !== 'string' || val.length === 0) {
      return makeError('UNSAFE_SIZE', taskId, causationId, correlationId, {
        reason: `required field "${field}" must be a non-empty string`,
        fieldName: field,
        actual: typeof val,
      });
    }
  }

  // 4. String length bounds
  const stringBounds: [string, number][] = [
    ['taskId', MAX_FIELD_LENGTH],
    ['causationId', MAX_FIELD_LENGTH],
    ['correlationId', MAX_FIELD_LENGTH],
    ['tenant', 128],
    ['principal', 128],
    ['purpose', MAX_FIELD_LENGTH],
    ['audience', MAX_FIELD_LENGTH],
    ['scope', MAX_FIELD_LENGTH],
  ];

  for (const [field, max] of stringBounds) {
    const val = req[field] as string;
    if (val.length > max) {
      return makeError('UNSAFE_SIZE', taskId, causationId, correlationId, {
        reason: `field "${field}" exceeds max length ${max}`,
        fieldName: field,
        expected: `≤ ${max} chars`,
        actual: `${val.length} chars`,
      });
    }
  }

  // 5. rolePolicy must be present and well-formed
  const rpErr = validateRolePolicy(req.rolePolicy, taskId, causationId, correlationId);
  if (rpErr) return rpErr;

  // 6. candidateSet must be present and well-formed
  const csErr = validateCandidateSet(req.candidateSet, taskId, causationId, correlationId);
  if (csErr) return csErr;

  // 7. provenance must be present and well-formed
  const pvErr = validateProvenance(req.provenance, taskId, causationId, correlationId);
  if (pvErr) return pvErr;

  // 8. deadline if present: valid ISO 8601, not in past
  if (req.deadline !== undefined) {
    if (typeof req.deadline !== 'string') {
      return makeError('DEADLINE_EXCEEDED', taskId, causationId, correlationId, {
        reason: 'deadline must be a string',
        fieldName: 'deadline',
        actual: typeof req.deadline,
      });
    }
    const deadlineDate = new Date(req.deadline);
    if (isNaN(deadlineDate.getTime())) {
      return makeError('DEADLINE_EXCEEDED', taskId, causationId, correlationId, {
        reason: 'deadline is not a valid ISO 8601 date',
        fieldName: 'deadline',
        actual: req.deadline,
      });
    }
    if (deadlineDate.getTime() < Date.now()) {
      return makeError('DEADLINE_EXCEEDED', taskId, causationId, correlationId, {
        reason: 'deadline is in the past',
        fieldName: 'deadline',
        actual: req.deadline,
      });
    }
  }

  // 9. attemptBudget if present: must be finite, safe integer ≥ 1 and ≤ MAX_ATTEMPT_BUDGET
  if (req.attemptBudget !== undefined) {
    // Check for non-finite first — AMBIGUOUS_CANONICAL_VALUE is the more specific error
    if (typeof req.attemptBudget !== 'number' || !Number.isFinite(req.attemptBudget)) {
      return makeError('AMBIGUOUS_CANONICAL_VALUE', taskId, causationId, correlationId, {
        reason: 'attemptBudget is not a finite number — ambiguous canonical value',
        fieldName: 'attemptBudget',
        actual: String(req.attemptBudget),
      });
    }
    if (
      !Number.isSafeInteger(req.attemptBudget) ||
      req.attemptBudget < 1 ||
      req.attemptBudget > MAX_ATTEMPT_BUDGET
    ) {
      return makeError('ATTEMPT_BUDGET_EXCEEDED', taskId, causationId, correlationId, {
        reason: `attemptBudget must be a safe integer between 1 and ${MAX_ATTEMPT_BUDGET}`,
        fieldName: 'attemptBudget',
        expected: `1..${MAX_ATTEMPT_BUDGET}`,
        actual: String(req.attemptBudget),
      });
    }
  }

  // 10. No unknown execution-affecting fields
  for (const key of Object.keys(req)) {
    if (!KNOWN_REQUEST_FIELDS.has(key)) {
      return makeError('UNKNOWN_EXECUTION_FIELD', taskId, causationId, correlationId, {
        reason: `unknown execution-affecting field: "${key}"`,
        fieldName: key,
      });
    }
  }

  // 12. Credential detection in authoritative fields
  const authStringFields = ['tenant', 'principal', 'purpose', 'audience', 'scope'];
  for (const field of authStringFields) {
    const val = req[field] as string;
    for (const pattern of CREDENTIAL_PATTERNS) {
      if (pattern.test(val)) {
        return makeError('CREDENTIAL_IN_PROHIBITED_POSITION', taskId, causationId, correlationId, {
          reason: `credential-shaped value detected in field "${field}"`,
          fieldName: field,
        });
      }
    }
  }

  // 13. traceFields must not shadow authoritative names
  if (req.traceFields !== undefined && typeof req.traceFields === 'object' && req.traceFields !== null) {
    const tf = req.traceFields as Record<string, unknown>;
    for (const key of Object.keys(tf)) {
      if (TRACE_FIELD_BLOCKLIST.has(key)) {
        return makeError('UNKNOWN_EXECUTION_FIELD', taskId, causationId, correlationId, {
          reason: `traceFields key "${key}" shadows an authoritative or prohibited field name`,
          fieldName: `traceFields.${key}`,
        });
      }
    }
  }

  // 14. Nesting depth check
  const depthErr = checkNestingDepth(req, MAX_NESTING_DEPTH);
  if (depthErr) {
    return makeError('UNSAFE_NESTING', taskId, causationId, correlationId, {
      reason: depthErr,
    });
  }

  // All validations passed — return the typed request
  return {
    schemaVersion: 'v0',
    taskId: req.taskId as string,
    causationId: req.causationId as string,
    correlationId: req.correlationId as string,
    tenant: req.tenant as string,
    principal: req.principal as string,
    purpose: req.purpose as string,
    audience: req.audience as string,
    scope: req.scope as string,
    rolePolicy: req.rolePolicy as RolePolicyIdentity,
    candidateSet: req.candidateSet as CandidateEvidence,
    deadline: req.deadline as string | undefined,
    attemptBudget: req.attemptBudget as number | undefined,
    traceFields: req.traceFields as Record<string, unknown> | undefined,
    provenance: req.provenance as PolicyProvenance,
  };
}

// ---------------------------------------------------------------------------
// Sub-validators
// ---------------------------------------------------------------------------

function validateRolePolicy(
  rp: unknown,
  taskId: string,
  causationId: string,
  correlationId: string,
): AssemblyErrorV0 | null {
  if (typeof rp !== 'object' || rp === null) {
    return makeError('UNSAFE_SIZE', taskId, causationId, correlationId, {
      reason: 'rolePolicy must be a non-null object',
      fieldName: 'rolePolicy',
    });
  }
  const r = rp as Record<string, unknown>;
  if (typeof r.policyId !== 'string' || r.policyId.length === 0) {
    return makeError('UNSAFE_SIZE', taskId, causationId, correlationId, {
      reason: 'rolePolicy.policyId must be a non-empty string',
      fieldName: 'rolePolicy.policyId',
    });
  }
  if (typeof r.policyVersion !== 'string' || r.policyVersion.length === 0) {
    return makeError('UNSAFE_SIZE', taskId, causationId, correlationId, {
      reason: 'rolePolicy.policyVersion must be a non-empty string',
      fieldName: 'rolePolicy.policyVersion',
    });
  }
  if (typeof r.roleName !== 'string' || r.roleName.length === 0 || r.roleName.length > 128) {
    return makeError('UNSAFE_SIZE', taskId, causationId, correlationId, {
      reason: 'rolePolicy.roleName must be a non-empty string ≤ 128 chars',
      fieldName: 'rolePolicy.roleName',
    });
  }
  return null;
}

function validateCandidateSet(
  cs: unknown,
  taskId: string,
  causationId: string,
  correlationId: string,
): AssemblyErrorV0 | null {
  if (typeof cs !== 'object' || cs === null) {
    return makeError('UNSAFE_SIZE', taskId, causationId, correlationId, {
      reason: 'candidateSet must be a non-null object',
      fieldName: 'candidateSet',
    });
  }
  const c = cs as Record<string, unknown>;
  if (!Array.isArray(c.candidates) || c.candidates.length === 0 || c.candidates.length > MAX_CANDIDATES) {
    return makeError('UNSAFE_SIZE', taskId, causationId, correlationId, {
      reason: `candidateSet.candidates must be a non-empty array with ≤ ${MAX_CANDIDATES} entries`,
      fieldName: 'candidateSet.candidates',
    });
  }
  for (const entry of c.candidates) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 128) {
      return makeError('UNSAFE_SIZE', taskId, causationId, correlationId, {
        reason: 'each candidate must be a non-empty string ≤ 128 chars',
        fieldName: 'candidateSet.candidates[]',
        actual: String(entry),
      });
    }
  }
  // Validate sourceDigest
  if (typeof c.sourceDigest !== 'string' || !isSha256Hex(c.sourceDigest)) {
    return makeError('INVALID_DIGEST', taskId, causationId, correlationId, {
      reason: 'candidateSet.sourceDigest must be a 64-char lowercase hex SHA-256',
      fieldName: 'candidateSet.sourceDigest',
      actual: String(c.sourceDigest),
    });
  }
  if (typeof c.capturedAt !== 'string' || isNaN(new Date(c.capturedAt).getTime())) {
    return makeError('UNSAFE_SIZE', taskId, causationId, correlationId, {
      reason: 'candidateSet.capturedAt must be a valid ISO 8601 string',
      fieldName: 'candidateSet.capturedAt',
    });
  }
  return null;
}

function validateProvenance(
  pv: unknown,
  taskId: string,
  causationId: string,
  correlationId: string,
): AssemblyErrorV0 | null {
  if (typeof pv !== 'object' || pv === null) {
    return makeError('INVALID_PROVENANCE', taskId, causationId, correlationId, {
      reason: 'provenance must be a non-null object',
      fieldName: 'provenance',
    });
  }
  const p = pv as Record<string, unknown>;

  if (typeof p.policyUri !== 'string' || p.policyUri.length === 0) {
    return makeError('INVALID_PROVENANCE', taskId, causationId, correlationId, {
      reason: 'provenance.policyUri must be a non-empty string',
      fieldName: 'provenance.policyUri',
    });
  }
  if (typeof p.policyDigest !== 'string' || !isSha256Hex(p.policyDigest)) {
    return makeError('INVALID_PROVENANCE', taskId, causationId, correlationId, {
      reason: 'provenance.policyDigest must be a 64-char lowercase hex SHA-256',
      fieldName: 'provenance.policyDigest',
      actual: String(p.policyDigest),
    });
  }
  if (typeof p.issuedAt !== 'string' || isNaN(new Date(p.issuedAt).getTime())) {
    return makeError('INVALID_PROVENANCE', taskId, causationId, correlationId, {
      reason: 'provenance.issuedAt must be a valid ISO 8601 string',
      fieldName: 'provenance.issuedAt',
    });
  }
  if (p.expiresAt !== undefined) {
    if (typeof p.expiresAt !== 'string') {
      return makeError('EXPIRED_POLICY', taskId, causationId, correlationId, {
        reason: 'provenance.expiresAt must be a string if present',
        fieldName: 'provenance.expiresAt',
      });
    }
    const expiryDate = new Date(p.expiresAt);
    if (isNaN(expiryDate.getTime())) {
      return makeError('EXPIRED_POLICY', taskId, causationId, correlationId, {
        reason: 'provenance.expiresAt is not a valid ISO 8601 date',
        fieldName: 'provenance.expiresAt',
      });
    }
    if (expiryDate.getTime() < Date.now()) {
      return makeError('EXPIRED_POLICY', taskId, causationId, correlationId, {
        reason: 'policy has expired',
        fieldName: 'provenance.expiresAt',
        actual: p.expiresAt,
      });
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeError(
  code: AssemblyErrorCode,
  taskId: string,
  causationId: string,
  correlationId: string,
  details: { reason: string; fieldName?: string; expected?: unknown; actual?: unknown },
): AssemblyErrorV0 {
  return createAssemblyError(code, taskId, causationId, correlationId, {
    reason: details.reason,
    fieldName: details.fieldName,
    expected: details.expected,
    actual: details.actual,
  });
}

function isSha256Hex(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}

function checkNestingDepth(obj: unknown, maxDepth: number, currentDepth = 0): string | null {
  if (currentDepth > maxDepth) {
    return `nesting depth ${currentDepth} exceeds maximum ${maxDepth}`;
  }
  if (typeof obj !== 'object' || obj === null) return null;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const err = checkNestingDepth(obj[i], maxDepth, currentDepth + 1);
      if (err) return err;
    }
  } else {
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      const val = (obj as Record<string, unknown>)[key];
      const err = checkNestingDepth(val, maxDepth, currentDepth + 1);
      if (err) return err;
    }
  }
  return null;
}
