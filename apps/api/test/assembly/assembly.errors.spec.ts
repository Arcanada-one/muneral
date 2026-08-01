// MUN-0022: Error construction tests — deterministic error ID,
// code exhaustiveness, deterministic timestamps, and factory correctness.

import { createHash } from 'node:crypto';
import { ASSEMBLY_ERROR_CODES } from '../../src/assembly/assembly.types';
import type { AssemblyErrorCode, AssemblyErrorV0 } from '../../src/assembly/assembly.types';
import { canonicalJsonV1 } from '../../src/execution-authority/canonical-json-v1';
import {
  createAssemblyError,
  createAssemblyErrorOpaqueIdentity,
} from '../../src/assembly/assembly.errors';

function expectedTaskIdentityErrorId(taskIdentity: unknown): string {
  const preimage = canonicalJsonV1({
    kind: 'assembly-error-id-v0',
    errorCode: 'UNSAFE_SIZE',
    taskId: taskIdentity,
    causationId: 'c',
    correlationId: 'co',
    canonicalDetails: canonicalJsonV1({ reason: 'r' }),
  });
  return createHash('sha256').update(preimage, 'utf8').digest('hex');
}

describe('createAssemblyError', () => {
  const taskId = 'task-1';
  const causationId = 'caus-1';
  const correlationId = 'corr-1';

  it('returns an AssemblyErrorV0 with all required fields', () => {
    const err = createAssemblyError('UNSUPPORTED_SCHEMA_VERSION', taskId, causationId, correlationId, { reason: 'test' });
    expect(typeof err.errorId).toBe('string');
    expect(err.errorId).toHaveLength(64);
    expect(err.errorCode).toBe('UNSUPPORTED_SCHEMA_VERSION');
    expect(typeof err.message).toBe('string');
    expect(err.message.length).toBeGreaterThan(0);
    expect(err.schemaVersion).toBe('v0');
    expect(err.taskId).toBe(taskId);
    expect(err.causationId).toBe(causationId);
    expect(err.correlationId).toBe(correlationId);
    expect(typeof err.failedAt).toBe('string');
    expect(err.failedAt.endsWith('Z')).toBe(true);
    expect(err.details.reason).toBe('test');
  });

  it('produces deterministic error IDs for identical inputs', () => {
    const details = { reason: 'test' };
    const id1 = createAssemblyError('AUTHORITY_WIDENING', taskId, causationId, correlationId, details).errorId;
    const id2 = createAssemblyError('AUTHORITY_WIDENING', taskId, causationId, correlationId, { ...details }).errorId;
    expect(id1).toBe(id2);
  });

  it('produces byte-identical errors for identical inputs', () => {
    const first = createAssemblyError('AUTHORITY_WIDENING', taskId, causationId, correlationId, { reason: 'test' });
    const second = createAssemblyError('AUTHORITY_WIDENING', taskId, causationId, correlationId, { reason: 'test' });
    expect(second).toEqual(first);
    expect(first.failedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('produces different error IDs for different error codes', () => {
    const id1 = createAssemblyError('UNSUPPORTED_SCHEMA_VERSION', taskId, causationId, correlationId, { reason: 't' }).errorId;
    const id2 = createAssemblyError('UNKNOWN_EXECUTION_FIELD', taskId, causationId, correlationId, { reason: 't' }).errorId;
    expect(id1).not.toBe(id2);
  });

  it('error ID is valid lowercase hex SHA-256', () => {
    const err = createAssemblyError('EXPIRED_POLICY', taskId, causationId, correlationId, { reason: 'expired' });
    expect(err.errorId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('includes a human-readable message for every error code', () => {
    for (const code of ASSEMBLY_ERROR_CODES) {
      const err = createAssemblyError(code, taskId, causationId, correlationId, { reason: 'test' });
      expect(err.message.length).toBeGreaterThan(0);
    }
  });

  it('all 12 error codes are constructable without throwing', () => {
    for (const code of ASSEMBLY_ERROR_CODES) {
      expect(() => createAssemblyError(code, 't', 'c', 'co', { reason: 'test' })).not.toThrow();
    }
  });

  it('each error code has distinct default message prefix', () => {
    const messages = new Set<string>();
    for (const code of ASSEMBLY_ERROR_CODES) {
      const err = createAssemblyError(code, 't', 'c', 'co', { reason: 'test' });
      messages.add(err.message);
    }
    expect(messages.size).toBe(12);
  });

  it('UNKNOWN_EXECUTION_FIELD message is descriptive', () => {
    const err = createAssemblyError('UNKNOWN_EXECUTION_FIELD', taskId, causationId, correlationId, { reason: 'unknown field', fieldName: 'digest' });
    expect(err.message).toContain('digest');
  });
});

describe('errorId is canonical and complete', () => {
  it('is independent of detail key insertion order', () => {
    // The id used JSON.stringify, which is insertion-order dependent — so two
    // errors with identical details built in different order got different ids,
    // in a package whose premise is that identity bytes reproduce across
    // runtimes. It now uses the package's own canonicalizer.
    const a = createAssemblyError('UNSAFE_SIZE', 't', 'c', 'co', { reason: 'r', fieldName: 'f', actual: 'a' });
    const b = createAssemblyError('UNSAFE_SIZE', 't', 'c', 'co', { actual: 'a', fieldName: 'f', reason: 'r' });
    expect(b.errorId).toBe(a.errorId);
  });

  it('includes correlationId, which the docstring named and the input omitted', () => {
    const a = createAssemblyError('UNSAFE_SIZE', 't', 'c', 'co-1', { reason: 'r' });
    const b = createAssemblyError('UNSAFE_SIZE', 't', 'c', 'co-2', { reason: 'r' });
    expect(b.errorId).not.toBe(a.errorId);
  });

  it('uses an unambiguous projection when identity fields contain NUL', () => {
    const a = createAssemblyError('UNSAFE_SIZE', 'a\0b', 'c', 'co', { reason: 'r' });
    const b = createAssemblyError('UNSAFE_SIZE', 'a', 'b\0c', 'co', { reason: 'r' });
    expect(b.errorId).not.toBe(a.errorId);
  });

  it('source-binds distinct malformed UTF-16 identity strings without Unicode repair', () => {
    const highSurrogate = createAssemblyError('UNSAFE_SIZE', '\ud800', 'c', 'co', { reason: 'r' });
    const adjacentSurrogate = createAssemblyError('UNSAFE_SIZE', '\ud801', 'c', 'co', { reason: 'r' });
    const replacementCharacter = createAssemblyError('UNSAFE_SIZE', '\ufffd', 'c', 'co', { reason: 'r' });

    expect(highSurrogate.errorId).not.toBe(adjacentSurrogate.errorId);
    expect(highSurrogate.errorId).not.toBe(replacementCharacter.errorId);
  });

  it('domain-separates malformed primitive identity classes', () => {
    const numeric = createAssemblyError('UNSAFE_SIZE', 1, 'c', 'co', { reason: 'r' });
    const boolean = createAssemblyError('UNSAFE_SIZE', false, 'c', 'co', { reason: 'r' });
    const positiveZero = createAssemblyError('UNSAFE_SIZE', 0, 'c', 'co', { reason: 'r' });
    const negativeZero = createAssemblyError('UNSAFE_SIZE', -0, 'c', 'co', { reason: 'r' });
    const empty = createAssemblyError('UNSAFE_SIZE', '', 'c', 'co', { reason: 'r' });
    const missing = createAssemblyError('UNSAFE_SIZE', undefined, 'c', 'co', { reason: 'r' });

    expect(numeric.errorId).not.toBe(boolean.errorId);
    expect(positiveZero.errorId).not.toBe(negativeZero.errorId);
    expect(empty.errorId).not.toBe(missing.errorId);
  });

  it('uses the normative opaque field tag for every opaque identity class', () => {
    const proxy = new Proxy({}, {});
    const overBudget = 'x'.repeat(1_048_577);
    const hugeBigint = 1n << 4_096n;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const vectors: Array<[unknown, string, number?]> = [
      [proxy, 'proxy'],
      [overBudget, 'string-over-inspection-budget', overBudget.length],
      [hugeBigint, 'bigint-over-inspection-budget'],
      [cyclic, 'uninspectable-object'],
      [createAssemblyErrorOpaqueIdentity('identity-accessor'), 'identity-accessor'],
    ];

    for (const [value, className, observedLength] of vectors) {
      const error = createAssemblyError('UNSAFE_SIZE', value, 'c', 'co', { reason: 'r' });
      expect(error.errorId).toBe(expectedTaskIdentityErrorId({
        kind: 'assembly-error-identity-opaque-v0',
        class: className,
        ...(observedLength === undefined ? {} : { observedLength }),
      }));
    }
  });

  it('classifies Symbols as deterministic opaque identities without reading their keys', () => {
    const first = createAssemblyError('UNSAFE_SIZE', Symbol.for('\ud800'), 'c', 'co', { reason: 'r' });
    const second = createAssemblyError('UNSAFE_SIZE', Symbol.for('\ud801'), 'c', 'co', { reason: 'r' });
    const expected = expectedTaskIdentityErrorId({
      kind: 'assembly-error-identity-opaque-v0',
      class: 'symbol',
    });

    expect(first.errorId).toBe(expected);
    expect(second.errorId).toBe(expected);
  });

  it('never throws, whatever the details contain', () => {
    // This is the ERROR CONSTRUCTOR. A throw here turns every refusal into an
    // exception — the failure mode this package exists to remove. Canonical
    // serialization refuses undefined by design, and optional detail fields are
    // routinely present-but-undefined.
    expect(() => createAssemblyError('UNSAFE_SIZE', 't', 'c', 'co', {
      reason: 'r', fieldName: undefined, actual: undefined,
    })).not.toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => createAssemblyError('UNSAFE_SIZE', 't', 'c', 'co', cyclic as never)).not.toThrow();
    const throwing = new Proxy({ reason: 'r' }, {
      ownKeys: () => { throw new Error('ownKeys trap'); },
      get: () => { throw new Error('get trap'); },
    });
    expect(() => createAssemblyError('UNSAFE_SIZE', 't', 'c', 'co', throwing)).not.toThrow();
    const target = { reason: 'r' };
    const revocable = Proxy.revocable(target, {});
    revocable.revoke();
    expect(() => createAssemblyError('UNSAFE_SIZE', 't', 'c', 'co', revocable.proxy)).not.toThrow();
  });

  it('omitting an undefined detail equals not passing it at all', () => {
    const a = createAssemblyError('UNSAFE_SIZE', 't', 'c', 'co', { reason: 'r', actual: undefined });
    const b = createAssemblyError('UNSAFE_SIZE', 't', 'c', 'co', { reason: 'r' });
    expect(b.errorId).toBe(a.errorId);
  });

  it('source-binds oversized escaped canonical details through a bounded descriptor', () => {
    const details = { reason: 'unknown execution field', fieldName: '"'.repeat(500_000) };
    const canonicalDetails = canonicalJsonV1(details);
    const descriptor = {
      kind: 'assembly-error-details-digest-v0',
      encoding: 'canonical-json-v1-utf8',
      byteLength: Buffer.byteLength(canonicalDetails, 'utf8'),
      sha256: createHash('sha256').update(canonicalDetails, 'utf8').digest('hex'),
    };
    const preimage = canonicalJsonV1({
      kind: 'assembly-error-id-v0',
      errorCode: 'UNKNOWN_EXECUTION_FIELD',
      taskId: 't',
      causationId: 'c',
      correlationId: 'co',
      canonicalDetails: descriptor,
    });

    const error = createAssemblyError('UNKNOWN_EXECUTION_FIELD', 't', 'c', 'co', details);
    expect(error.errorId).toBe(createHash('sha256').update(preimage, 'utf8').digest('hex'));
  });
});
