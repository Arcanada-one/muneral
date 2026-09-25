// A2-274 (MUN-EVIDENCE): typed error bodies and the value rules for
// `POST /tasks/:taskId/evidence`.
//
// Same convention as `migration.errors.ts`: every failure the caller can act on
// carries a machine-readable `code`, so an unattended executor branches on it
// without parsing prose. The rules live here rather than as DTO decorators
// because class-validator's failures come back through the global pipe, which
// answers `{statusCode, error, message: [...]}` and has no place to put a code.

import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';

export const EVIDENCE_ERROR_CODES = [
  'EVIDENCE_SHA256_MALFORMED',
  'EVIDENCE_URI_MALFORMED',
  'EVIDENCE_URI_HAS_CREDENTIALS',
  'EVIDENCE_CONTENT_TYPE_MALFORMED',
  'EVIDENCE_DIGEST_CONFLICT',
  'EVIDENCE_AGENT_KEY_REQUIRED',
  // A2-336: raised by done-evidence-guard.ts, not by this route.
  'EVIDENCE_REQUIRED_FOR_DONE',
] as const;

export type EvidenceErrorCode = (typeof EVIDENCE_ERROR_CODES)[number];

/** 64 lowercase hex. No `sha256:` prefix — the algorithm is the column, not the
 *  value (unlike `tasks.contract_digest`, which is a KC2 digest string quoted
 *  verbatim from Argana). Lowercase only, so two spellings of one digest can
 *  never become two rows under the unique index. */
export const EVIDENCE_SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const EVIDENCE_URI_MAX = 2048;
export const EVIDENCE_CONTENT_TYPE_MAX = 128;

/** An ABSOLUTE locator: a scheme, then anything without whitespace or control
 *  characters. A bare path (`receipts/graph/x.json`) is refused on purpose — it
 *  resolves only for a reader who already knows which machine and which
 *  checkout wrote it, which is precisely what a cross-agent evidence pointer
 *  cannot assume. */
const URI_PATTERN = /^[a-z][a-z0-9+.-]*:[^\s\u0000-\u001f\u007f]+$/i;

/** `scheme://user:secret@host/...`. Refused before the value is stored: this
 *  string is written to `task_evidence_attachments.uri` AND to the activity
 *  log payload, both of which are read back by routes and exported to the KB.
 *  A locator that needs a credential to resolve does not become safe by being
 *  recorded — the credential belongs in the reader's own configuration. */
const URI_USERINFO_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i;

/** `type/subtype`, optionally with `; key=value` parameters. Lowercase for the
 *  same reason the digest is: the stored value is compared byte for byte when a
 *  repeat attachment is checked against the stored one, so one media type must
 *  have one spelling. */
const CONTENT_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:; ?[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+"-]+)*$/;

export function requireSha256(value: string): string {
  if (!EVIDENCE_SHA256_PATTERN.test(value)) {
    throw new BadRequestException({
      code: 'EVIDENCE_SHA256_MALFORMED' satisfies EvidenceErrorCode,
      message:
        'sha256 must be exactly 64 lowercase hex characters, with no algorithm prefix.',
      field: 'sha256',
    });
  }
  return value;
}

export function requireUri(value: string): string {
  if (value.length > EVIDENCE_URI_MAX || !URI_PATTERN.test(value)) {
    throw new BadRequestException({
      code: 'EVIDENCE_URI_MALFORMED' satisfies EvidenceErrorCode,
      message:
        `uri must be an absolute URI (a scheme, then no whitespace or control characters) of at most ${EVIDENCE_URI_MAX} characters.`,
      field: 'uri',
    });
  }
  if (URI_USERINFO_PATTERN.test(value)) {
    throw new BadRequestException({
      code: 'EVIDENCE_URI_HAS_CREDENTIALS' satisfies EvidenceErrorCode,
      message:
        'uri carries a userinfo component. A locator that embeds a credential is refused rather than stored and logged.',
      field: 'uri',
    });
  }
  return value;
}

export function requireContentType(value: string): string {
  if (value.length > EVIDENCE_CONTENT_TYPE_MAX || !CONTENT_TYPE_PATTERN.test(value)) {
    throw new BadRequestException({
      code: 'EVIDENCE_CONTENT_TYPE_MALFORMED' satisfies EvidenceErrorCode,
      message:
        `contentType must be a lowercase media type such as "application/json", of at most ${EVIDENCE_CONTENT_TYPE_MAX} characters.`,
      field: 'contentType',
    });
  }
  return value;
}

/** The digest is the identity of the attachment, so a repeat that names the
 *  same digest with a DIFFERENT locator or media type is a disagreement about
 *  what those bytes are — not a retry. Answering 200 with the stored row would
 *  tell the caller its own values were recorded when they were not; answering
 *  201 would need a second row for one artefact. Both are refusals to say that
 *  the two claims differ, so the route says it. */
export function digestConflict(
  taskId: string,
  sha256: string,
  stored: { uri: string; contentType: string },
  attempted: { uri: string; contentType: string },
): ConflictException {
  return new ConflictException({
    code: 'EVIDENCE_DIGEST_CONFLICT' satisfies EvidenceErrorCode,
    message:
      `Task ${taskId} already carries evidence with sha256 ${sha256}, attached with a different uri or contentType. ` +
      'The digest identifies the artefact: attach the differing bytes under their own digest, or correct the request.',
    taskId,
    sha256,
    stored_uri: stored.uri,
    stored_content_type: stored.contentType,
    attempted_uri: attempted.uri,
    attempted_content_type: attempted.contentType,
  });
}

/** The attachment records WHICH AGENT produced the evidence
 *  (`created_by_agent_id`, NOT NULL). A JWT names a human, who has no agent id,
 *  so a human-attached row could only exist with that column relaxed — and an
 *  attachment nobody is named for is exactly the unattributable evidence this
 *  table exists to prevent. Reading the list with a JWT is unaffected. */
export function agentKeyRequired(): ForbiddenException {
  return new ForbiddenException({
    code: 'EVIDENCE_AGENT_KEY_REQUIRED' satisfies EvidenceErrorCode,
    message:
      'Evidence is attached by an executing agent, with an agent API key. A JWT may read the list but not attach.',
  });
}
