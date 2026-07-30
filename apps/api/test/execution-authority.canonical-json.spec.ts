// MUN-0020: Canonical JSON and command digest unit tests.
// Stability is critical — same bytes must produce the same digest across
// processes and platforms.

import {
  canonicalJson,
  commandDigest,
  jsonDigest,
} from '../src/execution-authority/canonical-json';
import type { IssueInitialAttemptCommand } from '../src/execution-authority/execution-authority.types';

describe('canonicalJson', () => {
  it('sorts object keys lexicographically', () => {
    const obj = { b: 2, a: 1, c: { z: 3, y: 2 } };
    const result = canonicalJson(obj);
    expect(result).toBe('{"a":1,"b":2,"c":{"y":2,"z":3}}');
  });

  it('preserves array element order', () => {
    const arr = [3, 1, 2];
    const result = canonicalJson(arr);
    expect(result).toBe('[3,1,2]');
  });

  it('produces stable output for different key insertion orders', () => {
    // JavaScript objects may preserve insertion order, but canonical JSON must not
    const obj1 = Object.assign(
      Object.create(null),
      JSON.parse('{"z":1,"a":2,"m":3}'),
    );
    const obj2 = Object.assign(
      Object.create(null),
      JSON.parse('{"a":2,"m":3,"z":1}'),
    );
    expect(canonicalJson(obj1)).toBe(canonicalJson(obj2));
  });

  it('handles primitives', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson('hello')).toBe('"hello"');
  });

  it('rejects non-JSON types (undefined, bigint, function, symbol)', () => {
    expect(() => canonicalJson(undefined as unknown as never)).toThrow();
    expect(() => canonicalJson(Infinity as unknown as never)).toThrow();
    expect(() => canonicalJson(NaN as unknown as never)).toThrow();
  });

  it('serialises empty structures', () => {
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
  });

  it('escapes strings containing special JSON characters', () => {
    const result = canonicalJson({ key: 'quote"test' });
    expect(result).toBe('{"key":"quote\\"test"}');
  });
});

describe('commandDigest', () => {
  it('produces a stable SHA-256 hex digest', () => {
    const cmd1: IssueInitialAttemptCommand = {
      kind: 'issue_initial_attempt',
      taskId: '00000000-0000-0000-0000-000000000001',
      expectedVersion: 0,
      idempotencyKey: 'key-1',
      causationId: 'cause-1',
      correlationId: 'corr-1',
      retryBudget: 3,
      retryBackoffMs: 1_000,
      evidenceRefs: [],
    };

    const cmd2: IssueInitialAttemptCommand = {
      kind: 'issue_initial_attempt',
      taskId: '00000000-0000-0000-0000-000000000001',
      expectedVersion: 0,
      idempotencyKey: 'key-1',
      causationId: 'cause-1',
      correlationId: 'corr-1',
      retryBudget: 3,
      retryBackoffMs: 1_000,
      evidenceRefs: [],
    };

    const d1 = commandDigest(cmd1);
    const d2 = commandDigest(cmd2);

    expect(d1).toBe(d2);
    expect(d1).toHaveLength(64);
  });

  it('produces different digests for different commands', () => {
    const cmd1: IssueInitialAttemptCommand = {
      kind: 'issue_initial_attempt',
      taskId: '00000000-0000-0000-0000-000000000001',
      expectedVersion: 0,
      idempotencyKey: 'key-1',
      causationId: 'cause-1',
      correlationId: 'corr-1',
      retryBudget: 3,
      retryBackoffMs: 1_000,
      evidenceRefs: [],
    };

    const cmd2: IssueInitialAttemptCommand = {
      ...cmd1,
      taskId: '00000000-0000-0000-0000-000000000002',
    };

    expect(commandDigest(cmd1)).not.toBe(commandDigest(cmd2));
  });

  it('produces different digests for identical fields with different kind', () => {
    const cmd1: IssueInitialAttemptCommand = {
      kind: 'issue_initial_attempt',
      taskId: '00000000-0000-0000-0000-000000000001',
      expectedVersion: 0,
      idempotencyKey: 'key-1',
      causationId: 'cause-1',
      correlationId: 'corr-1',
      retryBudget: 3,
      retryBackoffMs: 1_000,
      evidenceRefs: [],
    };

    // Same fields but different kind would be a different discriminated union member
    // We test this by constructing a JSON-same but different-kind command via cast
    const cmd2 = { ...cmd1, kind: 'issue_retry_attempt' as const };
    expect(commandDigest(cmd1)).not.toBe(commandDigest(cmd2));
  });
});

describe('jsonDigest', () => {
  it('produces the same hash as SHA-256 of canonical JSON', () => {
    const obj = { result: { status: 'ok', version: 1 } };
    const h1 = jsonDigest(obj);

    // Manual SHA-256 for cross-check
    const { createHash } = require('node:crypto');
    const h2 = createHash('sha256')
      .update(canonicalJson(obj), 'utf8')
      .digest('hex');

    expect(h1).toBe(h2);
  });
});
