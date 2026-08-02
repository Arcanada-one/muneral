import { createHash } from 'node:crypto';
import {
  CANONICAL_JSON_V1_MAX_BYTES,
  canonicalJsonV1,
} from '../../src/execution-authority/canonical-json-v1';
import { createAssemblyError } from '../../src/assembly/assembly.errors';
import type { AssemblyRequestV0 } from '../../src/assembly/assembly.types';
import { compileAssembly } from '../../src/assembly';

function request(overrides: Record<string, unknown> = {}): AssemblyRequestV0 {
  return {
    schemaVersion: 'v0',
    taskId: 'task-rereview',
    causationId: 'cause-rereview',
    correlationId: 'corr-rereview',
    evaluatedAt: '2026-08-01T12:00:00.000Z',
    authorityCeiling: {
      tenant: 'acme',
      principal: 'operator',
      purpose: 'review',
      audience: 'internal',
      scope: 'read,write',
    },
    requestedAuthority: {
      tenant: 'acme',
      principal: 'operator',
      purpose: 'review',
      audience: 'internal',
      scope: 'read',
    },
    rolePolicy: { policyId: 'roles', policyVersion: 'v1', roleName: 'developer' },
    candidateSet: {
      candidates: ['developer'],
      sourceDigest: '1'.repeat(64),
      capturedAt: '2026-08-01T11:59:00.000Z',
    },
    evidenceRefs: [{
      uri: 'evidence/review.json',
      digest: '2'.repeat(64),
      contentType: 'application/json',
    }],
    provenance: {
      policyUri: 'policy/review.json',
      policyDigest: '3'.repeat(64),
      issuedAt: '2026-08-01T11:00:00.000Z',
    },
    ...overrides,
  } as unknown as AssemblyRequestV0;
}

describe('frozen-rereview regressions', () => {
  it('preserves own __proto__ keys in canonical bytes and refuses them at closed schemas', () => {
    const keyed = JSON.parse('{"__proto__":1}') as Record<string, unknown>;
    expect(canonicalJsonV1(keyed)).toBe('{"__proto__":1}');

    const input = JSON.parse(JSON.stringify(request())) as Record<string, unknown>;
    Object.defineProperty(input, '__proto__', { enumerable: true, value: 1 });
    const result = compileAssembly(input as unknown as AssemblyRequestV0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errorCode).toBe('UNKNOWN_EXECUTION_FIELD');
      expect(result.error.details.fieldName).toBe('__proto__');
    }
  });

  it('returns null-prototype detached trace state that cannot inherit mutable attacker data', () => {
    const traceFields = JSON.parse('{"__proto__":{"state":"before"}}') as Record<string, unknown>;
    const result = compileAssembly(request({ traceFields }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.getPrototypeOf(result.artifact.traceFields)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(result.artifact.traceFields, '__proto__')).toBe(true);
    (traceFields.__proto__ as Record<string, unknown>).state = 'after';
    expect((result.artifact.traceFields?.__proto__ as Record<string, unknown>).state).toBe('before');
    expect(Object.isFrozen(result.artifact.traceFields?.__proto__)).toBe(true);
  });

  it('bounds the emitted canonical bytes after non-ASCII escaping', () => {
    const admittedInput = '\u00e9'.repeat(200_000);
    expect(Buffer.byteLength(admittedInput, 'utf8')).toBeLessThan(CANONICAL_JSON_V1_MAX_BYTES);
    expect(() => canonicalJsonV1(admittedInput)).toThrow(/byte budget|resource budget/i);
  });

  it('enforces the emitted-byte budget on non-authoritative traceFields', () => {
    const admittedInput = '\u00e9'.repeat(200_000);
    const result = compileAssembly(request({ traceFields: { note: admittedInput } }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.errorCode).toBe('UNSAFE_SIZE');
      expect(result.error.details.fieldName).toBe('traceFields');
    }
  });

  it('returns a typed refusal when an admitted unknown key expands during error identity encoding', () => {
    const input = request() as unknown as Record<string, unknown>;
    input['"'.repeat(500_000)] = true;

    expect(() => compileAssembly(input as unknown as AssemblyRequestV0)).not.toThrow();
    const result = compileAssembly(input as unknown as AssemblyRequestV0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.errorCode).toBe('UNKNOWN_EXECUTION_FIELD');
  });

  it('rejects year zero at the public compiler boundary', () => {
    const result = compileAssembly(request({ evaluatedAt: '0000-01-01T00:00:00.000Z' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.errorCode).toBe('AMBIGUOUS_CANONICAL_VALUE');
  });

  it('preserves valid Unicode identities in typed refusals and uses the written error-id projection', () => {
    const details = { reason: 'attempt budget invalid', fieldName: 'attemptBudget' };
    const error = createAssemblyError('ATTEMPT_BUDGET_EXCEEDED', '\u0437\u0430\u0434\u0430\u0447\u0430', '\u043f\u0440\u0438\u0447\u0438\u043d\u0430', '\u0441\u0432\u044f\u0437\u044c', details);
    const preimage = canonicalJsonV1({
      kind: 'assembly-error-id-v0',
      errorCode: 'ATTEMPT_BUDGET_EXCEEDED',
      taskId: '\u0437\u0430\u0434\u0430\u0447\u0430',
      causationId: '\u043f\u0440\u0438\u0447\u0438\u043d\u0430',
      correlationId: '\u0441\u0432\u044f\u0437\u044c',
      canonicalDetails: canonicalJsonV1(details),
    });
    expect(error.taskId).toBe('\u0437\u0430\u0434\u0430\u0447\u0430');
    expect(error.causationId).toBe('\u043f\u0440\u0438\u0447\u0438\u043d\u0430');
    expect(error.correlationId).toBe('\u0441\u0432\u044f\u0437\u044c');
    expect(error.errorId).toBe(createHash('sha256').update(preimage, 'utf8').digest('hex'));
  });

  it('keeps error identities distinct when correlation fields contain the old delimiter', () => {
    const details = { reason: 'attempt budget invalid', fieldName: 'attemptBudget' };
    const first = createAssemblyError('ATTEMPT_BUDGET_EXCEEDED', 'a\0b', 'c', 'd', details);
    const second = createAssemblyError('ATTEMPT_BUDGET_EXCEEDED', 'a', 'b\0c', 'd', details);
    expect(first.errorId).not.toBe(second.errorId);
  });

  it('accepts a public-path authority narrowing and preserves ceiling plus effective authority', () => {
    const result = compileAssembly(request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.authorityCeiling.scope).toBe('read,write');
    expect(result.artifact.authority.scope).toBe('read');
  });

  it('makes AUTHORITY_WIDENING reachable through the public unary compiler', () => {
    const widened = request({
      requestedAuthority: {
        tenant: 'acme', principal: 'operator', purpose: 'review', audience: 'internal',
        scope: 'admin,read,write',
      },
    });
    const result = compileAssembly(widened);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorCode).toBe('AUTHORITY_WIDENING');
  });

  it.each(['read,read', 'write,read', 'read write', 'Read', 'read,']) (
    'rejects malformed or noncanonical scope %s as AUTHORITY_WIDENING',
    (scope) => {
      const result = compileAssembly(request({
        requestedAuthority: { ...request().requestedAuthority, scope },
      }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.errorCode).toBe('AUTHORITY_WIDENING');
    },
  );

  it('hashes the exact canonicalBytes with no hidden prefix', () => {
    const result = compileAssembly(request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected = createHash('sha256').update(result.artifact.canonicalBytes, 'utf8').digest('hex');
    expect(result.artifact.digest).toBe(expected);
    expect(result.artifact.artifactId).toBe(expected);
  });

  it('binds evidence and the complete prepared invocation into artifact identity', () => {
    const first = compileAssembly(request());
    const second = compileAssembly(request({ evidenceRefs: [{
      uri: 'evidence/other.json',
      digest: '4'.repeat(64),
      contentType: 'application/json',
    }] }));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.artifact.preparedInvocation.evidenceRefs).toEqual(request().evidenceRefs);
    expect(first.artifact.digest).not.toBe(second.artifact.digest);
    expect(JSON.parse(first.artifact.canonicalBytes).preparedInvocation)
      .toEqual(first.artifact.preparedInvocation);
  });

  it('derives prompt, invocation, and artifact identities from acyclic projections', () => {
    const result = compileAssembly(request());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const invocation = result.artifact.preparedInvocation;
    expect(JSON.parse(invocation.canonicalPrompt)).toMatchObject({
      kind: 'assembly-prompt-v0',
      authority: request().requestedAuthority,
      evidenceRefs: request().evidenceRefs,
    });
    const invocationBytes = canonicalJsonV1({
      kind: 'prepared-invocation-v0',
      targetRole: invocation.targetRole,
      canonicalPrompt: invocation.canonicalPrompt,
      constraints: invocation.constraints,
      evidenceRefs: invocation.evidenceRefs,
    });
    expect(invocation.invocationId).toBe(
      createHash('sha256').update(invocationBytes, 'utf8').digest('hex'),
    );
    const decision = JSON.parse(result.artifact.canonicalBytes);
    expect(decision.kind).toBe('assembly-artifact-v0');
    expect(decision).not.toHaveProperty('artifactId');
    expect(decision).not.toHaveProperty('digest');
    expect(decision).not.toHaveProperty('canonicalBytes');
  });

  it('rejects impossible calendar dates instead of normalizing them', () => {
    const result = compileAssembly(request({ evaluatedAt: '2026-02-30T12:00:00.000Z' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorCode).toBe('AMBIGUOUS_CANONICAL_VALUE');
  });

  it.each([
    ['candidate capture', { candidateSet: { ...request().candidateSet, capturedAt: '2026-02-30T12:00:00.000Z' } }, 'AMBIGUOUS_CANONICAL_VALUE'],
    ['policy issue', { provenance: { ...request().provenance, issuedAt: '2026-02-30T12:00:00.000Z' } }, 'INVALID_PROVENANCE'],
    ['policy expiry', { provenance: { ...request().provenance, expiresAt: '2026-02-30T12:00:00.000Z' } }, 'EXPIRED_POLICY'],
    ['deadline', { deadline: '2026-02-30T12:00:00.000Z' }, 'DEADLINE_EXCEEDED'],
  ])('rejects an impossible %s instant', (_label, override, code) => {
    const result = compileAssembly(request(override));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorCode).toBe(code);
  });

  it('rejects duplicate and unsorted evidence without silently sorting', () => {
    const a = { uri: 'evidence/a.json', digest: '1'.repeat(64), contentType: 'application/json' };
    const b = { uri: 'evidence/b.json', digest: '2'.repeat(64), contentType: 'application/json' };
    for (const evidenceRefs of [[a, a], [b, a]]) {
      const result = compileAssembly(request({ evidenceRefs }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.errorCode).toBe('INVALID_PROVENANCE');
    }
  });

  it('rejects nested stateful proxies without invoking their traps', () => {
    let trapCount = 0;
    const rolePolicy = new Proxy(
      { policyId: 'roles', policyVersion: 'v1', roleName: 'developer' },
      {
        getPrototypeOf(target) {
          trapCount += 1;
          return Reflect.getPrototypeOf(target);
        },
        ownKeys(target) {
          trapCount += 1;
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, key) {
          trapCount += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    const result = compileAssembly(request({ rolePolicy }));
    expect(result.ok).toBe(false);
    expect(trapCount).toBe(0);
  });

  it('rejects transparent, array, and revoked proxies before reflection', () => {
    const transparent = new Proxy({ policyId: 'roles', policyVersion: 'v1', roleName: 'developer' }, {});
    const array = new Proxy(['developer'], {});
    const revoked = Proxy.revocable({ policyId: 'roles', policyVersion: 'v1', roleName: 'developer' }, {});
    revoked.revoke();
    for (const input of [
      request({ rolePolicy: transparent }),
      request({ candidateSet: { ...request().candidateSet, candidates: array } }),
      request({ rolePolicy: revoked.proxy }),
    ]) {
      expect(() => compileAssembly(input)).not.toThrow();
      expect(compileAssembly(input).ok).toBe(false);
    }
  });

  it('rejects accessors without invoking their getters', () => {
    let getterCalls = 0;
    const rolePolicy = Object.defineProperty({}, 'policyId', {
      enumerable: true,
      get() { getterCalls++; return 'roles'; },
    });
    const result = compileAssembly(request({ rolePolicy }));
    expect(result.ok).toBe(false);
    expect(getterCalls).toBe(0);
  });

  it('returns a detached recursively frozen graph and leaves caller input mutable', () => {
    const input = request();
    const result = compileAssembly(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.artifact)).toBe(true);
    expect(Object.isFrozen(result.artifact.preparedInvocation)).toBe(true);
    expect(Object.isFrozen(result.artifact.preparedInvocation.evidenceRefs)).toBe(true);
    expect(Object.isFrozen(result.artifact.preparedInvocation.evidenceRefs[0])).toBe(true);
    expect(result.artifact.preparedInvocation.evidenceRefs).not.toBe(input.evidenceRefs);
    expect(Object.isFrozen(input)).toBe(false);
  });

  it('recursively freezes refusal results too', () => {
    const result = compileAssembly(request({ attemptBudget: 0 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.error)).toBe(true);
    expect(Object.isFrozen(result.error.details)).toBe(true);
  });
});
