import {
  ASSEMBLY_ERROR_CODES,
  MAX_ATTEMPT_BUDGET,
  MAX_CANDIDATES,
  MAX_CANONICAL_BYTES,
  MAX_CANONICAL_ENTRIES,
  MAX_CONTAINER_ENTRIES,
  MAX_FIELD_BYTES,
  MAX_NESTING_DEPTH,
} from '../../src/assembly/assembly.types';
import type {
  AssemblyArtifactV0,
  AssemblyErrorCode,
  AssemblyRequestV0,
  CanonicalJsonObject,
  InvocationObservationV0,
  PreparedInvocationV0,
} from '../../src/assembly/assembly.types';

describe('frozen Assembly v0 types', () => {
  it('pins the bounded constants', () => {
    expect(MAX_FIELD_BYTES).toBe(256);
    expect(MAX_CANDIDATES).toBe(64);
    expect(MAX_ATTEMPT_BUDGET).toBe(1000);
    expect(MAX_NESTING_DEPTH).toBe(10);
    expect(MAX_CONTAINER_ENTRIES).toBe(1024);
    expect(MAX_CANONICAL_ENTRIES).toBe(4096);
    expect(MAX_CANONICAL_BYTES).toBe(1024 * 1024);
  });

  it('contains exactly the 12 PRD error codes', () => {
    const expected: AssemblyErrorCode[] = [
      'UNSUPPORTED_SCHEMA_VERSION', 'UNKNOWN_EXECUTION_FIELD',
      'AMBIGUOUS_CANONICAL_VALUE', 'UNSAFE_SIZE', 'UNSAFE_NESTING',
      'AUTHORITY_WIDENING', 'INVALID_PROVENANCE', 'EXPIRED_POLICY',
      'CREDENTIAL_IN_PROHIBITED_POSITION', 'INVALID_DIGEST',
      'DEADLINE_EXCEEDED', 'ATTEMPT_BUDGET_EXCEEDED',
    ];
    expect([...ASSEMBLY_ERROR_CODES].sort()).toEqual(expected.sort());
  });

  it('represents provider-neutral invocation and observation data only', () => {
    const invocation: PreparedInvocationV0 = {
      invocationId: 'a'.repeat(64),
      targetRole: 'assistant',
      canonicalPrompt: '{}',
      constraints: { budget: 3 },
      evidenceRefs: [],
    };
    const observation: InvocationObservationV0 = {
      observationId: 'obs-1', invocationId: invocation.invocationId,
      observedAt: '2026-07-30T00:00:00.000Z', outcome: 'completed', evidenceRefs: [],
    };
    expect(invocation).not.toHaveProperty('endpoint');
    expect(observation.outcome).toBe('completed');
  });

  it('keeps request and artifact schema versions literal v0', () => {
    const request = null as unknown as AssemblyRequestV0;
    const artifact = null as unknown as AssemblyArtifactV0;
    type RequestVersion = typeof request.schemaVersion;
    type ArtifactVersion = typeof artifact.schemaVersion;
    const requestVersion: RequestVersion = 'v0';
    const artifactVersion: ArtifactVersion = 'v0';
    expect(requestVersion).toBe('v0');
    expect(artifactVersion).toBe('v0');
  });

  it('excludes non-canonical values from traceFields at the type level', () => {
    const valid: CanonicalJsonObject = { nested: { values: [1, true, null, 'x'] } };
    expect(valid).toBeDefined();
    const compileOnly = () => {
      // @ts-expect-error undefined is not canonical JSON.
      const invalid: CanonicalJsonObject = { bad: undefined };
      return invalid;
    };
    expect(typeof compileOnly).toBe('function');
  });
});
