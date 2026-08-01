// MUN-0022: Typed fail-closed assembly errors. Every validation failure
// produces an AssemblyErrorV0 with a deterministic error ID — no exceptions
// thrown, no silent fallback. Follows MUN-0020's typed-error pattern.

import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { canonicalJsonV1 } from '../execution-authority/canonical-json-v1';
import { CREDENTIAL_RULES } from './credential-policy-v0.generated';
import { MAX_FIELD_BYTES } from './assembly.types';
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
};

// A pure compiler does not observe failure time. The validator replaces this
// sentinel with the request's validated, authority-supplied evaluatedAt when
// available; malformed inputs retain the deterministic sentinel.
const ERROR_TIME_SENTINEL = '1970-01-01T00:00:00.000Z';
const ERROR_IDENTITY_INSPECTION_CODE_UNITS = MAX_FIELD_BYTES;
const MAX_ERROR_IDENTITY_BIGINT = (1n << 256n) - 1n;
const OPAQUE_IDENTITY_MARKER = Symbol('assembly-error-opaque-identity');

function sha256Bytes(value: Buffer | string, encoding?: BufferEncoding): string {
  const hash = createHash('sha256');
  if (typeof value === 'string') {
    if (encoding === undefined) hash.update(value);
    else hash.update(value, encoding);
  }
  else hash.update(value);
  return hash.digest('hex');
}

/** Hash the exact ECMAScript UTF-16 code units without Unicode replacement. */
function sha256Utf16BeCodeUnits(value: string): string {
  const hash = createHash('sha256');
  const unitsPerChunk = 16_384;
  const buffer = Buffer.allocUnsafe(Math.min(value.length, unitsPerChunk) * 2);
  for (let offset = 0; offset < value.length; offset += unitsPerChunk) {
    const count = Math.min(unitsPerChunk, value.length - offset);
    for (let index = 0; index < count; index++) {
      buffer.writeUInt16BE(value.charCodeAt(offset + index), index * 2);
    }
    hash.update(buffer.subarray(0, count * 2));
  }
  return hash.digest('hex');
}

function opaqueIdentity(className: string, observedLength?: number): unknown {
  return {
    type: 'opaque',
    class: className,
    ...(observedLength === undefined ? {} : { observedLength }),
  };
}

function opaqueIdentityField(className: string, observedLength?: number): unknown {
  return {
    kind: 'assembly-error-identity-opaque-v0',
    class: className,
    ...(observedLength === undefined ? {} : { observedLength }),
  };
}

function digestIdentityField(identity: unknown): unknown {
  return { kind: 'assembly-error-identity-digest-v0', identity };
}

/** Internal trap-free marker carried from a failed request capture. */
export function createAssemblyErrorOpaqueIdentity(className: string): unknown {
  return Object.freeze({ [OPAQUE_IDENTITY_MARKER]: className });
}

function opaqueIdentityMarkerClass(value: unknown): string | undefined {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, OPAQUE_IDENTITY_MARKER);
    return typeof descriptor?.value === 'string' ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function stringIdentity(value: string): unknown {
  if (value.length > ERROR_IDENTITY_INSPECTION_CODE_UNITS) {
    return opaqueIdentity('string-over-inspection-budget', value.length);
  }
  return {
    type: 'string',
    encoding: 'utf-16be-code-units',
    codeUnitLength: value.length,
    sha256: sha256Utf16BeCodeUnits(value),
  };
}

function numberIdentity(value: number): unknown {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeDoubleBE(value);
  return {
    type: 'number',
    encoding: 'ieee-754-binary64-be',
    byteLength: bytes.length,
    sha256: sha256Bytes(bytes),
  };
}

function bigintIdentity(value: bigint): unknown {
  if (value > MAX_ERROR_IDENTITY_BIGINT || value < -MAX_ERROR_IDENTITY_BIGINT) {
    return opaqueIdentity('bigint-over-inspection-budget');
  }
  const material = value.toString(10);
  return {
    type: 'bigint',
    encoding: 'signed-decimal-ascii',
    byteLength: material.length,
    sha256: sha256Bytes(material, 'ascii'),
  };
}

function canonicalContainerIdentityField(value: object): unknown {
  try {
    const canonical = canonicalJsonV1(value);
    return digestIdentityField({
      type: Array.isArray(value) ? 'array' : 'object',
      encoding: 'canonical-json-v1-utf8',
      byteLength: Buffer.byteLength(canonical, 'utf8'),
      sha256: sha256Bytes(canonical, 'utf8'),
    });
  } catch {
    return opaqueIdentityField(Array.isArray(value) ? 'uninspectable-array' : 'uninspectable-object');
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Canonical bytes for the error details, for the deterministic error id.
 *
 * Optional detail fields are frequently present-but-undefined, and the canonical
 * serializer REFUSES undefined by design (it is not injective: `{a: undefined}`
 * and `{}` would collide). Those keys are therefore omitted rather than
 * serialized — which is the same decision the canonical form makes for absent
 * keys, so the result stays injective over the values that survive.
 *
 * Wrapped so this can never throw. It is called from the error CONSTRUCTOR: a
 * throw here would turn every refusal into an exception, which is precisely the
 * failure this package spends its effort eliminating. If details cannot be
 * canonicalized for any reason, the id degrades to a stable marker rather than
 * taking the boundary down.
 */
function identityValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null) return null;
  if ((typeof value === 'object' || typeof value === 'function') && utilTypes.isProxy(value)) {
    return opaqueIdentity('proxy');
  }
  const kind = typeof value;
  if (kind === 'string') {
    return stringIdentity(value as string);
  }
  if (kind === 'number') {
    return numberIdentity(value as number);
  }
  if (kind === 'boolean') return { type: 'boolean', value };
  if (kind === 'undefined') return { type: kind };
  if (kind === 'bigint') {
    return bigintIdentity(value as bigint);
  }
  if (kind === 'symbol') {
    return opaqueIdentity('symbol');
  }
  if (kind === 'function') {
    return opaqueIdentity('function');
  }
  const object = value as object;
  if (value instanceof Date) {
    const material = Number.isNaN(value.valueOf()) ? 'invalid' : value.toISOString();
    return { type: 'Date', value: material };
  }
  if (seen.has(object)) return { type: 'reference' };
  seen.add(object);
  try {
    if (Array.isArray(value)) {
      return { type: 'array', values: value.map((entry) => identityValue(entry, seen)) };
    }
    const descriptors = Object.getOwnPropertyDescriptors(object);
    const fields = Object.keys(descriptors).sort().map((key) => {
      const descriptor = descriptors[key];
      return descriptor.get || descriptor.set
        ? { key: identityValue(key), value: { type: 'accessor' } }
        : { key: identityValue(key), value: identityValue(descriptor.value, seen) };
    });
    return { type: 'object', fields };
  } catch {
    return { type: 'uninspectable-object' };
  }
}

function canonicalDetails(details: ErrorDetails): string {
  try {
    const defined: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(details as unknown as Record<string, unknown>)) {
      if (value !== undefined) defined[key] = value;
    }
    // Ordinary structured details follow the written identity formula exactly.
    return canonicalJsonV1(defined);
  } catch {
    // Exotic internal callers remain total without reflecting through Proxies
    // or leaking their values. Public validator details never take this path.
    try { return canonicalJsonV1(identityValue(details)); }
    catch { return canonicalJsonV1({ type: 'uninspectable-details' }); }
  }
}

function canonicalErrorIdInput(
  code: AssemblyErrorCode,
  taskId: unknown,
  causationId: unknown,
  correlationId: unknown,
  details: ErrorDetails,
): string {
  const canonicalDetailsText = canonicalDetails(details);
  const identity = {
    kind: 'assembly-error-id-v0',
    errorCode: code,
    taskId: errorIdentityField(taskId),
    causationId: errorIdentityField(causationId),
    correlationId: errorIdentityField(correlationId),
  };
  try {
    return canonicalJsonV1({ ...identity, canonicalDetails: canonicalDetailsText });
  } catch {
    // The ordinary formula embeds canonical JSON as a JSON string. Escape-heavy
    // details can therefore fit their own output budget but exceed it when
    // embedded a second time. Bind the exact first serialization through a
    // fixed-size descriptor; every ordinary in-budget preimage stays unchanged.
    // All identity members above are already inert, bounded canonical values,
    // so size is the only expected failure. The defensive catch also preserves
    // totality if a future canonicalizer adds another refusal for large strings.
    return canonicalJsonV1({
      ...identity,
      canonicalDetails: {
        kind: 'assembly-error-details-digest-v0',
        encoding: 'canonical-json-v1-utf8',
        byteLength: Buffer.byteLength(canonicalDetailsText, 'utf8'),
        sha256: sha256Bytes(canonicalDetailsText, 'utf8'),
      },
    });
  }
}

function errorIdentityField(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      if (
        value.length > 0
        && value.length <= ERROR_IDENTITY_INSPECTION_CODE_UNITS
        && Buffer.byteLength(value, 'utf8') <= MAX_FIELD_BYTES
      ) {
      // Preserve the normative raw-field formula for every admitted identity.
      // The canonicalizer call also proves that the string has no lone surrogate.
        canonicalJsonV1(value);
        return value;
      }
    } catch {
      // Fall through to the exact code-unit descriptor for malformed strings.
    }
    if (value.length > ERROR_IDENTITY_INSPECTION_CODE_UNITS) {
      return opaqueIdentityField('string-over-inspection-budget', value.length);
    }
    return digestIdentityField(stringIdentity(value));
  }
  if ((typeof value === 'object' || typeof value === 'function') && value !== null && utilTypes.isProxy(value)) {
    return opaqueIdentityField('proxy');
  }
  const markerClass = opaqueIdentityMarkerClass(value);
  if (markerClass !== undefined) return opaqueIdentityField(markerClass);
  if (typeof value === 'function' || typeof value === 'symbol') {
    return opaqueIdentityField(typeof value === 'function' ? 'function' : 'symbol');
  }
  if (typeof value === 'bigint' && (value > MAX_ERROR_IDENTITY_BIGINT || value < -MAX_ERROR_IDENTITY_BIGINT)) {
    return opaqueIdentityField('bigint-over-inspection-budget');
  }
  if (value !== null && typeof value === 'object') return canonicalContainerIdentityField(value);
  return digestIdentityField(
    typeof value === 'number'
      ? numberIdentity(value)
      : identityValue(value),
  );
}

const CREDENTIAL_SHAPES = CREDENTIAL_RULES.map(
  ([id, source, flags]) => ({ id, pattern: new RegExp(source, flags) }),
);

export function credentialRuleId(value: string): string | null {
  return CREDENTIAL_SHAPES.find(({ pattern }) => pattern.test(value))?.id ?? null;
}

/** One policy for both request rejection and error-output redaction. */
export function containsCredentialShape(value: string): boolean {
  return credentialRuleId(value) !== null;
}

function safeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (value.length > 512 || containsCredentialShape(value)) return '';
  try {
    canonicalJsonV1(value);
    return value;
  } catch {
    return '';
  }
}

function sanitizeDetailValue(value: unknown): unknown {
  if (typeof value === 'string') return safeText(value) || '<redacted>';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  return typeof value;
}

function sanitizeDetails(details: ErrorDetails): ErrorDetails {
  try {
    let reason = safeText(details.reason);
    if (!reason) reason = 'input rejected without echoing unsafe content';
    const fieldName = details.fieldName === undefined ? undefined : safeText(details.fieldName);
    return Object.freeze({
      reason,
      ...(fieldName ? { fieldName } : {}),
      ...(details.expected !== undefined ? { expected: sanitizeDetailValue(details.expected) } : {}),
      ...(details.actual !== undefined ? { actual: sanitizeDetailValue(details.actual) } : {}),
    });
  } catch {
    return Object.freeze({ reason: 'input rejected without echoing unsafe content' });
  }
}

/**
 * Create a typed AssemblyErrorV0 with a deterministic error ID.
 *
 * The error ID is SHA-256 over a strict canonical `assembly-error-id-v0`
 * projection, making it reproducible and unambiguous for idempotent replay.
 *
 * @param code — one of the 12 AssemblyErrorCode values
 * @param taskId — MUN-0020 task identifier
 * @param causationId — MUN-0020 causation identifier
 * @param correlationId — MUN-0020 correlation identifier
 * @param details — structured error details (fieldName, expected, actual, reason)
 * @returns a frozen AssemblyErrorV0
 */
export function createAssemblyError(
  code: AssemblyErrorCode,
  taskId: unknown,
  causationId: unknown,
  correlationId: unknown,
  details: ErrorDetails,
): AssemblyErrorV0 {
  const returnedTaskId = safeText(taskId);
  const returnedCausationId = safeText(causationId);
  const returnedCorrelationId = safeText(correlationId);
  const returnedDetails = sanitizeDetails(details);
  const failedAt = ERROR_TIME_SENTINEL;
  const message = buildMessage(code, returnedDetails);

  // Deterministic error ID: hash of the error identity fields.
  //
  // The details are serialized with the PACKAGE'S OWN canonicalizer, not
  // JSON.stringify. `JSON.stringify` is insertion-order dependent, so two errors
  // with identical details built in different key order produced different ids —
  // in a package whose entire premise is that identity bytes reproduce across
  // runtimes. The docstring claimed "canonical details JSON"; now it is one.
  //
  // A prior NUL-delimited preimage was ambiguous because bounded identity
  // strings may themselves contain NUL. A typed canonical projection preserves
  // every field boundary without silently narrowing the public string domain.
  // Valid admitted identities remain raw strings. Malformed or oversized
  // runtime identities use a tagged, hash-bound descriptor so error construction
  // stays total without placing attacker-sized material into canonical output.
  const idInput = canonicalErrorIdInput(code, taskId, causationId, correlationId, details);

  const errorId = createHash('sha256').update(idInput, 'utf8').digest('hex');

  return Object.freeze({
    errorId,
    errorCode: code,
    message,
    schemaVersion: 'v0',
    taskId: returnedTaskId,
    causationId: returnedCausationId,
    correlationId: returnedCorrelationId,
    failedAt,
    details: Object.freeze(returnedDetails),
  });
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
