// MUN-0022: Validator tests — one test per AssemblyErrorCode plus positive
// valid case. Fail-closed: every invalid input produces a typed error.

import { validateAssemblyRequest } from '../../src/assembly/assembly.validator';
import type {
  AssemblyRequestV0,
  AssemblyErrorV0,
} from '../../src/assembly/assembly.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validRequest(): AssemblyRequestV0 {
  return {
    schemaVersion: 'v0',
    taskId: 'task-1',
    causationId: 'caus-1',
    correlationId: 'corr-1',
    tenant: 'acme',
    principal: 'user-1',
    purpose: 'test',
    audience: 'internal',
    scope: 'read',
    rolePolicy: {
      policyId: 'policy-sha256',
      policyVersion: '2026-07-30T00:00:00Z',
      roleName: 'assistant',
    },
    candidateSet: {
      candidates: ['assistant', 'reviewer'],
      sourceDigest: 'b'.repeat(64),
      capturedAt: '2026-07-30T00:00:00Z',
    },
    provenance: {
      policyUri: 'content://policy-sha256',
      policyDigest: 'c'.repeat(64),
      issuedAt: '2026-07-30T00:00:00Z',
    },
  };
}

function expectError(
  result: AssemblyRequestV0 | AssemblyErrorV0,
  expectedCode: string,
): void {
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
// Positive case
// ---------------------------------------------------------------------------

describe('validateAssemblyRequest — positive', () => {
  it('accepts a valid minimal request', () => {
    const result = validateAssemblyRequest(validRequest());
    expectOk(result);
  });

  it('accepts a request with optional deadline and attemptBudget', () => {
    const req = {
      ...validRequest(),
      deadline: '2027-01-01T00:00:00Z',
      attemptBudget: 5,
    };
    const result = validateAssemblyRequest(req);
    expectOk(result);
  });

  it('accepts a request with traceFields', () => {
    const req = {
      ...validRequest(),
      traceFields: { requestId: 'abc-123', source: 'cli' },
    };
    const result = validateAssemblyRequest(req);
    expectOk(result);
  });

  it('returns request with schemaVersion preserved', () => {
    const result = validateAssemblyRequest(validRequest());
    expectOk(result);
    const req = result as AssemblyRequestV0;
    expect(req.schemaVersion).toBe('v0');
  });
});

// ---------------------------------------------------------------------------
// UNSUPPORTED_SCHEMA_VERSION
// ---------------------------------------------------------------------------

describe('UNSUPPORTED_SCHEMA_VERSION', () => {
  it('rejects null input', () => {
    const result = validateAssemblyRequest(null);
    expectError(result, 'UNSUPPORTED_SCHEMA_VERSION');
  });

  it('rejects non-object input', () => {
    const result = validateAssemblyRequest('not-an-object');
    expectError(result, 'UNSUPPORTED_SCHEMA_VERSION');
  });

  it('rejects schemaVersion "v1"', () => {
    const req = { ...validRequest(), schemaVersion: 'v1' as any };
    const result = validateAssemblyRequest(req);
    expectError(result, 'UNSUPPORTED_SCHEMA_VERSION');
  });

  it('rejects missing schemaVersion', () => {
    const { schemaVersion, ...rest } = validRequest();
    const result = validateAssemblyRequest(rest);
    expectError(result, 'UNSUPPORTED_SCHEMA_VERSION');
  });
});

// ---------------------------------------------------------------------------
// UNKNOWN_EXECUTION_FIELD
// ---------------------------------------------------------------------------

describe('UNKNOWN_EXECUTION_FIELD', () => {
  it('rejects extra top-level key that could affect execution', () => {
    const req = { ...validRequest(), providerConfig: { endpoint: 'https://...' } };
    const result = validateAssemblyRequest(req);
    expectError(result, 'UNKNOWN_EXECUTION_FIELD');
  });

  it('rejects extra key like modelParameters', () => {
    const req = { ...validRequest(), modelParameters: { temperature: 0.7 } };
    const result = validateAssemblyRequest(req);
    expectError(result, 'UNKNOWN_EXECUTION_FIELD');
  });
});

// ---------------------------------------------------------------------------
// UNSAFE_SIZE
// ---------------------------------------------------------------------------

describe('UNSAFE_SIZE', () => {
  it('rejects taskId exceeding 256 chars', () => {
    const req = { ...validRequest(), taskId: 'x'.repeat(257) };
    const result = validateAssemblyRequest(req);
    expectError(result, 'UNSAFE_SIZE');
  });

  it('rejects tenant exceeding 128 chars', () => {
    const req = { ...validRequest(), tenant: 'x'.repeat(129) };
    const result = validateAssemblyRequest(req);
    expectError(result, 'UNSAFE_SIZE');
  });

  it('rejects empty taskId', () => {
    const req = { ...validRequest(), taskId: '' };
    const result = validateAssemblyRequest(req);
    expectError(result, 'UNSAFE_SIZE');
  });
});

// ---------------------------------------------------------------------------
// UNSAFE_NESTING
// ---------------------------------------------------------------------------

describe('UNSAFE_NESTING', () => {
  it('rejects deeply nested traceFields', () => {
    const deep: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = deep;
    for (let i = 0; i < 12; i++) {
      cursor['nested'] = {};
      cursor = cursor['nested'] as Record<string, unknown>;
    }
    const req = { ...validRequest(), traceFields: deep };
    const result = validateAssemblyRequest(req);
    expectError(result, 'UNSAFE_NESTING');
  });
});

// ---------------------------------------------------------------------------
// DEADLINE_EXCEEDED
// ---------------------------------------------------------------------------

describe('DEADLINE_EXCEEDED', () => {
  it('rejects deadline in the past', () => {
    const req = { ...validRequest(), deadline: '2020-01-01T00:00:00Z' };
    const result = validateAssemblyRequest(req);
    expectError(result, 'DEADLINE_EXCEEDED');
  });

  it('rejects invalid ISO 8601 deadline', () => {
    const req = { ...validRequest(), deadline: 'not-a-date' };
    const result = validateAssemblyRequest(req);
    expectError(result, 'DEADLINE_EXCEEDED');
  });
});

// ---------------------------------------------------------------------------
// ATTEMPT_BUDGET_EXCEEDED
// ---------------------------------------------------------------------------

describe('ATTEMPT_BUDGET_EXCEEDED', () => {
  it('rejects attemptBudget > 1000', () => {
    const req = { ...validRequest(), attemptBudget: 1001 };
    const result = validateAssemblyRequest(req);
    expectError(result, 'ATTEMPT_BUDGET_EXCEEDED');
  });

  it('rejects attemptBudget < 1', () => {
    const req = { ...validRequest(), attemptBudget: 0 };
    const result = validateAssemblyRequest(req);
    expectError(result, 'ATTEMPT_BUDGET_EXCEEDED');
  });

  it('rejects non-integer attemptBudget', () => {
    const req = { ...validRequest(), attemptBudget: 3.5 };
    const result = validateAssemblyRequest(req);
    expectError(result, 'ATTEMPT_BUDGET_EXCEEDED');
  });
});

// ---------------------------------------------------------------------------
// INVALID_PROVENANCE
// ---------------------------------------------------------------------------

describe('INVALID_PROVENANCE', () => {
  it('rejects policyDigest that is not 64 lowercase hex chars', () => {
    const req = {
      ...validRequest(),
      provenance: { ...validRequest().provenance, policyDigest: 'short' },
    };
    const result = validateAssemblyRequest(req);
    expectError(result, 'INVALID_PROVENANCE');
  });

  it('rejects policyDigest with uppercase hex', () => {
    const req = {
      ...validRequest(),
      provenance: { ...validRequest().provenance, policyDigest: 'A'.repeat(64) },
    };
    const result = validateAssemblyRequest(req);
    expectError(result, 'INVALID_PROVENANCE');
  });
});

// ---------------------------------------------------------------------------
// EXPIRED_POLICY
// ---------------------------------------------------------------------------

describe('EXPIRED_POLICY', () => {
  it('rejects provenance with expiresAt in the past', () => {
    const req = {
      ...validRequest(),
      provenance: {
        ...validRequest().provenance,
        expiresAt: '2020-01-01T00:00:00Z',
      },
    };
    const result = validateAssemblyRequest(req);
    expectError(result, 'EXPIRED_POLICY');
  });
});

// ---------------------------------------------------------------------------
// CREDENTIAL_IN_PROHIBITED_POSITION
// ---------------------------------------------------------------------------

describe('CREDENTIAL_IN_PROHIBITED_POSITION', () => {
  it('rejects bearer token pattern in purpose', () => {
    const req = { ...validRequest(), purpose: 'Bearer sk-abc123' };
    const result = validateAssemblyRequest(req);
    expectError(result, 'CREDENTIAL_IN_PROHIBITED_POSITION');
  });

  it('rejects base64 key-like pattern in scope', () => {
    const req = {
      ...validRequest(),
      scope: 'akid-' + 'A'.repeat(40),
    };
    const result = validateAssemblyRequest(req);
    expectError(result, 'CREDENTIAL_IN_PROHIBITED_POSITION');
  });
});

// ---------------------------------------------------------------------------
// INVALID_DIGEST
// ---------------------------------------------------------------------------

describe('INVALID_DIGEST', () => {
  it('rejects candidateSet with invalid sourceDigest', () => {
    const req = {
      ...validRequest(),
      candidateSet: {
        ...validRequest().candidateSet,
        sourceDigest: 'not-a-sha256',
      },
    };
    const result = validateAssemblyRequest(req);
    expectError(result, 'INVALID_DIGEST');
  });
});

// ---------------------------------------------------------------------------
// AMBIGUOUS_CANONICAL_VALUE
// ---------------------------------------------------------------------------

describe('AMBIGUOUS_CANONICAL_VALUE', () => {
  it('rejects input with non-finite number in a numeric field', () => {
    const req = { ...validRequest(), attemptBudget: Infinity };
    const result = validateAssemblyRequest(req);
    expectError(result, 'AMBIGUOUS_CANONICAL_VALUE');
  });
});

// ---------------------------------------------------------------------------
// AUTHORITY_WIDENING — deferred to compiler (validator only checks bounds)
// ---------------------------------------------------------------------------

describe('AUTHORITY_WIDENING — structural checks', () => {
  it('rejects empty tenant', () => {
    const req = { ...validRequest(), tenant: '' };
    const result = validateAssemblyRequest(req);
    expectError(result, 'UNSAFE_SIZE');
  });
});
