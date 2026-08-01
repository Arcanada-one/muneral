// MUN-0022 Phase A / A2 — the canonical numeric domain is safe integers, and
// the restriction MUST be enforced lexically on the raw JSON token.
//
// Why a raw-text entry point is required rather than a value-level check:
// `{"attemptBudget": 5.0}` parses to the NUMBER 5 in JavaScript, where
// Number.isSafeInteger(5) is true and canonicalization emits `5`; the same text
// parses to the FLOAT 5.0 in Python, where is_integer() is also true but
// canonicalization emits `5.0`. A per-field integer test therefore passes in
// BOTH languages while still producing divergent canonical bytes. The original
// token is unrecoverable after JSON.parse, so the check must happen before it.
//
// This spec pins the ingestion boundary that makes the rule enforceable.

import {
  assemblyParseCanonicalJson,
  AssemblyCanonicalJsonError,
} from '../../src/assembly/assembly.canonical';

describe('A2: non-integer numeric literals are rejected lexically', () => {
  // The exact case a value-level check cannot catch.
  it('rejects 5.0 — integer-valued but written as a float literal', () => {
    expect(() => assemblyParseCanonicalJson('{"attemptBudget": 5.0}'))
      .toThrow(AssemblyCanonicalJsonError);
  });

  it.each([
    ['float', '{"n": 3.5}'],
    ['negative float', '{"n": -0.25}'],
    ['small exponent', '{"n": 1e-7}'],
    ['large exponent', '{"n": 1e16}'],
    ['explicit positive exponent', '{"n": 1E+3}'],
    ['integer-valued exponent', '{"n": 5e0}'],
    ['trailing-zero float', '{"n": 2.0}'],
    ['nested float', '{"a": {"b": [1, 2.5]}}'],
  ])('rejects %s', (_name, raw) => {
    expect(() => assemblyParseCanonicalJson(raw))
      .toThrow(AssemblyCanonicalJsonError);
  });

  it.each([
    ['plain integer', '{"n": 5}'],
    ['zero', '{"n": 0}'],
    ['negative integer', '{"n": -42}'],
    ['large safe integer', '{"n": 9007199254740991}'],
    ['nested integers', '{"a": {"b": [1, 2, 3]}}'],
    ['no numbers at all', '{"s": "x", "b": true, "z": null}'],
  ])('accepts %s', (_name, raw) => {
    expect(() => assemblyParseCanonicalJson(raw)).not.toThrow();
  });

  // A digit sequence inside a string is not a number token. This is the
  // false-positive class a naive regex over the whole document would hit —
  // every fixture carries 64-char hex digests containing `e` followed by digits.
  it.each([
    ['float-looking string', '{"s": "3.5"}'],
    ['exponent-looking string', '{"s": "1e-7"}'],
    ['hex digest with e+digits', '{"d": "abc1e5def0000000000000000000000000000000000000000000000000000000"}'],
    ['escaped quote before a float-looking run', '{"s": "he said \\"2.5\\""}'],
  ])('does not mistake %s for a number token', (_name, raw) => {
    expect(() => assemblyParseCanonicalJson(raw)).not.toThrow();
  });

  it('returns the parsed value on success', () => {
    expect(assemblyParseCanonicalJson('{"n": 5, "s": "x"}'))
      .toEqual({ n: 5, s: 'x' });
  });

  it('rejects malformed JSON with the same typed error', () => {
    expect(() => assemblyParseCanonicalJson('{"n": }'))
      .toThrow(AssemblyCanonicalJsonError);
  });
});
