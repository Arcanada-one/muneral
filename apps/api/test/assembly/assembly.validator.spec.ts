// MUN-0022: Validator tests — recursive credential check, strict traceFields
// type validation, and all 12 error codes. Fail-closed: every invalid input
// produces a typed error.

import { validateAssemblyRequest } from '../../src/assembly/assembly.validator';
import type { AssemblyRequestV0, AssemblyErrorV0 } from '../../src/assembly/assembly.types';
import { FIXTURE_EVALUATED_AT } from './fixture-instant';

function validRequest(): AssemblyRequestV0 {
  return {
    schemaVersion: 'v0', taskId: 'task-1', causationId: 'caus-1', correlationId: 'corr-1',
    evaluatedAt: FIXTURE_EVALUATED_AT,
    authorityCeiling: { tenant: 'acme', principal: 'user-1', purpose: 'test', audience: 'internal', scope: 'read,write' },
    requestedAuthority: { tenant: 'acme', principal: 'user-1', purpose: 'test', audience: 'internal', scope: 'read' },
    rolePolicy: { policyId: 'policy-sha256', policyVersion: 'v1', roleName: 'assistant' },
    candidateSet: { candidates: ['assistant', 'reviewer'], sourceDigest: 'b'.repeat(64), capturedAt: '2026-07-30T00:00:00.000Z' },
    evidenceRefs: [],
    provenance: { policyUri: 'content://policy-sha256', policyDigest: 'c'.repeat(64), issuedAt: '2026-07-30T00:00:00.000Z' },
  };
}

function expectError(result: AssemblyRequestV0 | AssemblyErrorV0, expectedCode: string): void {
  expect('errorCode' in result).toBe(true);
  const err = result as AssemblyErrorV0;
  expect(err.errorCode).toBe(expectedCode);
  expect(err.schemaVersion).toBe('v0');
  expect(typeof err.errorId).toBe('string');
  expect(err.errorId).toHaveLength(64);
}

function expectOk(result: AssemblyRequestV0 | AssemblyErrorV0): void {
  if ('errorCode' in result) {
    const err = result as AssemblyErrorV0;
    throw new Error(`Expected OK but got error ${err.errorCode}: ${err.message}`);
  }
  expect(result.schemaVersion).toBe('v0');
}

// ---------------------------------------------------------------------------
// Positive
// ---------------------------------------------------------------------------

describe('validateAssemblyRequest — positive', () => {
  it('accepts a valid minimal request', () => {
    expectOk(validateAssemblyRequest(validRequest()));
  });

  it('accepts request with deadline and attemptBudget', () => {
    expectOk(validateAssemblyRequest({ ...validRequest(), deadline: '2027-01-01T00:00:00.000Z', attemptBudget: 5 }));
  });

  it('accepts request with traceFields', () => {
    expectOk(validateAssemblyRequest({ ...validRequest(), traceFields: { requestId: 'abc-123' } }));
  });
});

describe('validateAssemblyRequest — controlling fail-fast order', () => {
  function codeAndField(input: Record<string, unknown>): [string, string | undefined] {
    const result = validateAssemblyRequest(input);
    if (!('errorCode' in result)) throw new Error('expected refusal');
    return [result.errorCode, result.details.fieldName];
  }

  it('checks required field types before unknown fields', () => {
    const input = { ...validRequest(), providerConfig: {} } as Record<string, unknown>;
    delete input.taskId;
    expect(codeAndField(input)).toEqual(['UNSAFE_SIZE', 'taskId']);
  });

  it.each([
    [
      'evaluated instant',
      { evaluatedAt: {} },
      ['AMBIGUOUS_CANONICAL_VALUE', 'evaluatedAt'],
    ],
    [
      'role policy field',
      { rolePolicy: { ...validRequest().rolePolicy, policyId: 1 } },
      ['UNSAFE_SIZE', 'rolePolicy.policyId'],
    ],
    [
      'candidate source digest',
      { candidateSet: { ...validRequest().candidateSet, sourceDigest: {} } },
      ['INVALID_DIGEST', 'candidateSet.sourceDigest'],
    ],
    [
      'candidate capture instant',
      { candidateSet: { ...validRequest().candidateSet, capturedAt: {} } },
      ['AMBIGUOUS_CANONICAL_VALUE', 'candidateSet.capturedAt'],
    ],
    [
      'provenance field',
      { provenance: { ...validRequest().provenance, policyUri: 1 } },
      ['INVALID_PROVENANCE', 'provenance.policyUri'],
    ],
  ])('rejects a non-string required %s without throwing', (_label, override, expected) => {
    expect(() => codeAndField({ ...validRequest(), ...override } as Record<string, unknown>)).not.toThrow();
    expect(codeAndField({ ...validRequest(), ...override } as Record<string, unknown>)).toEqual(expected);
  });

  it.each([
    ['evaluatedAt', { evaluatedAt: ['2026-07-30T00:00:00.000Z'] }, ['AMBIGUOUS_CANONICAL_VALUE', 'evaluatedAt']],
    [
      'candidateSet.sourceDigest',
      { candidateSet: { ...validRequest().candidateSet, sourceDigest: ['b'.repeat(64)] } },
      ['INVALID_DIGEST', 'candidateSet.sourceDigest'],
    ],
    [
      'candidateSet.capturedAt',
      { candidateSet: { ...validRequest().candidateSet, capturedAt: ['2026-07-30T00:00:00.000Z'] } },
      ['AMBIGUOUS_CANONICAL_VALUE', 'candidateSet.capturedAt'],
    ],
  ])('checks required %s type before an earlier bounded-field failure', (_label, override, expected) => {
    const input = { ...validRequest(), taskId: 'x'.repeat(257), ...override } as Record<string, unknown>;
    expect(() => codeAndField(input)).not.toThrow();
    expect(codeAndField(input)).toEqual(expected);
  });

  it.each([
    [
      'authority field',
      { authorityCeiling: { ...validRequest().authorityCeiling, tenant: 'x'.repeat(257) } },
      ['AUTHORITY_WIDENING', 'authorityCeiling.tenant'],
    ],
    [
      'candidate identifier',
      { candidateSet: { ...validRequest().candidateSet, candidates: ['x'.repeat(129)] } },
      ['UNSAFE_SIZE', 'candidateSet.candidates'],
    ],
  ])('enforces the byte bound for every bounded %s family', (_label, override, expected) => {
    expect(codeAndField({ ...validRequest(), ...override } as Record<string, unknown>)).toEqual(expected);
  });

  it.each([
    ['expiry', { provenance: { ...validRequest().provenance, expiresAt: null } }, ['EXPIRED_POLICY', 'provenance.expiresAt']],
    ['deadline', { deadline: null }, ['DEADLINE_EXCEEDED', 'deadline']],
  ])('rejects a non-string optional %s instant at the instant phase', (_label, override, expected) => {
    expect(codeAndField({ ...validRequest(), ...override } as Record<string, unknown>)).toEqual(expected);
  });

  it('checks deadline and budget before provenance, candidate, unknown, credential, and authority', () => {
    const input = {
      ...validRequest(),
      deadline: '2020-01-01T00:00:00.000Z',
      attemptBudget: 0,
      provenance: { ...validRequest().provenance, policyDigest: 'bad' },
      candidateSet: { ...validRequest().candidateSet, sourceDigest: 'bad' },
      providerConfig: {},
      traceFields: { note: 'Bearer synthetic-example' },
      requestedAuthority: { ...validRequest().requestedAuthority, tenant: 'other' },
    } as Record<string, unknown>;
    expect(codeAndField(input)).toEqual(['DEADLINE_EXCEEDED', 'deadline']);
    delete input.deadline;
    expect(codeAndField(input)).toEqual(['ATTEMPT_BUDGET_EXCEEDED', 'attemptBudget']);
  });

  it('checks instants, deadline, budget, and provenance before candidate cardinality', () => {
    const input = {
      ...validRequest(),
      evaluatedAt: 'not-an-instant',
      deadline: '2020-01-01T00:00:00.000Z',
      attemptBudget: 0,
      provenance: { ...validRequest().provenance, policyDigest: 'bad' },
      candidateSet: { ...validRequest().candidateSet, candidates: [] },
    } as Record<string, unknown>;

    expect(codeAndField(input)).toEqual(['AMBIGUOUS_CANONICAL_VALUE', 'evaluatedAt']);
    input.evaluatedAt = validRequest().evaluatedAt;
    expect(codeAndField(input)).toEqual(['DEADLINE_EXCEEDED', 'deadline']);
    delete input.deadline;
    expect(codeAndField(input)).toEqual(['ATTEMPT_BUDGET_EXCEEDED', 'attemptBudget']);
    delete input.attemptBudget;
    expect(codeAndField(input)).toEqual(['INVALID_PROVENANCE', 'provenance.policyDigest']);
    input.provenance = validRequest().provenance;
    expect(codeAndField(input)).toEqual(['UNSAFE_SIZE', 'candidateSet.candidates']);
  });

  it('checks provenance then candidate then unknown then credentials then authority then evidence', () => {
    const input = {
      ...validRequest(),
      provenance: { ...validRequest().provenance, policyDigest: 'bad' },
      candidateSet: { ...validRequest().candidateSet, sourceDigest: 'bad' },
      providerConfig: {},
      traceFields: { note: 'Bearer synthetic-example' },
      requestedAuthority: { ...validRequest().requestedAuthority, tenant: 'other' },
      evidenceRefs: null,
    } as Record<string, unknown>;
    expect(codeAndField(input)).toEqual(['INVALID_PROVENANCE', 'evidenceRefs']);

    input.evidenceRefs = [];
    expect(codeAndField(input)).toEqual(['INVALID_PROVENANCE', 'provenance.policyDigest']);
    input.provenance = validRequest().provenance;
    expect(codeAndField(input)).toEqual(['INVALID_DIGEST', 'candidateSet.sourceDigest']);
    input.candidateSet = validRequest().candidateSet;
    expect(codeAndField(input)).toEqual(['UNKNOWN_EXECUTION_FIELD', 'providerConfig']);
    delete input.providerConfig;
    expect(codeAndField(input)).toEqual(['CREDENTIAL_IN_PROHIBITED_POSITION', 'traceFields.note']);
    input.traceFields = { note: 'ordinary' };
    expect(codeAndField(input)).toEqual(['AUTHORITY_WIDENING', 'requestedAuthority.tenant']);
  });
});

// ---------------------------------------------------------------------------
// UNSUPPORTED_SCHEMA_VERSION
// ---------------------------------------------------------------------------

describe('UNSUPPORTED_SCHEMA_VERSION', () => {
  it('rejects null', () => expectError(validateAssemblyRequest(null), 'UNSUPPORTED_SCHEMA_VERSION'));
  it('rejects non-object', () => expectError(validateAssemblyRequest('str'), 'UNSUPPORTED_SCHEMA_VERSION'));
  it('rejects schemaVersion "v1"', () => expectError(validateAssemblyRequest({ ...validRequest(), schemaVersion: 'v1' as any }), 'UNSUPPORTED_SCHEMA_VERSION'));
});

// ---------------------------------------------------------------------------
// UNKNOWN_EXECUTION_FIELD
// ---------------------------------------------------------------------------

describe('UNKNOWN_EXECUTION_FIELD', () => {
  it('rejects extra key providerConfig', () => {
    expectError(validateAssemblyRequest({ ...validRequest(), providerConfig: {} } as any), 'UNKNOWN_EXECUTION_FIELD');
  });
});

// ---------------------------------------------------------------------------
// UNSAFE_SIZE
// ---------------------------------------------------------------------------

describe('UNSAFE_SIZE', () => {
  it('rejects taskId > 256 chars', () => {
    expectError(validateAssemblyRequest({ ...validRequest(), taskId: 'x'.repeat(257) }), 'UNSAFE_SIZE');
  });
  it('rejects empty taskId', () => {
    expectError(validateAssemblyRequest({ ...validRequest(), taskId: '' }), 'UNSAFE_SIZE');
  });
});

// ---------------------------------------------------------------------------
// Recursive credential check (RED tests)
// ---------------------------------------------------------------------------

describe('CREDENTIAL_IN_PROHIBITED_POSITION — recursive', () => {
  it('RED: credential in rolePolicy.policyId is detected', () => {
    const req = { ...validRequest(), rolePolicy: { ...validRequest().rolePolicy, policyId: 'Bearer sk-deadbeef' } };
    expectError(validateAssemblyRequest(req), 'CREDENTIAL_IN_PROHIBITED_POSITION');
  });

  it('RED: credential in candidateSet.candidates[] entry is detected', () => {
    const req = {
      ...validRequest(),
      candidateSet: { ...validRequest().candidateSet, candidates: ['assistant', 'sk-proj-abc123def456'] },
    };
    expectError(validateAssemblyRequest(req), 'CREDENTIAL_IN_PROHIBITED_POSITION');
  });

  it('RED: credential in provenance.policyUri is detected', () => {
    const req = {
      ...validRequest(),
      provenance: { ...validRequest().provenance, policyUri: 'https://api-key:sk-abc@evil.com' },
    };
    expectError(validateAssemblyRequest(req), 'CREDENTIAL_IN_PROHIBITED_POSITION');
  });

  it('rejects bearer token in authority purpose', () => {
    const purpose = 'Bearer sk-abc123';
    expectError(validateAssemblyRequest({
      ...validRequest(),
      authorityCeiling: { ...validRequest().authorityCeiling, purpose },
      requestedAuthority: { ...validRequest().requestedAuthority, purpose },
    }), 'CREDENTIAL_IN_PROHIBITED_POSITION');
  });

  it('RED: an embedded sk- key inside a URL is still detected', () => {
    // Deliberately low-entropy so this stays a pattern fixture and not
    // something a secret scanner has to treat as a real credential.
    const embedded = `sk-${'a'.repeat(12)}`;
    const req = {
      ...validRequest(),
      provenance: { ...validRequest().provenance, policyUri: `https://host/p?token=${embedded}` },
    };
    expectError(validateAssemblyRequest(req), 'CREDENTIAL_IN_PROHIBITED_POSITION');
  });

  // The embedded-credential patterns are substring matches, so they must be
  // anchored at a token boundary. Without that, every identifier that merely
  // CONTAINS "sk-" is rejected — "task-nodeadline" being the case that shipped.
  it.each([
    'task-nodeadline',
    'task-nodeadlines',
    'disk-optimization1',
    'risk-assessment-2026',
    'subtask-normalization',
  ])('does NOT treat the ordinary identifier %s as a credential', (taskId) => {
    expectOk(validateAssemblyRequest({ ...validRequest(), taskId }));
  });

  it('does NOT treat an identifier merely containing api_key as a credential', () => {
    const purpose = 'legacyapi_key=migration';
    expectOk(validateAssemblyRequest({
      ...validRequest(),
      authorityCeiling: { ...validRequest().authorityCeiling, purpose },
      requestedAuthority: { ...validRequest().requestedAuthority, purpose },
    }));
  });

  it('DOES treat a boundary-anchored api_key assignment as a credential', () => {
    expectError(
      validateAssemblyRequest({
        ...validRequest(),
        authorityCeiling: { ...validRequest().authorityCeiling, purpose: 'connect api_key=supersecretvalue' },
        requestedAuthority: { ...validRequest().requestedAuthority, purpose: 'connect api_key=supersecretvalue' },
      }),
      'CREDENTIAL_IN_PROHIBITED_POSITION',
    );
  });
});

// ---------------------------------------------------------------------------
// Strict traceFields type validation
// ---------------------------------------------------------------------------

describe('traceFields strict type', () => {
  it('RED: rejects undefined value in traceFields', () => {
    const req = { ...validRequest(), traceFields: { bad: undefined } };
    // undefined has no canonical JSON representation, so it is a typed
    // rejection — NOT sanitized away into `{}`, which would collide with a
    // genuinely empty traceFields object.
    expectError(validateAssemblyRequest(req), 'AMBIGUOUS_CANONICAL_VALUE');
  });

  // traceFields is the only free-form surface on the request, so the closed
  // canonical value contract is enforced through it at every depth.
  it.each([
    ['a Date', { when: new Date() }],
    ['a nested Date', { outer: { when: new Date() } }],
    ['negative zero', { z: -0 }],
    ['a class instance', { obj: new (class Foo { public x = 1; })() }],
    ['a bigint', { big: BigInt(7) }],
    ['NaN', { n: NaN }],
    ['Infinity', { n: Infinity }],
  ])('rejects %s in traceFields before serialization', (_label, traceFields) => {
    expectError(
      validateAssemblyRequest({ ...validRequest(), traceFields }),
      'AMBIGUOUS_CANONICAL_VALUE',
    );
  });

  it('rejects a sparse array in traceFields', () => {
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [1, , 3];
    expectError(
      validateAssemblyRequest({ ...validRequest(), traceFields: { arr: sparse } }),
      'AMBIGUOUS_CANONICAL_VALUE',
    );
  });

  it('rejects a cyclic reference in traceFields', () => {
    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    expectError(
      validateAssemblyRequest({ ...validRequest(), traceFields: { cyclic } }),
      'AMBIGUOUS_CANONICAL_VALUE',
    );
  });

  it('rejects a symbol-keyed object in traceFields', () => {
    const withSymbol = { [Symbol('s')]: 'v', normal: 'ok' };
    expectError(
      validateAssemblyRequest({ ...validRequest(), traceFields: { withSymbol } }),
      'AMBIGUOUS_CANONICAL_VALUE',
    );
  });

  it('rejects traceFields that is not a plain object', () => {
    expectError(
      validateAssemblyRequest({ ...validRequest(), traceFields: ['a', 'b'] }),
      'AMBIGUOUS_CANONICAL_VALUE',
    );
  });

  it('NEGATIVE CONTROL: accepts deeply nested canonical traceFields', () => {
    expectOk(validateAssemblyRequest({
      ...validRequest(),
      traceFields: { a: 1, b: 'two', c: false, d: null, e: [1, { f: 'g' }] },
    }));
  });

  it('rejects traceFields key shadowing schemaVersion', () => {
    const req = { ...validRequest(), traceFields: { schemaVersion: 'v99' } } as any;
    expectError(validateAssemblyRequest(req), 'UNKNOWN_EXECUTION_FIELD');
  });
});

// ---------------------------------------------------------------------------
// DEADLINE_EXCEEDED
// ---------------------------------------------------------------------------

describe('DEADLINE_EXCEEDED', () => {
  it('rejects past deadline', () => {
    expectError(validateAssemblyRequest({ ...validRequest(), deadline: '2020-01-01T00:00:00.000Z' }), 'DEADLINE_EXCEEDED');
  });
});

// ---------------------------------------------------------------------------
// ATTEMPT_BUDGET_EXCEEDED / AMBIGUOUS_CANONICAL_VALUE
// ---------------------------------------------------------------------------

describe('ATTEMPT_BUDGET_EXCEEDED', () => {
  it('rejects budget > 1000', () => {
    expectError(validateAssemblyRequest({ ...validRequest(), attemptBudget: 1001 }), 'ATTEMPT_BUDGET_EXCEEDED');
  });
  it('rejects Infinity budget', () => {
    expectError(validateAssemblyRequest({ ...validRequest(), attemptBudget: Infinity }), 'AMBIGUOUS_CANONICAL_VALUE');
  });
});

// ---------------------------------------------------------------------------
// INVALID_PROVENANCE / EXPIRED_POLICY / INVALID_DIGEST / UNSAFE_NESTING
// ---------------------------------------------------------------------------

describe('INVALID_PROVENANCE', () => {
  it('rejects short policyDigest', () => {
    const req = { ...validRequest(), provenance: { ...validRequest().provenance, policyDigest: 'short' } };
    expectError(validateAssemblyRequest(req), 'INVALID_PROVENANCE');
  });
});

describe('EXPIRED_POLICY', () => {
  it('rejects past expiresAt', () => {
    const req = { ...validRequest(), provenance: { ...validRequest().provenance, expiresAt: '2020-01-01T00:00:00.000Z' } };
    expectError(validateAssemblyRequest(req), 'EXPIRED_POLICY');
  });
});

describe('INVALID_DIGEST', () => {
  it('rejects non-sha256 sourceDigest', () => {
    const req = { ...validRequest(), candidateSet: { ...validRequest().candidateSet, sourceDigest: 'not-a-sha256' } };
    expectError(validateAssemblyRequest(req), 'INVALID_DIGEST');
  });
});

describe('UNSAFE_NESTING', () => {
  it('rejects deeply nested traceFields', () => {
    const deep: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = deep;
    for (let i = 0; i < 12; i++) { cursor['nested'] = {}; cursor = cursor['nested'] as Record<string, unknown>; }
    expectError(validateAssemblyRequest({ ...validRequest(), traceFields: deep }), 'UNSAFE_NESTING');
  });
});
