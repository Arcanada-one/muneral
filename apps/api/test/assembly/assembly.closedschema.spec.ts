// MUN-0022 Phase A / A5 — nested objects are closed schemas.
//
// `validateRolePolicy` already rejects unknown keys, but `validateCandidateSet`
// and `validateProvenance` do not, and both sub-objects are passed through to
// the card by reference. The canonicalizer then enumerates a fixed field list,
// so an injected key is silently dropped from the hashed bytes.
//
// The harm is twofold and was reproduced on the pre-A5 code:
//   1. Digest collision — a request carrying `provenance.policyOverride` and one
//      without it produce the SAME cardDigest, so the two are indistinguishable
//      by content address.
//   2. Card tamper bypass — because the digest is unchanged, `authenticateCard`
//      recomputes it successfully and reports no tampering. A card therefore
//      does not authenticate its own provenance body.
//
// This contradicts the task contract directly: "Unknown execution-affecting data
// must never be silently ignored."

import { validateAssemblyRequest } from '../../src/assembly/assembly.validator';
import { computeCardDigest } from '../../src/assembly/assembly.canonical';
import * as fs from 'node:fs';

const base = JSON.parse(
  fs.readFileSync(__dirname + '/fixtures/positive/full-request.json', 'utf8'),
).input as Record<string, unknown>;

function clone(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(base));
}

function errorCodeOf(req: Record<string, unknown>): string | undefined {
  return (validateAssemblyRequest(req) as { errorCode?: string }).errorCode;
}

describe('A5: candidateSet and provenance reject unknown keys', () => {
  it('accepts the unmodified fixture (guards against over-rejection)', () => {
    expect(errorCodeOf(clone())).toBeUndefined();
  });

  it('rejects an unknown key on provenance', () => {
    const req = clone();
    (req.provenance as Record<string, unknown>).policyOverride = 'admin-escalate';
    expect(errorCodeOf(req)).toBe('UNKNOWN_EXECUTION_FIELD');
  });

  it('rejects an unknown key on candidateSet', () => {
    const req = clone();
    (req.candidateSet as Record<string, unknown>).weights = [1, 2, 3];
    expect(errorCodeOf(req)).toBe('UNKNOWN_EXECUTION_FIELD');
  });

  // The reason the gap matters: without rejection the injected field never
  // reaches the digest, so two semantically different requests collide.
  it('no longer permits a digest collision via an injected provenance key', () => {
    const clean = clone();
    const tampered = clone();
    (tampered.provenance as Record<string, unknown>).policyOverride = 'admin-escalate';

    // Pre-A5 these were byte-identical. The injected request must now be
    // rejected outright rather than silently hashing to the same value.
    expect(errorCodeOf(tampered)).toBe('UNKNOWN_EXECUTION_FIELD');

    // The clean request is still accepted — the rejection above is specific to
    // the injected key, not blanket.
    expect(errorCodeOf(clean)).toBeUndefined();

    // The line that used to sit here compared `computeCardDigest(clean)` to
    // itself, inside a test about clean-vs-tampered: vacuous by construction.
    // The claim worth pinning is that provenance is decision-bearing at all —
    // if it were not, an injected provenance key could never have collided the
    // digest in the first place, and rejecting it would be protecting nothing.
    const otherProvenance = clone();
    (otherProvenance.provenance as Record<string, unknown>).policyDigest = 'd'.repeat(64);
    expect(computeCardDigest(otherProvenance as never))
      .not.toBe(computeCardDigest(clean as never));
  });

  it.each([
    ['provenance', 'policyUri'],
    ['provenance', 'policyDigest'],
    ['provenance', 'issuedAt'],
    ['provenance', 'expiresAt'],
    ['candidateSet', 'candidates'],
    ['candidateSet', 'sourceDigest'],
    ['candidateSet', 'capturedAt'],
  ])('still accepts the legitimate field %s.%s', (parent, field) => {
    const req = clone();
    expect(Object.keys(req[parent] as object)).toContain(field);
    expect(errorCodeOf(req)).toBeUndefined();
  });

  it('names the offending field in the error', () => {
    const req = clone();
    (req.provenance as Record<string, unknown>).policyOverride = 'x';
    const result = validateAssemblyRequest(req) as { message?: string };
    expect(result.message).toContain('policyOverride');
  });
});
