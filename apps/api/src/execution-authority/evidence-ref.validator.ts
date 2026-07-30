// MUN-0020: EvidenceRef runtime validation — fail-closed bounds and digest checks.
// Every EvidenceRef must pass this validator before a command is accepted.

import type { EvidenceRef } from './execution-authority.types';

const HEX64_RE = /^[0-9a-f]{64}$/i;
const URI_MAX = 512;
const LABEL_MAX = 128;
const MAX_REFS = 64;
const ALLOWED_FIELDS = new Set(['uri', 'digest', 'contentType', 'label']);

// Tight bounded set — not arbitrary MIME types
const ALLOWED_CONTENT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'application/json',
  'application/x-ndjson',
  'image/png',
  'image/jpeg',
  'application/pdf',
]);

export class EvidenceRefValidationError extends Error {
  public readonly code = 'INVALID_EVIDENCE_REF' as const;

  constructor(
    public readonly ref: EvidenceRef,
    public readonly reason: string,
  ) {
    super(`Invalid evidence reference: ${reason}`);
    this.name = 'EvidenceRefValidationError';
  }
}

/**
 * Validate a single EvidenceRef. Returns null on success, or an error describing
 * the first violation (fail-closed).
 */
export function validateEvidenceRef(
  ref: unknown,
): EvidenceRefValidationError | null {
  if (ref === null || ref === undefined || typeof ref !== 'object') {
    return new EvidenceRefValidationError(
      { uri: '', digest: '', contentType: '' },
      'evidence reference must be a non-null object',
    );
  }

  const r = ref as EvidenceRef;
  const unknownFields = Object.keys(ref).filter(
    (field) => !ALLOWED_FIELDS.has(field),
  );
  if (unknownFields.length > 0) {
    return new EvidenceRefValidationError(
      r,
      `unknown field${unknownFields.length === 1 ? '' : 's'}: ${unknownFields.join(', ')}`,
    );
  }

  if (typeof r.uri !== 'string' || r.uri.length === 0) {
    return new EvidenceRefValidationError(r, 'uri must be a non-empty string');
  }
  if (r.uri.length > URI_MAX) {
    return new EvidenceRefValidationError(
      r,
      `uri exceeds ${URI_MAX} characters`,
    );
  }
  // Reject control characters
  if (/[\x00-\x1f\x7f]/.test(r.uri)) {
    return new EvidenceRefValidationError(
      r,
      'uri must not contain control characters',
    );
  }
  // Reject leading slash/backslash — evidence URIs are relative paths
  if (/^[\/\\]/.test(r.uri)) {
    return new EvidenceRefValidationError(
      r,
      'uri must not begin with slash or backslash',
    );
  }
  // Reject backslash anywhere (Windows-style paths)
  if (r.uri.includes('\\')) {
    return new EvidenceRefValidationError(
      r,
      'uri must not contain backslash',
    );
  }
  // Reject colon anywhere (scheme indicator)
  if (r.uri.includes(':')) {
    return new EvidenceRefValidationError(
      r,
      'uri must not contain a colon (scheme indicator)',
    );
  }
  // Dot/dotdot segments
  if (/\/\.\.?(?:\/|$)/.test(r.uri) || /^\.\.?(?:\/|$)/.test(r.uri)) {
    return new EvidenceRefValidationError(
      r,
      'uri must not contain dot or dot-dot segments',
    );
  }
  // Empty segments (double slash)
  if (/\/\//.test(r.uri)) {
    return new EvidenceRefValidationError(
      r,
      'uri must not contain empty segments (double slash)',
    );
  }

  // digest must be exactly 64 lowercase hex chars
  if (
    typeof r.digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(r.digest)
  ) {
    return new EvidenceRefValidationError(
      r,
      'digest must be a 64-character lowercase hex string (SHA-256)',
    );
  }

  if (
    typeof r.contentType !== 'string' ||
    !ALLOWED_CONTENT_TYPES.has(r.contentType)
  ) {
    return new EvidenceRefValidationError(
      r,
      `contentType must be one of: ${[...ALLOWED_CONTENT_TYPES].join(', ')}`,
    );
  }

  // Optional label: must be bounded, no control characters
  if (r.label !== undefined) {
    if (typeof r.label !== 'string') {
      return new EvidenceRefValidationError(
        r,
        'label must be a string if provided',
      );
    }
    if (r.label.length > LABEL_MAX) {
      return new EvidenceRefValidationError(
        r,
        `label exceeds ${LABEL_MAX} characters`,
      );
    }
    if (/[\x00-\x1f\x7f]/.test(r.label)) {
      return new EvidenceRefValidationError(
        r,
        'label must not contain control characters',
      );
    }
  }

  return null;
}

/**
 * Validate an array of EvidenceRefs. Returns the first error or null.
 */
export function validateEvidenceRefs(
  refs: unknown[],
): EvidenceRefValidationError | null {
  if (!Array.isArray(refs)) {
    return new EvidenceRefValidationError(
      createSentinelRef(),
      'evidenceRefs must be an array',
    );
  }
  if (refs.length > MAX_REFS) {
    return new EvidenceRefValidationError(
      createSentinelRef(),
      `evidenceRefs exceeds maximum count of ${MAX_REFS}`,
    );
  }
  for (const ref of refs) {
    const err = validateEvidenceRef(ref);
    if (err) return err;
  }
  return null;
}

function createSentinelRef(): EvidenceRef {
  return { uri: '', digest: '', contentType: '' };
}
