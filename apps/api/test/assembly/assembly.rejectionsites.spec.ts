// Focused observability for each current fail-closed rule family.

import * as fs from 'node:fs';
import {
  assemblyCanonicalJson,
  assemblyParseCanonicalJson,
  validateCanonicalValue,
} from '../../src/assembly/assembly.canonical';
import { validateAssemblyRequest } from '../../src/assembly/assembly.validator';
import {
  MAX_CANONICAL_BYTES,
  MAX_CANONICAL_ENTRIES,
  MAX_CONTAINER_ENTRIES,
  type AssemblyErrorV0,
} from '../../src/assembly/assembly.types';

const base = JSON.parse(
  fs.readFileSync(`${__dirname}/fixtures/positive/minimal-request.json`, 'utf8'),
).input as Record<string, unknown>;

function refusal(edit: (request: Record<string, any>) => void): AssemblyErrorV0 {
  const request = JSON.parse(JSON.stringify(base)) as Record<string, any>;
  edit(request);
  const result = validateAssemblyRequest(request);
  if (!('errorCode' in result)) throw new Error('expected refusal');
  return result;
}

describe('validator rejection sites identify their rule and path', () => {
  it.each([
    ['schema', (r: any) => { r.schemaVersion = 'v1'; }, 'UNSUPPORTED_SCHEMA_VERSION', 'schemaVersion'],
    ['unknown', (r: any) => { r.providerConfig = {}; }, 'UNKNOWN_EXECUTION_FIELD', 'providerConfig'],
    ['identity size', (r: any) => { r.taskId = ''; }, 'UNSAFE_SIZE', 'taskId'],
    ['instant', (r: any) => { r.evaluatedAt = '2026-02-30T00:00:00.000Z'; }, 'AMBIGUOUS_CANONICAL_VALUE', 'evaluatedAt'],
    ['ceiling shape', (r: any) => { r.authorityCeiling.scope = 'write,read'; }, 'AUTHORITY_WIDENING', 'authorityCeiling.scope'],
    ['identity mismatch', (r: any) => { r.requestedAuthority.tenant = 'other'; }, 'AUTHORITY_WIDENING', 'requestedAuthority.tenant'],
    ['scope widening', (r: any) => { r.requestedAuthority.scope = 'admin,read'; }, 'AUTHORITY_WIDENING', 'requestedAuthority.scope'],
    ['role shape', (r: any) => { r.rolePolicy = null; }, 'UNSAFE_SIZE', 'rolePolicy'],
    ['role unknown', (r: any) => { r.rolePolicy.weight = 1; }, 'UNKNOWN_EXECUTION_FIELD', 'rolePolicy.weight'],
    ['candidate count', (r: any) => { r.candidateSet.candidates = []; }, 'UNSAFE_SIZE', 'candidateSet.candidates'],
    ['candidate digest', (r: any) => { r.candidateSet.sourceDigest = 'bad'; }, 'INVALID_DIGEST', 'candidateSet.sourceDigest'],
    ['candidate instant', (r: any) => { r.candidateSet.capturedAt = 'yesterday'; }, 'AMBIGUOUS_CANONICAL_VALUE', 'candidateSet.capturedAt'],
    ['evidence type', (r: any) => { r.evidenceRefs = null; }, 'INVALID_PROVENANCE', 'evidenceRefs'],
    ['evidence count', (r: any) => { r.evidenceRefs = Array.from({ length: 65 }, (_, index) => ({ uri: `evidence/${String(index).padStart(2, '0')}.txt`, digest: String(index % 10).repeat(64), contentType: 'text/plain' })); }, 'INVALID_PROVENANCE', 'evidenceRefs'],
    ['evidence invalid', (r: any) => { r.evidenceRefs = [{ uri: '../x', digest: 'a'.repeat(64), contentType: 'text/plain' }]; }, 'INVALID_PROVENANCE', 'evidenceRefs[0]'],
    ['provenance shape', (r: any) => { r.provenance = null; }, 'INVALID_PROVENANCE', 'provenance'],
    ['provenance unknown', (r: any) => { r.provenance.override = true; }, 'UNKNOWN_EXECUTION_FIELD', 'provenance.override'],
    ['policy digest', (r: any) => { r.provenance.policyDigest = 'bad'; }, 'INVALID_PROVENANCE', 'provenance.policyDigest'],
    ['policy URI', (r: any) => { r.provenance.policyUri = ''; }, 'INVALID_PROVENANCE', 'provenance.policyUri'],
    ['policy future', (r: any) => { r.provenance.issuedAt = '2026-08-01T12:00:00.001Z'; }, 'INVALID_PROVENANCE', 'provenance.issuedAt'],
    ['policy expiry', (r: any) => { r.provenance.expiresAt = '2026-08-01T11:59:59.999Z'; }, 'EXPIRED_POLICY', 'provenance.expiresAt'],
    ['deadline', (r: any) => { r.deadline = '2026-08-01T11:59:59.999Z'; }, 'DEADLINE_EXCEEDED', 'deadline'],
    ['budget', (r: any) => { r.attemptBudget = 0; }, 'ATTEMPT_BUDGET_EXCEEDED', 'attemptBudget'],
    ['trace shape', (r: any) => { r.traceFields = []; }, 'AMBIGUOUS_CANONICAL_VALUE', 'traceFields'],
    ['trace shadow', (r: any) => { r.traceFields = { deadline: 'x' }; }, 'UNKNOWN_EXECUTION_FIELD', 'traceFields.deadline'],
    ['credential', (r: any) => { r.traceFields = { note: 'Bearer synthetic-example' }; }, 'CREDENTIAL_IN_PROHIBITED_POSITION', 'traceFields.note'],
  ])('%s', (_label, edit, code, field) => {
    const error = refusal(edit as never);
    expect(error.errorCode).toBe(code);
    expect(error.details.fieldName).toBe(field);
  });

  it('accepts the untouched control', () => {
    expect('errorCode' in validateAssemblyRequest(base)).toBe(false);
  });

  it('distinguishes duplicate evidence identity from byte ordering', () => {
    const error = refusal((request) => {
      request.evidenceRefs = [
        { uri: 'evidence/same.txt', digest: '1'.repeat(64), contentType: 'text/plain', label: 'A' },
        { uri: 'evidence/same.txt', digest: '1'.repeat(64), contentType: 'text/plain', label: 'B' },
      ];
    });
    expect(error.errorCode).toBe('INVALID_PROVENANCE');
    expect(error.details.reason).toContain('duplicate');
  });

  it.each([
    ['authority unknown', (r: any) => { r.authorityCeiling.extra = 'x'; }, 'AUTHORITY_WIDENING', 'authorityCeiling.extra'],
    ['authority missing field', (r: any) => { delete r.authorityCeiling.tenant; }, 'AUTHORITY_WIDENING', 'authorityCeiling.tenant'],
    ['role empty field', (r: any) => { r.rolePolicy.policyId = ''; }, 'UNSAFE_SIZE', 'rolePolicy.policyId'],
    ['candidate invalid entry', (r: any) => { r.candidateSet.candidates = [42]; }, 'UNSAFE_SIZE', 'candidateSet.candidates'],
  ])('%s has an independently observed refusal', (_label, edit, code, field) => {
    const error = refusal(edit as never);
    expect(error.errorCode).toBe(code);
    expect(error.details.fieldName).toBe(field);
  });
});

describe('shared canonical v1 rejection sites', () => {
  const code = (value: unknown) => validateCanonicalValue(value, 'payload', 't', 'c', 'co')?.errorCode;

  it.each([
    ['undefined', undefined, 'AMBIGUOUS_CANONICAL_VALUE'],
    ['bigint', 1n, 'AMBIGUOUS_CANONICAL_VALUE'],
    ['function', { value: () => undefined }, 'AMBIGUOUS_CANONICAL_VALUE'],
    ['symbol', { value: Symbol('x') }, 'AMBIGUOUS_CANONICAL_VALUE'],
    ['lone surrogate', '\ud800', 'AMBIGUOUS_CANONICAL_VALUE'],
    ['infinity', Number.POSITIVE_INFINITY, 'AMBIGUOUS_CANONICAL_VALUE'],
    ['unsafe integer', 9_007_199_254_740_992, 'AMBIGUOUS_CANONICAL_VALUE'],
    ['date', new Date(), 'AMBIGUOUS_CANONICAL_VALUE'],
    ['overlong string', 'x'.repeat(MAX_CANONICAL_BYTES + 1), 'UNSAFE_SIZE'],
    ['oversized array', Array.from({ length: MAX_CONTAINER_ENTRIES + 1 }, () => 0), 'UNSAFE_SIZE'],
  ])('%s', (_label, value, expected) => expect(code(value)).toBe(expected));

  it('rejects cycles, sparse arrays, accessors, extra array properties, and symbols', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const sparse = new Array(2); sparse[1] = 1;
    const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => 'never' });
    const extra: unknown[] = [1]; (extra as unknown as Record<string, unknown>).extra = 2;
    for (const value of [cycle, sparse, accessor, extra, { [Symbol('x')]: 1 }]) {
      expect(code(value)).toBe('AMBIGUOUS_CANONICAL_VALUE');
    }
  });

  it('rejects every exotic array/object descriptor branch', () => {
    const exoticArray: unknown[] = [1];
    Object.setPrototypeOf(exoticArray, null);
    const symbolArray: unknown[] = [1];
    Object.defineProperty(symbolArray, Symbol('x'), { value: 1 });
    const hiddenArray: unknown[] = [1];
    Object.defineProperty(hiddenArray, '0', { value: 1, enumerable: false });
    const hiddenObject = Object.defineProperty({}, 'value', { value: 1, enumerable: false });
    const oversizedObject = Object.fromEntries(
      Array.from({ length: MAX_CONTAINER_ENTRIES + 1 }, (_, index) => [`k${index}`, 0]),
    );
    for (const value of [
      exoticArray, symbolArray, hiddenArray, hiddenObject, oversizedObject, { ['\ud800']: 1 },
    ]) {
      expect(code(value)).toMatch(/AMBIGUOUS_CANONICAL_VALUE|UNSAFE_SIZE/);
    }
  });

  it('rejects proxies without invoking traps', () => {
    let calls = 0;
    const proxy = new Proxy({}, { ownKeys: () => { calls++; return []; } });
    expect(code(proxy)).toBe('AMBIGUOUS_CANONICAL_VALUE');
    expect(calls).toBe(0);
  });

  it('accepts a shared acyclic graph', () => {
    const shared = { value: 1 };
    expect(validateCanonicalValue({ a: shared, b: shared }, 'payload', 't', 'c', 'co')).toBeNull();
  });

  it.each([
    '{"n":-0}', '{"n":5.0}', '{"n":1e2}', '{"n":9007199254740992}',
    '{"a":1,"a":2}', '[1,,2]',
  ])('rejects invalid raw JSON %s', (raw) => {
    expect(() => assemblyParseCanonicalJson(raw)).toThrow();
  });

  it('rejects raw byte, container, and aggregate entry overflow', () => {
    expect(() => assemblyParseCanonicalJson(`"${'x'.repeat(MAX_CANONICAL_BYTES)}"`)).toThrow();
    expect(() => assemblyParseCanonicalJson(`[${Array(MAX_CONTAINER_ENTRIES + 1).fill('0').join(',')}]`))
      .toThrow(/raw container is too large/);
    const groups = Array(5).fill(`[${Array(900).fill('0').join(',')}]`);
    expect(groups.length * 900).toBeGreaterThan(MAX_CANONICAL_ENTRIES);
    expect(() => assemblyParseCanonicalJson(`[${groups.join(',')}]`)).toThrow(/raw JSON has too many entries/);
  });

  it.each(['truex', '{x:1}', '', 'true false'])('rejects a distinct malformed raw branch: %s', (raw) => {
    expect(() => assemblyParseCanonicalJson(raw)).toThrow();
  });

  it('attributes otherwise structurally scanned invalid JSON to the JSON parser', () => {
    expect(() => assemblyParseCanonicalJson('truex')).toThrow(/input is not valid JSON/);
  });

  it('attributes malformed raw structure to its pre-parse branch', () => {
    expect(() => assemblyParseCanonicalJson('{x:1}')).toThrow(/object key must be a string/);
    expect(() => assemblyParseCanonicalJson('')).toThrow(/missing value/);
    expect(() => assemblyParseCanonicalJson('true false')).toThrow(/trailing JSON content/);
  });

  it('attributes missing object/array separators to their exact pre-parse branches', () => {
    expect(() => assemblyParseCanonicalJson('{"a" 1}')).toThrow(/missing colon/);
    expect(() => assemblyParseCanonicalJson('{"a":1 "b":2}')).toThrow(/missing comma/);
    expect(() => assemblyParseCanonicalJson('[1 2]')).toThrow(/missing comma/);
  });

  it('rejects negative zero before JSON.parse is reached', () => {
    const parse = jest.spyOn(JSON, 'parse');
    try {
      expect(() => assemblyParseCanonicalJson('-0')).toThrow(/negative zero/i);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it('canonical serializer itself fails closed', () => {
    expect(() => assemblyCanonicalJson({ n: -0 })).toThrow();
  });
});
