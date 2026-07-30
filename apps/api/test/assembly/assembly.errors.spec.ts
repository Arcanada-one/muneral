// MUN-0022: Error construction tests — deterministic error ID,
// code exhaustiveness, and factory correctness.

import { createHash } from 'node:crypto';
import { ASSEMBLY_ERROR_CODES } from '../../src/assembly/assembly.types';
import type { AssemblyErrorCode, AssemblyErrorV0 } from '../../src/assembly/assembly.types';
import { createAssemblyError } from '../../src/assembly/assembly.errors';

describe('createAssemblyError', () => {
  const taskId = 'task-1';
  const causationId = 'caus-1';
  const correlationId = 'corr-1';

  it('returns an AssemblyErrorV0 with all required fields', () => {
    const err = createAssemblyError(
      'UNSUPPORTED_SCHEMA_VERSION',
      taskId,
      causationId,
      correlationId,
      { reason: 'schemaVersion must be "v0"' },
    );

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
    // ISO 8601 UTC: ends with Z
    expect(err.failedAt.endsWith('Z')).toBe(true);
    expect(err.details.reason).toBe('schemaVersion must be "v0"');
  });

  it('produces deterministic error IDs for identical inputs', () => {
    const details = { reason: 'test', fieldName: 'scope' };
    const id1 = createAssemblyError(
      'AUTHORITY_WIDENING',
      taskId,
      causationId,
      correlationId,
      details,
    ).errorId;

    const id2 = createAssemblyError(
      'AUTHORITY_WIDENING',
      taskId,
      causationId,
      correlationId,
      { ...details },
    ).errorId;

    expect(id1).toBe(id2);
  });

  it('produces different error IDs for different error codes', () => {
    const details = { reason: 'test' };
    const id1 = createAssemblyError(
      'UNSUPPORTED_SCHEMA_VERSION',
      taskId,
      causationId,
      correlationId,
      details,
    ).errorId;

    const id2 = createAssemblyError(
      'UNKNOWN_EXECUTION_FIELD',
      taskId,
      causationId,
      correlationId,
      details,
    ).errorId;

    expect(id1).not.toBe(id2);
  });

  it('produces different error IDs for different taskIds', () => {
    const details = { reason: 'test' };
    const id1 = createAssemblyError(
      'UNSAFE_SIZE',
      'task-1',
      causationId,
      correlationId,
      details,
    ).errorId;

    const id2 = createAssemblyError(
      'UNSAFE_SIZE',
      'task-2',
      causationId,
      correlationId,
      details,
    ).errorId;

    expect(id1).not.toBe(id2);
  });

  it('produces different error IDs when details differ', () => {
    const id1 = createAssemblyError('UNSAFE_NESTING', taskId, causationId, correlationId, {
      reason: 'depth 11 exceeds max 10',
    }).errorId;

    const id2 = createAssemblyError('UNSAFE_NESTING', taskId, causationId, correlationId, {
      reason: 'depth 12 exceeds max 10',
    }).errorId;

    expect(id1).not.toBe(id2);
  });

  it('error ID is valid lowercase hex SHA-256', () => {
    const err = createAssemblyError('EXPIRED_POLICY', taskId, causationId, correlationId, {
      reason: 'policy expired',
    });

    expect(err.errorId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('includes a human-readable message for every error code', () => {
    for (const code of ASSEMBLY_ERROR_CODES) {
      const err = createAssemblyError(code, taskId, causationId, correlationId, {
        reason: 'test',
      });
      expect(err.message.length).toBeGreaterThan(0);
      expect(typeof err.message).toBe('string');
    }
  });

  it('error message includes the reason and fieldName from details', () => {
    const err = createAssemblyError(
      'CREDENTIAL_IN_PROHIBITED_POSITION',
      taskId,
      causationId,
      correlationId,
      { reason: 'bearer token in purpose', fieldName: 'purpose' },
    );

    expect(err.message).toContain('bearer token in purpose');
    expect(err.message).toContain('purpose');
  });
});

describe('error code exhaustiveness', () => {
  it('all 18 error codes are constructable without throwing', () => {
    for (const code of ASSEMBLY_ERROR_CODES) {
      expect(() =>
        createAssemblyError(code, 't', 'c', 'co', { reason: 'test' }),
      ).not.toThrow();
    }
  });

  it('each error code has distinct default message prefix', () => {
    const messages = new Set<string>();
    for (const code of ASSEMBLY_ERROR_CODES) {
      const err = createAssemblyError(code, 't', 'c', 'co', { reason: 'test' });
      messages.add(err.message);
    }
    // All 18 messages should be distinct (different codes → different messages)
    expect(messages.size).toBe(18);
  });
});

describe('failedAt timestamp', () => {
  it('is within 1 second of now', () => {
    const before = new Date();
    const err = createAssemblyError('INVALID_DIGEST', 't', 'c', 'co', {
      reason: 'test',
    });
    const after = new Date();

    const failedAt = new Date(err.failedAt);
    // Allow 2 seconds tolerance for test execution
    expect(failedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 2000);
    expect(failedAt.getTime()).toBeLessThanOrEqual(after.getTime() + 2000);
  });
});
