// MUN-0022: pure canonicalization and digest contract.

import { createHash } from 'node:crypto';
import {
  AssemblyCanonicalJsonError,
  assemblyCanonicalJson,
  assemblyParseCanonicalJson,
  canonicalizeDecisionFields,
  computeAssemblyDigest,
  computeCardDigest,
  validateCanonicalValue,
} from '../../src/assembly/assembly.canonical';
import { MAX_NESTING_DEPTH } from '../../src/assembly/assembly.types';
import type { AssemblyRequestV0 } from '../../src/assembly/assembly.types';

function makeRequest(overrides: Partial<AssemblyRequestV0> = {}): AssemblyRequestV0 {
  return {
    schemaVersion: 'v0',
    taskId: 'task-1',
    causationId: 'cause-1',
    correlationId: 'correlation-1',
    authorityCeiling: {
      tenant: 'acme', principal: 'user-1', purpose: 'test', audience: 'internal', scope: 'read,write',
    },
    requestedAuthority: {
      tenant: 'acme', principal: 'user-1', purpose: 'test', audience: 'internal', scope: 'read',
    },
    rolePolicy: { policyId: 'policy-1', policyVersion: 'v1', roleName: 'assistant' },
    candidateSet: {
      candidates: ['assistant'],
      sourceDigest: 'b'.repeat(64),
      capturedAt: '2026-07-30T00:00:00.000Z',
    },
    evidenceRefs: [],
    provenance: {
      policyUri: 'content://policy-1',
      policyDigest: 'c'.repeat(64),
      issuedAt: '2026-07-30T00:00:00.000Z',
    },
    ...overrides,
    evaluatedAt: overrides.evaluatedAt ?? '2026-07-30T00:00:00.000Z',
  };
}

describe('assemblyCanonicalJson', () => {
  it('sorts keys by Unicode code point and emits no whitespace', () => {
    expect(assemblyCanonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(assemblyCanonicalJson({ '\uffff': 1, '\ud800\udc00': 2 })).toBe(
      '{"\\uffff":1,"\\ud800\\udc00":2}',
    );
  });

  it('matches Python ensure_ascii output for non-ASCII text', () => {
    expect(assemblyCanonicalJson({ greeting: '\u041f\u0440\u0438\u0432\u0435\u0442' })).toBe(
      '{"greeting":"\\u041f\\u0440\\u0438\\u0432\\u0435\\u0442"}',
    );
  });

  it.each([
    undefined,
    -0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1.5,
    9_007_199_254_740_992,
    1n,
    Symbol('x'),
    () => undefined,
    new Date('2026-01-01T00:00:00Z'),
  ])('rejects non-canonical value %#', (value) => {
    expect(() => assemblyCanonicalJson(value as never)).toThrow(AssemblyCanonicalJsonError);
  });

  it('rejects cycles, sparse arrays, accessors, and lone surrogates', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const sparse = new Array(2);
    sparse[1] = 1;
    const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get: () => 'x' });

    for (const value of [cycle, sparse, accessor, '\ud800']) {
      expect(() => assemblyCanonicalJson(value as never)).toThrow(AssemblyCanonicalJsonError);
    }
  });

  it('accepts a shared acyclic object', () => {
    const shared = { value: 1 };
    expect(assemblyCanonicalJson({ a: shared, b: shared })).toBe(
      '{"a":{"value":1},"b":{"value":1}}',
    );
  });
});

describe('decision bytes and digest', () => {
  it('is deterministic and excludes trace fields', () => {
    const left = makeRequest({ traceFields: { requestId: 'left' } });
    const right = makeRequest({ traceFields: { requestId: 'right' } });
    expect(canonicalizeDecisionFields(left)).toBe(canonicalizeDecisionFields(right));
    expect(computeCardDigest(left)).toBe(computeCardDigest(right));
  });

  it('changes when an authoritative field changes', () => {
    expect(computeCardDigest(makeRequest({ requestedAuthority: {
      ...makeRequest().requestedAuthority, scope: 'read',
    } }))).not.toBe(
      computeCardDigest(makeRequest({ requestedAuthority: {
        ...makeRequest().requestedAuthority, scope: 'write',
      } })),
    );
  });

  it('hashes the exact canonical decision bytes with no hidden prefix', () => {
    const request = makeRequest();
    const bytes = canonicalizeDecisionFields(request);
    const expected = createHash('sha256').update(bytes, 'utf8').digest('hex');
    expect(computeCardDigest(request)).toBe(expected);
    expect(computeAssemblyDigest(request)).toBe(expected);
  });
});

describe('canonical raw JSON boundary', () => {
  it('parses a canonical safe-integer document', () => {
    expect(assemblyParseCanonicalJson('{"a":[1,2],"b":true}')).toEqual({ a: [1, 2], b: true });
  });

  it.each(['{"n":-0}', '{"n":5.0}', '{"n":1e2}', '{"n":9007199254740992}'])(
    'rejects the numeric token in %s',
    (raw) => expect(() => assemblyParseCanonicalJson(raw)).toThrow(AssemblyCanonicalJsonError),
  );

  it('rejects duplicate decoded object keys', () => {
    expect(() => assemblyParseCanonicalJson('{"a":1,"\\u0061":2}')).toThrow(
      /duplicate object key/,
    );
  });

  it('rejects excessive nesting before recursive parsing', () => {
    const raw = '['.repeat(MAX_NESTING_DEPTH + 10_000) + '0' + ']'.repeat(MAX_NESTING_DEPTH + 10_000);
    expect(() => assemblyParseCanonicalJson(raw)).toThrow(AssemblyCanonicalJsonError);
    expect(() => assemblyParseCanonicalJson(raw)).not.toThrow(RangeError);
  });
});

describe('typed canonical-value boundary', () => {
  const validate = (value: unknown) => validateCanonicalValue(
    value,
    'payload',
    'task-1',
    'cause-1',
    'correlation-1',
  );

  it('returns null for a valid canonical value', () => {
    expect(validate({ answer: [1, true, null, 'ok'] })).toBeNull();
  });

  it('returns a typed rejection for ambiguous values', () => {
    expect(validate({ answer: -0 })?.errorCode).toBe('AMBIGUOUS_CANONICAL_VALUE');
  });

  it('does not throw when inspection traps throw', () => {
    const hostile = new Proxy({}, { getPrototypeOf: () => { throw new Error('trap'); } });
    expect(() => validate(hostile)).not.toThrow();
    expect(validate(hostile)?.errorCode).toBe('AMBIGUOUS_CANONICAL_VALUE');
  });
});
