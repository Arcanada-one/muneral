// MUN-0022: Typed fail-closed assembly errors. Every validation failure
// produces an AssemblyErrorV0 with a deterministic error ID — no exceptions
// thrown, no silent fallback. Follows MUN-0020's typed-error pattern.

import { createHash } from 'node:crypto';
import type {
  AssemblyErrorCode,
  AssemblyErrorV0,
  ErrorDetails,
} from './assembly.types';

// ---------------------------------------------------------------------------
// Default messages per error code
// ---------------------------------------------------------------------------

const DEFAULT_MESSAGES: Record<AssemblyErrorCode, string> = {
  UNSUPPORTED_SCHEMA_VERSION: 'Unsupported schema version',
  UNKNOWN_EXECUTION_FIELD: 'Unknown execution-affecting field in request',
  AMBIGUOUS_CANONICAL_VALUE: 'Ambiguous canonical value — cannot produce deterministic bytes',
  UNSAFE_SIZE: 'Field exceeds maximum allowed size',
  UNSAFE_NESTING: 'Object nesting depth exceeds maximum',
  AUTHORITY_WIDENING: 'Output authority is wider than input authority',
  INVALID_PROVENANCE: 'Invalid or unverifiable policy provenance',
  EXPIRED_POLICY: 'Policy has expired',
  CREDENTIAL_IN_PROHIBITED_POSITION: 'Credential-shaped value found in prohibited position',
  INVALID_DIGEST: 'Digest does not match canonical bytes',
  DEADLINE_EXCEEDED: 'Deadline is in the past or invalid',
  ATTEMPT_BUDGET_EXCEEDED: 'Attempt budget exceeds maximum or is invalid',
  INVALID_TRANSITION: 'Invalid state transition — not an allowed lifecycle edge',
  OUT_OF_SCOPE_MUTATION: 'Mutation targets a node outside the owned scope',
  DUPLICATE_COMPLETION: 'Duplicate completion receipt — already processed',
  CONCURRENT_OWNERSHIP: 'Concurrent version conflict — another actor owns this version',
  OUT_OF_BAND_RESULT: 'Out-of-band result rejected — must use typed CompletionReceiptV0',
  WRONG_PLANE_CONTROL: 'Wrong-plane control field rejected — fleet lifecycle not authorized in Muneral',
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a typed AssemblyErrorV0 with a deterministic error ID.
 *
 * The error ID is SHA-256(code + NUL + taskId + NUL + causationId + NUL +
 * canonical details JSON), making it reproducible for idempotent error replay.
 *
 * @param code — one of the 18 AssemblyErrorCode values
 * @param taskId — MUN-0020 task identifier
 * @param causationId — MUN-0020 causation identifier
 * @param correlationId — MUN-0020 correlation identifier
 * @param details — structured error details (fieldName, expected, actual, reason)
 * @returns a frozen AssemblyErrorV0
 */
export function createAssemblyError(
  code: AssemblyErrorCode,
  taskId: string,
  causationId: string,
  correlationId: string,
  details: ErrorDetails,
): AssemblyErrorV0 {
  const failedAt = new Date().toISOString();
  const message = buildMessage(code, details);

  // Deterministic error ID: hash of the error identity fields.
  // Using NUL separators to avoid ambiguity between field concatenation.
  const idInput = [
    code,
    taskId,
    causationId,
    JSON.stringify(details),
  ].join('\x00');

  const errorId = createHash('sha256').update(idInput, 'utf8').digest('hex');

  return {
    errorId,
    errorCode: code,
    message,
    schemaVersion: 'v0',
    taskId,
    causationId,
    correlationId,
    failedAt,
    details,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMessage(code: AssemblyErrorCode, details: ErrorDetails): string {
  const prefix = DEFAULT_MESSAGES[code];
  if (details.fieldName) {
    return `${prefix}: ${details.reason} (field: ${details.fieldName})`;
  }
  return `${prefix}: ${details.reason}`;
}
