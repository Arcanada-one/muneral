import * as fs from 'node:fs';
import * as path from 'node:path';
import { compileAssembly } from '../../src/assembly/assembly.compiler';
import type { AssemblyRequestV0 } from '../../src/assembly/assembly.types';
import { FIXTURE_EVALUATED_AT } from './fixture-instant';

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'positive', 'minimal-request.json'), 'utf8'),
) as { input: AssemblyRequestV0; expectedDigest: string; expectedArtifactId: string };

function compile(input: AssemblyRequestV0 = fixture.input) {
  return compileAssembly(input);
}

describe('compileAssembly pure artifact compiler', () => {
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(new Date(FIXTURE_EVALUATED_AT));
  });
  afterAll(() => jest.useRealTimers());
  it('is deterministic across three compilations', () => {
    const outputs = Array.from({ length: 3 }, () => compile());
    expect(outputs.every((result) => result.ok)).toBe(true);
    expect(new Set(outputs.map((result) => JSON.stringify(result))).size).toBe(1);
  });

  it('matches the pinned artifact and invocation identities', () => {
    const result = compile();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.digest).toBe(fixture.expectedDigest);
    expect(result.artifact.artifactId).toBe(fixture.expectedArtifactId);
    expect(result.artifact.preparedInvocation.invocationId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.artifact.preparedInvocation.invocationId).not.toBe(result.artifact.digest);
  });

  it('moves identity for an authority change but not trace diagnostics', () => {
    const base = compile();
    const changed = compile({
      ...fixture.input,
      requestedAuthority: { ...fixture.input.requestedAuthority, scope: 'write' },
    });
    const traced = compile({ ...fixture.input, traceFields: { diagnostic: 'different' } });
    expect(base.ok && changed.ok && traced.ok).toBe(true);
    if (!base.ok || !changed.ok || !traced.ok) return;
    expect(changed.artifact.digest).not.toBe(base.artifact.digest);
    expect(traced.artifact.digest).toBe(base.artifact.digest);
  });

  it('preserves the ceiling and emits the requested narrowed authority', () => {
    const result = compile({
      ...fixture.input,
      authorityCeiling: { ...fixture.input.authorityCeiling, scope: 'read,write' },
      requestedAuthority: { ...fixture.input.requestedAuthority, scope: 'read' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.authority).toEqual({
      ...fixture.input.requestedAuthority,
      scope: 'read',
    });
    expect(result.artifact.authorityCeiling.scope).toBe('read,write');
  });

  it('builds inert prepared-invocation data with no provider/tool implementation fields', () => {
    const result = compile({
      ...fixture.input,
      attemptBudget: 3,
      deadline: '2027-01-01T00:00:00.000Z',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.preparedInvocation).toMatchObject({
      targetRole: fixture.input.rolePolicy.roleName,
      constraints: { budget: 3, deadline: '2027-01-01T00:00:00.000Z' },
      evidenceRefs: fixture.input.evidenceRefs,
    });
    for (const forbidden of ['provider', 'providerConfig', 'endpoint', 'apiKey', 'model', 'tools']) {
      expect(result.artifact.preparedInvocation).not.toHaveProperty(forbidden);
    }
  });

  it.each([
    ['unsupported schema', { schemaVersion: 'v1' }, 'UNSUPPORTED_SCHEMA_VERSION'],
    ['unknown field', { providerConfig: {} }, 'UNKNOWN_EXECUTION_FIELD'],
    ['invalid provenance', { provenance: { ...fixture.input.provenance, policyDigest: 'bad' } }, 'INVALID_PROVENANCE'],
    ['bad attempt budget', { attemptBudget: 0 }, 'ATTEMPT_BUDGET_EXCEEDED'],
  ])('returns a typed error for %s', (_label, override, code) => {
    const result = compile({ ...fixture.input, ...override } as AssemblyRequestV0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorCode).toBe(code);
  });

  it('does not mutate the request graph', () => {
    const input = JSON.parse(JSON.stringify(fixture.input)) as AssemblyRequestV0;
    const before = JSON.stringify(input);
    expect(compile(input).ok).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
  });
});
