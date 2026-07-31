// MUN-0021 adoption gate: domain-separated canonical digests.
//
// The instruction, projection and result integrity domains are distinct:
//
//   cardDigest       = sha256("task-card-v0\0"                 + canonicalCardBytes)
//   projectionDigest = sha256("task-card-projection-v0\0"      + canonicalProjectionBytes)
//   resultDigest     = sha256("task-card-result-node-v0\0"     + canonicalCommittedNodeBytes)
//   resultRefId      = sha256("muneral-result-ref-v0\0"        + canonicalReferenceFields)
//   receiptId        = sha256("assembly-completion-receipt-v0\0" + canonicalReceiptFields)
//
// Domain separation is what makes `receipt.digest == projection.cardDigest`
// impossible to reconstruct: a completion claim can never be derived from
// instructions alone.

import { createHash } from 'node:crypto';

import { canonicalJson } from '../execution-authority/canonical-json';
import type { JsonValue } from '../execution-authority/canonical-json';
import {
  DOMAIN_CARD,
  DOMAIN_PROJECTION,
  DOMAIN_RECEIPT,
  DOMAIN_RESULT_NODE,
  DOMAIN_RESULT_REF,
} from './result-authority.types';
import type {
  CommittedResultRefV0,
  CompletionReceiptV0,
  Sha256Hex,
} from './result-authority.types';

/**
 * SHA-256 over `domain`, a NUL separator, and the canonical JSON bytes of
 * `value`. The NUL byte cannot appear in the domain constants, so no two
 * (domain, value) pairs can collide by concatenation.
 */
export function domainDigest(domain: string, value: unknown): Sha256Hex {
  const bytes = canonicalJson(value as JsonValue);
  return createHash('sha256')
    .update(`${domain}\0${bytes}`, 'utf8')
    .digest('hex');
}

/** Digest of the Task Card instruction bytes. */
export function cardDigest(card: unknown): Sha256Hex {
  return domainDigest(DOMAIN_CARD, card);
}

/** Digest of the Task Card projection bytes. */
export function projectionDigest(projection: unknown): Sha256Hex {
  return domainDigest(DOMAIN_PROJECTION, projection);
}

/** Digest of the committed result node bytes. */
export function resultNodeDigest(node: unknown): Sha256Hex {
  return domainDigest(DOMAIN_RESULT_NODE, node);
}

/** Identity of a committed-result reference — every field except its own id. */
export function computeResultRefId(
  ref: Omit<CommittedResultRefV0, 'resultRefId'>,
): Sha256Hex {
  return domainDigest(DOMAIN_RESULT_REF, ref);
}

/** Identity of a completion receipt — every field except its own id. */
export function computeReceiptId(
  receipt: Omit<CompletionReceiptV0, 'receiptId'>,
): Sha256Hex {
  return domainDigest(DOMAIN_RECEIPT, receipt);
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** True when `value` is a lowercase 64-character hexadecimal SHA-256 digest. */
export function isSha256Hex(value: unknown): value is Sha256Hex {
  return typeof value === 'string' && SHA256_HEX.test(value);
}
