// MUN-0020: Strict canonical JSON serialization and SHA-256 command digests.
// Fails closed on any non-JSON value. Per-call cycle detection via recursion
// stack — thread-safe, no module-level mutable state.

import { createHash } from 'node:crypto';
import type { ExecutionAuthorityCommand } from './execution-authority.types';

export class CanonicalJsonError extends Error {
  public readonly code = 'CANONICAL_JSON_ERROR' as const;

  constructor(message: string) {
    super(`Canonical JSON error: ${message}`);
    this.name = 'CanonicalJsonError';
  }
}

// ---------------------------------------------------------------------------
// JsonValue / JsonObject types
// ---------------------------------------------------------------------------

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonArray
  | JsonObject;

export type JsonArray = JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Produce a stable canonical JSON string. Throws CanonicalJsonError on any
 *  non-JSON value. Thread-safe. */
export function canonicalJson(value: JsonValue): string {
  const stack: object[] = [];
  return serialize(value, stack, 0);
}

/** Compute SHA-256 hex digest of the canonical JSON form of `command`. */
export function commandDigest(command: ExecutionAuthorityCommand): string {
  const json = canonicalJson(command as unknown as JsonValue);
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

/** Compute the SHA-256 hex digest of arbitrary canonical JSON bytes. */
export function jsonDigest(value: JsonValue): string {
  const json = canonicalJson(value);
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Serializer internals
// ---------------------------------------------------------------------------

function serialize(value: JsonValue, stack: object[], depth: number): string {
  if (depth > 100) {
    throw new CanonicalJsonError('nesting depth exceeds 100');
  }

  if (value === null) return 'null';

  const t = typeof value;

  if (t === 'boolean') return value ? 'true' : 'false';

  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalJsonError(
        `non-finite number ${value} is not valid JSON`,
      );
    }
    return JSON.stringify(value);
  }

  if (t === 'string') {
    return JSON.stringify(value);
  }

  // Reject non-JSON primitives
  if (t === 'undefined' || t === 'bigint' || t === 'function' || t === 'symbol') {
    throw new CanonicalJsonError(`${t} is not a valid JSON type`);
  }

  // t === 'object' from here
  if (value === null) return 'null'; // unreachable but safe

  // --- Arrays ---
  if (Array.isArray(value)) {
    const arr = value as unknown[];

    // Reject sparse arrays
    const ownKeys = Object.keys(arr).filter(k => /^\d+$/.test(k));
    if (arr.length !== ownKeys.length) {
      throw new CanonicalJsonError('sparse arrays are not valid canonical JSON');
    }
    // Reject extra non-index properties on arrays
    for (const k of Object.getOwnPropertyNames(arr)) {
      if (!/^\d+$/.test(k) && k !== 'length') {
        throw new CanonicalJsonError(
          `array has non-index property: ${k}`,
        );
      }
    }

    // Cycle check
    checkCycle(value, stack);

    stack.push(value);
    const items = arr.map((v) => serialize(v as JsonValue, stack, depth + 1));
    stack.pop();
    return `[${items.join(',')}]`;
  }

  // --- Objects ---
  if (typeof value === 'object') {
    // Reject non-plain objects
    if (!isPlainObject(value)) {
      const name = getObjectName(value);
      throw new CanonicalJsonError(`non-plain object (${name}) is not valid JSON`);
    }

    // Reject objects with symbol keys or accessor properties
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new CanonicalJsonError('objects with symbol keys are not valid canonical JSON');
    }
    for (const key of Object.keys(value)) {
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (desc && (desc.get !== undefined || desc.set !== undefined)) {
        throw new CanonicalJsonError(
          `property "${key}" has an accessor descriptor`,
        );
      }
    }

    // Cycle check
    checkCycle(value, stack);

    stack.push(value);
    const keys = Object.keys(value as JsonObject).sort();
    const pairs = keys.map((k) => {
      const v = (value as JsonObject)[k];
      return `${JSON.stringify(k)}:${serialize(v, stack, depth + 1)}`;
    });
    stack.pop();
    return `{${pairs.join(',')}}`;
  }

  throw new CanonicalJsonError(`unexpected type: ${t}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkCycle(value: object, stack: object[]): void {
  if (stack.includes(value)) {
    throw new CanonicalJsonError('cyclic reference detected');
  }
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  if (proto === null) return true;
  return proto === Object.prototype;
}

function getObjectName(value: object): string {
  try {
    const proto = Object.getPrototypeOf(value);
    if (proto && proto.constructor && proto.constructor.name) {
      return proto.constructor.name;
    }
  } catch {
    // accessing .constructor on proxies may throw
  }
  return 'unknown';
}
