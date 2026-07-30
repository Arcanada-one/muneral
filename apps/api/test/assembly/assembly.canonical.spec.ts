// MUN-0022: Canonical JSON tests — determinism, key sorting, trace-field
// exclusion, digest stability.

import {
  canonicalizeDecisionFields,
  computeAssemblyDigest,
} from '../../src/assembly/assembly.canonical';
import type { AssemblyRequestV0 } from '../../src/assembly/assembly.types';

function makeRequest(overrides?: Partial<AssemblyRequestV0>): AssemblyRequestV0 {
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
    ...overrides,
  };
}

describe('canonicalizeDecisionFields', () => {
  it('produces deterministic output for identical input', () => {
    const req = makeRequest();
    const a = canonicalizeDecisionFields(req);
    const b = canonicalizeDecisionFields(req);
    expect(a).toBe(b);
  });

  it('produces stable output — same bytes every time', () => {
    const req = makeRequest();
    const results = Array.from({ length: 10 }, () => canonicalizeDecisionFields(req));
    const first = results[0];
    for (const r of results) {
      expect(r).toBe(first);
    }
  });

  it('excludes traceFields from output', () => {
    const req = makeRequest({ traceFields: { customRequestId: 'abc-999', debugHint: 'test-mode' } });
    const output = canonicalizeDecisionFields(req);
    // Trace field keys (which are unique enough not to collide with authoritative keys)
    expect(output).not.toContain('customRequestId');
    expect(output).not.toContain('debugHint');
    // Trace field values
    expect(output).not.toContain('abc-999');
    expect(output).not.toContain('test-mode');
  });

  it('traceFields absence does not change decision bytes', () => {
    const noTrace = canonicalizeDecisionFields(makeRequest());
    const withTrace = canonicalizeDecisionFields(
      makeRequest({ traceFields: { x: 1 } }),
    );
    expect(noTrace).toBe(withTrace);
  });

  it('mutation of authoritative field changes output', () => {
    const a = canonicalizeDecisionFields(makeRequest({ scope: 'read' }));
    const b = canonicalizeDecisionFields(makeRequest({ scope: 'write' }));
    expect(a).not.toBe(b);
  });

  it('mutation of traceFields does not change output', () => {
    const a = canonicalizeDecisionFields(
      makeRequest({ traceFields: { v: 1 } }),
    );
    const b = canonicalizeDecisionFields(
      makeRequest({ traceFields: { v: 2 } }),
    );
    expect(a).toBe(b);
  });

  it('optional fields included when present', () => {
    const withDeadline = canonicalizeDecisionFields(
      makeRequest({ deadline: '2027-01-01T00:00:00Z' }),
    );
    const withoutDeadline = canonicalizeDecisionFields(makeRequest());
    expect(withDeadline).not.toBe(withoutDeadline);
    expect(withDeadline).toContain('deadline');
    expect(withoutDeadline).not.toContain('deadline');
  });

  it('output contains no whitespace', () => {
    const output = canonicalizeDecisionFields(makeRequest());
    expect(output).not.toContain(' ');
    expect(output).not.toContain('\n');
    expect(output).not.toContain('\t');
  });

  it('keys are sorted lexicographically', () => {
    const output = canonicalizeDecisionFields(makeRequest());
    // Parse to check key order
    const keys = Object.keys(JSON.parse(output));
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });
});

describe('computeAssemblyDigest', () => {
  it('returns exactly 64 lowercase hex characters', () => {
    const digest = computeAssemblyDigest(makeRequest());
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('same input → same digest', () => {
    const req = makeRequest();
    expect(computeAssemblyDigest(req)).toBe(computeAssemblyDigest(req));
  });

  it('authoritative mutation → different digest', () => {
    const a = computeAssemblyDigest(makeRequest({ scope: 'read' }));
    const b = computeAssemblyDigest(makeRequest({ scope: 'write' }));
    expect(a).not.toBe(b);
  });

  it('traceFields mutation → same digest', () => {
    const a = computeAssemblyDigest(makeRequest({ traceFields: { v: 1 } }));
    const b = computeAssemblyDigest(makeRequest({ traceFields: { v: 2 } }));
    expect(a).toBe(b);
  });

  it('different taskIds → different digests', () => {
    const a = computeAssemblyDigest(makeRequest({ taskId: 'task-1' }));
    const b = computeAssemblyDigest(makeRequest({ taskId: 'task-2' }));
    expect(a).not.toBe(b);
  });
});
