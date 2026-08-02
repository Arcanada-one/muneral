// MUN-0022: explicit, decision-bearing temporal reference for pure compilation.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { compileAssembly } from '../../src/assembly/assembly.compiler';
import { validateAssemblyRequest } from '../../src/assembly/assembly.validator';
import type { AssemblyRequestV0 } from '../../src/assembly/assembly.types';

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'positive', 'full-request.json'), 'utf8'),
) as { input: AssemblyRequestV0; expectedDigest: string };

function request(overrides: Partial<AssemblyRequestV0> = {}): AssemblyRequestV0 {
  return {
    ...JSON.parse(JSON.stringify(fixture.input)),
    ...overrides,
  } as AssemblyRequestV0;
}

function errorAt(evaluatedAt: string, overrides: Partial<AssemblyRequestV0> = {}): string | undefined {
  const result = validateAssemblyRequest(request({ ...overrides, evaluatedAt }));
  return 'errorCode' in result ? result.errorCode : undefined;
}

describe('authority-supplied evaluatedAt', () => {
  it('keeps compileAssembly unary', () => {
    expect(compileAssembly.length).toBe(1);
  });

  it.each([
    [undefined, 'undefined'],
    [null, 'object'],
    [42, 'number'],
    ['not-an-instant', 'string'],
    ['2026-07-30T00:00:00+00:00', 'string'],
    ['2026-07-30T00:00:00.0000Z', 'string'],
  ])('rejects a missing or noncanonical evaluatedAt value %#', (evaluatedAt, _kind) => {
    const candidate = request() as unknown as Record<string, unknown>;
    if (evaluatedAt === undefined) delete candidate.evaluatedAt;
    else candidate.evaluatedAt = evaluatedAt;
    const result = validateAssemblyRequest(candidate);
    expect('errorCode' in result && result.errorCode).toBe('AMBIGUOUS_CANONICAL_VALUE');
    expect('errorCode' in result && result.details.fieldName).toBe('evaluatedAt');
    expect('errorCode' in result && result.failedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('uses validated evaluatedAt as the deterministic timestamp of later refusals', () => {
    const evaluatedAt = '2026-08-01T12:00:00.000Z';
    const result = validateAssemblyRequest(request({ evaluatedAt, attemptBudget: 1001 }));
    expect('errorCode' in result && result.errorCode).toBe('ATTEMPT_BUDGET_EXCEEDED');
    expect('errorCode' in result && result.failedAt).toBe(evaluatedAt);
  });

  it('accepts deadline and expiry equality, then rejects one millisecond later', () => {
    const boundary = '2027-01-01T00:00:00.000Z';
    const atBoundary = request({
      evaluatedAt: boundary,
      deadline: boundary,
      provenance: { ...fixture.input.provenance, expiresAt: boundary },
    });
    expect('errorCode' in validateAssemblyRequest(atBoundary)).toBe(false);
    expect(errorAt('2027-01-01T00:00:00.001Z', {
      deadline: boundary,
      provenance: { ...fixture.input.provenance, expiresAt: boundary },
    })).toBe('DEADLINE_EXCEEDED');
  });

  it.each(['0001-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z'])(
    'accepts the specified year boundary %s as a canonical instant',
    (evaluatedAt) => {
      const result = validateAssemblyRequest(request({
        evaluatedAt,
        candidateSet: { ...fixture.input.candidateSet, capturedAt: evaluatedAt },
        provenance: { ...fixture.input.provenance, issuedAt: evaluatedAt, expiresAt: evaluatedAt },
        deadline: evaluatedAt,
      }));
      expect('errorCode' in result).toBe(false);
    },
  );

  it('rejects year 0000 rather than extending the specified instant range', () => {
    expect(errorAt('0000-01-01T00:00:00.000Z')).toBe('AMBIGUOUS_CANONICAL_VALUE');
  });

  it('rejects policy issuance later than evaluatedAt', () => {
    expect(errorAt('2026-01-01T00:00:00.000Z', {
      deadline: '2027-01-01T00:00:00.000Z',
      provenance: { ...fixture.input.provenance, issuedAt: '2026-01-02T00:00:00.000Z' },
    })).toBe('INVALID_PROVENANCE');
  });

  it('changing only evaluatedAt changes canonical bytes and identity', () => {
    const first = compileAssembly(request({ evaluatedAt: '2026-08-01T12:00:00.000Z' }));
    const second = compileAssembly(request({ evaluatedAt: '2026-08-01T13:00:00.000Z' }));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.artifact.canonicalBytes).not.toBe(second.artifact.canonicalBytes);
    expect(first.artifact.digest).not.toBe(second.artifact.digest);
    expect(first.artifact.evaluatedAt).toBe('2026-08-01T12:00:00.000Z');
    expect(second.artifact.evaluatedAt).toBe('2026-08-01T13:00:00.000Z');
  });

  it('is independent of the process wall clock', () => {
    const now = jest.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('wall clock access is forbidden');
    });
    jest.useFakeTimers().setSystemTime(new Date('2099-01-01T00:00:00Z'));
    try {
      const outputs = Array.from({ length: 3 }, () => compileAssembly(fixture.input));
      expect(outputs.every((result) => result.ok)).toBe(true);
      expect(new Set(outputs.map((result) => JSON.stringify(result))).size).toBe(1);
      if (outputs[0].ok) expect(outputs[0].artifact.digest).toBe(fixture.expectedDigest);
    } finally {
      jest.useRealTimers();
      now.mockRestore();
    }
  });

  it('contains no implicit wall-clock fallback in compiler or validator source', () => {
    for (const file of ['assembly.compiler.ts', 'assembly.validator.ts']) {
      const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'assembly', file), 'utf8');
      expect(source).not.toContain('Date.now()');
      expect(source).not.toMatch(/new Date\(\s*\)/);
    }
  });
});
