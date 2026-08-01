// MUN-0022 Phase F — executed cross-language parity.
//
// An adversarial review of the previous revision found the TypeScript and
// Python validators disagreeing on four input classes, every one of them
// invisible to the twelve committed negative fixtures. The same review made the
// companion point about D10: key ordering and UTF-8 byte length were asserted
// only in TypeScript, against literals whose provenance was a comment reading
// "pinned to Python's output" — so if the author's belief about Python had been
// wrong, nothing would have gone red.
//
// Both findings have the same root: parity was ASSERTED in one runtime and
// BELIEVED about the other. This spec removes the belief. It runs the real
// Python module in a subprocess on inputs chosen because they used to diverge,
// and requires the two implementations to agree — on the error code for a
// request, and on the exact canonical bytes for a value.
//
// The fixture corpus is deliberately unchanged by this spec: these are the
// inputs the corpus does not contain, which is precisely why they need a test
// rather than a fixture.

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { validateAssemblyRequest } from '../../src/assembly/assembly.validator';
import {
  assemblyCanonicalJson,
  assemblyParseCanonicalJson,
} from '../../src/assembly/assembly.canonical';
import * as fs from 'node:fs';

/* eslint-disable @typescript-eslint/no-explicit-any */

const VALIDATOR = path.join(__dirname, 'validate_assembly_fixtures.py');
/**
 * Ask the real Python validator for its verdict on one request.
 * Returns the error code, or null when Python considers the input valid.
 */
function pythonCode(input: unknown): string | null {
  const script = `
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location("v", ${JSON.stringify(VALIDATOR)})
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
print(json.dumps(mod.independently_validate(json.load(sys.stdin))))
`;
  const out = execFileSync('python3', ['-c', script], {
    input: JSON.stringify(input), encoding: 'utf8',
  });
  return JSON.parse(out.trim());
}

/** Ask the real Python canonicalizer for the exact bytes of one value. */
function pythonCanonical(value: unknown): string {
  const script = `
import json, sys, importlib.util
spec = importlib.util.spec_from_file_location("v", ${JSON.stringify(VALIDATOR)})
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
sys.stdout.write(mod.canonical_json(json.load(sys.stdin)))
`;
  return execFileSync('python3', ['-c', script], {
    input: JSON.stringify(value), encoding: 'utf8',
  });
}

function pythonFixtureLoaderVerdict(raw: string): string {
  const script = `
import sys, importlib.util, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("v", ${JSON.stringify(VALIDATOR)})
mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".json") as handle:
    handle.write(sys.stdin.read()); handle.flush()
    try:
        mod.load_fixture(Path(handle.name))
        print("accepted")
    except mod.CanonicalError:
        print("rejected")
`;
  return execFileSync('python3', ['-c', script], { input: raw, encoding: 'utf8' }).trim();
}

function tsCode(input: unknown): string | null {
  const r = validateAssemblyRequest(input as never) as any;
  return 'errorCode' in r ? r.errorCode : null;
}

const base = JSON.parse(
  fs.readFileSync(`${__dirname}/fixtures/positive/minimal-request.json`, 'utf8'),
).input as Record<string, unknown>;

const withField = (over: Record<string, unknown>) => ({
  ...JSON.parse(JSON.stringify(base)),
  ...over,
});

const withAuthorityPurpose = (purpose: string) => withField({
  authorityCeiling: { ...(base.authorityCeiling as Record<string, unknown>), purpose },
  requestedAuthority: { ...(base.requestedAuthority as Record<string, unknown>), purpose },
});

describe('parity: the two validators agree on inputs the corpus does not contain', () => {
  // A control first. If python3 were missing or the module failed to import,
  // every case below would "agree" vacuously; this fails loudly instead.
  it('the Python validator is reachable and agrees on the unmodified fixture', () => {
    expect(pythonCode(base)).toBeNull();
    expect(tsCode(base)).toBeNull();
  });

  it.each([
    [
      'rolePolicy carrying a wrong-plane key (Python had no closed-schema check at all)',
      withField({ rolePolicy: { policyId: 'p', policyVersion: 'v1', roleName: 'r', instanceRegistry: 'x' } }),
    ],
    [
      'candidateSet violating TWO rules at once (bad digest + unknown key) — the order case',
      withField({
        candidateSet: {
          candidates: ['a'], sourceDigest: 'not-a-sha', capturedAt: '2026-07-30T00:00:00.000Z', weights: [1],
        },
      }),
    ],
    [
      'provenance violating TWO rules at once (bad digest + unknown key)',
      withField({
        provenance: {
          policyUri: 'u', policyDigest: 'nope', issuedAt: '2026-07-30T00:00:00.000Z', policyOverride: 'admin',
        },
      }),
    ],
    [
      'a 64-hex secret in a field that does not carry digests (exemption was blanket in Python)',
      withAuthorityPurpose('de'.repeat(32)),
    ],
    [
      'a GitHub token (one of the seven patterns Python did not carry)',
      withAuthorityPurpose('ghp_16C7e42F292c6912E7710c838347Ae178B4a'), // gitleaks:allow -- synthetic parity input
    ],
    [
      'an embedded Bearer token',
      withAuthorityPurpose('curl -H "Authorization: Bearer abcdefghijklmnop" https://x'), // gitleaks:allow -- synthetic parity input
    ],
    [
      'a JWT',
      withAuthorityPurpose('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'), // gitleaks:allow -- synthetic parity input
    ],
    [
      'a Slack token',
      withAuthorityPurpose(`xoxb-${'1234567890'}-${'abcdefghij'}`),
    ],
    [
      'an AWS access key id',
      withAuthorityPurpose('AKIAIOSFODNN7EXAMPLE'),
    ],
  ])('agree on: %s', (_label, input) => {
    const ts = tsCode(input);
    const py = pythonCode(input);
    // Both must reject, and with the SAME code. Agreeing on "rejected" while
    // disagreeing on why is how the original parity claim held over the corpus.
    expect(ts).not.toBeNull();
    expect(py).toEqual(ts);
  });

  it.each([
    ['a trace key shadowing a decision field', { traceFields: { deadline: '2027-01-01T00:00:00Z' } }],
    ['a trace key named token', { traceFields: { token: 'abc' } }],
    ['a trace key named credentials', { traceFields: { credentials: 'x' } }],
    ['a trace key shadowing schemaVersion', { traceFields: { schemaVersion: 'v9' } }],
    ['a 64-hex secret under an attacker-named key in traceFields', { traceFields: { digest: 'de'.repeat(32) } }],
    ['an explicitly null traceFields value', { traceFields: null }],
  ])('agree on: %s', (_label, over) => {
    const input = { ...JSON.parse(JSON.stringify(base)), ...over };
    const ts = tsCode(input);
    const py = pythonCode(input);
    expect(ts).not.toBeNull();
    expect(py).toEqual(ts);
  });

  it('agree that a legitimate digest in a digest-bearing field is NOT a credential', () => {
    // The other pole of the scoped exemption: narrowing it must not start
    // rejecting real digests.
    const input = withField({
      candidateSet: {
        candidates: ['assistant'], sourceDigest: 'a'.repeat(64), capturedAt: '2026-07-30T00:00:00.000Z',
      },
    });
    expect(tsCode(input)).toBeNull();
    expect(pythonCode(input)).toBeNull();
  });

  it.each([
    ['an explicitly null EvidenceRef label', null],
    ['an EvidenceRef label exceeding the MUN-0020 UTF-16 limit', '\u{1F600}'.repeat(65)],
  ])('agree on rejecting %s', (_label, label) => {
    const input = withField({
      evidenceRefs: [{
        uri: 'evidence/parity.json',
        digest: 'a'.repeat(64),
        contentType: 'application/json',
        label,
      }],
    });
    expect(tsCode(input)).toBe('INVALID_PROVENANCE');
    expect(pythonCode(input)).toBe('INVALID_PROVENANCE');
  });

  it('agrees that the exact-instant range starts at year 0001', () => {
    const input = withField({ evaluatedAt: '0000-01-01T00:00:00.000Z' });
    expect(tsCode(input)).toBe('AMBIGUOUS_CANONICAL_VALUE');
    expect(pythonCode(input)).toBe('AMBIGUOUS_CANONICAL_VALUE');
  });

  it.each([
    ['evaluatedAt', { evaluatedAt: {} }, 'AMBIGUOUS_CANONICAL_VALUE'],
    [
      'candidateSet.sourceDigest',
      { candidateSet: { ...(base.candidateSet as Record<string, unknown>), sourceDigest: {} } },
      'INVALID_DIGEST',
    ],
    [
      'candidateSet.capturedAt',
      { candidateSet: { ...(base.candidateSet as Record<string, unknown>), capturedAt: {} } },
      'AMBIGUOUS_CANONICAL_VALUE',
    ],
  ])('agrees on exact required type precedence for %s', (_label, override, expected) => {
    const input = withField({ taskId: 'x'.repeat(257), ...override });
    expect(tsCode(input)).toBe(expected);
    expect(pythonCode(input)).toBe(expected);
  });

  it.each([
    [
      'instant semantics before candidate cardinality',
      {
        evaluatedAt: 'not-an-instant',
        candidateSet: { ...(base.candidateSet as Record<string, unknown>), candidates: [] },
      },
      'AMBIGUOUS_CANONICAL_VALUE',
    ],
    [
      'provenance semantics before candidate cardinality',
      {
        provenance: { ...(base.provenance as Record<string, unknown>), policyDigest: 'bad' },
        candidateSet: { ...(base.candidateSet as Record<string, unknown>), candidates: [] },
      },
      'INVALID_PROVENANCE',
    ],
  ])('agrees on %s', (_label, override, expected) => {
    const input = withField(override);
    expect(tsCode(input)).toBe(expected);
    expect(pythonCode(input)).toBe(expected);
  });

  it('agrees that a lone surrogate in an object key is ambiguous canonical data', () => {
    const input = withField({ traceFields: { ['\uD800']: 1 } });
    expect(tsCode(input)).toBe('AMBIGUOUS_CANONICAL_VALUE');
    expect(pythonCode(input)).toBe('AMBIGUOUS_CANONICAL_VALUE');
  });

  it('agrees on the MUN-0020 UTF-16 URI bound for astral characters', () => {
    const input = withField({
      evidenceRefs: [{
        uri: '\u{1F600}'.repeat(257),
        digest: 'a'.repeat(64),
        contentType: 'application/json',
      }],
    });
    expect(tsCode(input)).toBe('INVALID_PROVENANCE');
    expect(pythonCode(input)).toBe('INVALID_PROVENANCE');
  });

  it('rejects lexical negative zero before either JSON loader can collapse it', () => {
    const raw = '{"input":{"attemptBudget":-0}}';
    expect(() => assemblyParseCanonicalJson(raw)).toThrow();
    expect(pythonFixtureLoaderVerdict(raw)).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
// D10, executed rather than believed
// ---------------------------------------------------------------------------

describe('parity: canonical bytes are identical for the cases D10 named', () => {
  it.each([
    ['astral-plane object keys (TS UTF-16 order vs Python code-point order)', { '￿': 1, '\u{1F600}': 2 }],
    ['astral key alongside ASCII', { a: 1, '\u{1F600}': 2, z: 3 }],
    ['multi-byte Cyrillic values', { greeting: 'Привет, мир' }],
    ['emoji values', { e: '😀😀😀' }],
    ['control characters and DEL', { c: '\u0000\u001f\u007f' }],
    ['quotes and backslashes', { q: 'he said "hi"\\n' }],
    ['nested mixed', { outer: { '\u{1F600}': ['я', 42], b: true, n: null } }],
  ])('%s', (_label, value) => {
    // Python is EXECUTED on an astral-keyed object here, rather than its
    // behaviour being pinned as a literal in a TypeScript file with a comment
    // claiming it matches.
    expect(assemblyCanonicalJson(value as any)).toBe(pythonCanonical(value));
  });

  it('the canonicalizers agree that a non-integer is not representable', () => {
    // Both sides must refuse, so neither can silently produce bytes the other
    // will not reproduce. This is D6 stated as a parity property.
    expect(() => assemblyCanonicalJson({ n: 1e-7 } as any)).toThrow();
    expect(() => pythonCanonical({ n: 1e-7 })).toThrow();
  });

  it('the canonicalizers both bound emitted escaped bytes', () => {
    const expanded = '\u00e9'.repeat(200_000);
    expect(() => assemblyCanonicalJson(expanded)).toThrow(/byte budget|resource budget/i);
    expect(() => pythonCanonical(expanded)).toThrow();
  });
});
