// Shared strict canonical JSON v1 for new protocol surfaces.
// MUN-0020's existing canonicalJson remains unchanged and byte-stable.

import { types as utilTypes } from 'node:util';

export const CANONICAL_JSON_V1_MAX_DEPTH = 10;
export const CANONICAL_JSON_V1_MAX_CONTAINER_ENTRIES = 1024;
export const CANONICAL_JSON_V1_MAX_ENTRIES = 4096;
export const CANONICAL_JSON_V1_MAX_BYTES = 1024 * 1024;

export type CanonicalJsonV1Primitive = null | boolean | number | string;
export type CanonicalJsonV1Array = readonly CanonicalJsonV1Value[];
export interface CanonicalJsonV1Object {
  readonly [key: string]: CanonicalJsonV1Value;
}
export type CanonicalJsonV1Value =
  | CanonicalJsonV1Primitive
  | CanonicalJsonV1Array
  | CanonicalJsonV1Object;

export type CanonicalJsonV1FailureKind =
  | 'AMBIGUOUS_CANONICAL_VALUE'
  | 'UNSAFE_SIZE'
  | 'UNSAFE_NESTING';

export class CanonicalJsonV1Error extends Error {
  public readonly code = 'CANONICAL_JSON_V1_ERROR' as const;

  constructor(
    public readonly kind: CanonicalJsonV1FailureKind,
    public readonly path: string,
    message: string,
  ) {
    super(`Canonical JSON v1 error at ${path || '<root>'}: ${message}`);
    this.name = 'CanonicalJsonV1Error';
  }
}

interface Budget {
  entries: number;
  bytes: number;
}

/**
 * Reject hostile/ambiguous input and capture one detached inert snapshot.
 * Proxy detection happens before every reflective operation; accessors are
 * rejected from descriptors and are never invoked.
 */
export function captureCanonicalJsonV1(value: unknown): CanonicalJsonV1Value {
  return capture(value, '', 0, new WeakSet<object>(), { entries: 0, bytes: 0 });
}

export function canonicalJsonV1(value: unknown): string {
  const snapshot = captureCanonicalJsonV1(value);
  const output = serialize(snapshot);
  if (Buffer.byteLength(output, 'utf8') > CANONICAL_JSON_V1_MAX_BYTES) {
    fail('UNSAFE_SIZE', '', 'emitted canonical JSON exceeds its byte budget');
  }
  return output;
}

function capture(
  value: unknown,
  path: string,
  depth: number,
  active: WeakSet<object>,
  budget: Budget,
): CanonicalJsonV1Value {
  if (depth > CANONICAL_JSON_V1_MAX_DEPTH) {
    fail('UNSAFE_NESTING', path, `nesting depth exceeds ${CANONICAL_JSON_V1_MAX_DEPTH}`);
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) fail('AMBIGUOUS_CANONICAL_VALUE', path, 'lone UTF-16 surrogate');
    charge(budget, 0, Buffer.byteLength(value, 'utf8'), path);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) || Object.is(value, -0)) {
      fail('AMBIGUOUS_CANONICAL_VALUE', path, 'number must be a finite safe integer and not negative zero');
    }
    return value;
  }
  if (typeof value !== 'object') {
    fail('AMBIGUOUS_CANONICAL_VALUE', path, `${typeof value} has no canonical JSON representation`);
  }

  const object = value as object;
  if (utilTypes.isProxy(object)) {
    fail('AMBIGUOUS_CANONICAL_VALUE', path, 'Proxy values are prohibited');
  }
  if (active.has(object)) fail('AMBIGUOUS_CANONICAL_VALUE', path, 'cyclic reference');
  active.add(object);
  try {
    if (Array.isArray(object)) {
      if (Object.getPrototypeOf(object) !== Array.prototype) {
        fail('AMBIGUOUS_CANONICAL_VALUE', path, 'array has an exotic prototype');
      }
      const descriptors = Object.getOwnPropertyDescriptors(object) as Record<string, PropertyDescriptor>;
      if (Object.getOwnPropertySymbols(object).length > 0) {
        fail('AMBIGUOUS_CANONICAL_VALUE', path, 'array has symbol keys');
      }
      // Non-Proxy ECMAScript arrays intrinsically carry a uint32 length data
      // property. Proxies were rejected above, so there is no separate
      // representable invalid-length branch to validate here.
      const length = descriptors.length.value as number;
      if (length > CANONICAL_JSON_V1_MAX_CONTAINER_ENTRIES) {
        fail('UNSAFE_SIZE', path, `array exceeds ${CANONICAL_JSON_V1_MAX_CONTAINER_ENTRIES} entries`);
      }
      charge(budget, length, 0, path);
      const names = Object.keys(descriptors).filter((key) => key !== 'length');
      if (names.length !== length || names.some((key) => !isCanonicalArrayIndex(key, length))) {
        fail('AMBIGUOUS_CANONICAL_VALUE', path, 'array must be dense and have index properties only');
      }
      const output: CanonicalJsonV1Value[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (!isEnumerableDataDescriptor(descriptor)) {
          fail('AMBIGUOUS_CANONICAL_VALUE', `${path}[${index}]`, 'array entry must be an enumerable data property');
        }
        output.push(capture(descriptor.value, `${path || '<root>'}[${index}]`, depth + 1, active, budget));
      }
      return output;
    }

    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('AMBIGUOUS_CANONICAL_VALUE', path, 'only plain objects are canonical');
    }
    if (Object.getOwnPropertySymbols(object).length > 0) {
      fail('AMBIGUOUS_CANONICAL_VALUE', path, 'object has symbol keys');
    }
    const descriptors = Object.getOwnPropertyDescriptors(object);
    const names = Object.keys(descriptors);
    if (names.length > CANONICAL_JSON_V1_MAX_CONTAINER_ENTRIES) {
      fail('UNSAFE_SIZE', path, `object exceeds ${CANONICAL_JSON_V1_MAX_CONTAINER_ENTRIES} entries`);
    }
    charge(
      budget,
      names.length,
      names.reduce((total, key) => total + Buffer.byteLength(key, 'utf8'), 0),
      path,
    );
    // Null-prototype snapshots make every accepted key data, including the
    // special spelling "__proto__". Assignment into `{}` would invoke the
    // inherited setter, erase that own key, and permit closed-schema bypasses.
    const output: Record<string, CanonicalJsonV1Value> = Object.create(null);
    for (const key of names.sort(compareUtf8)) {
      if (hasLoneSurrogate(key)) fail('AMBIGUOUS_CANONICAL_VALUE', path, 'object key has a lone UTF-16 surrogate');
      const descriptor = descriptors[key];
      if (!isEnumerableDataDescriptor(descriptor)) {
        fail('AMBIGUOUS_CANONICAL_VALUE', childPath(path, key), 'property must be an enumerable data property');
      }
      output[key] = capture(descriptor.value, childPath(path, key), depth + 1, active, budget);
    }
    return output;
  } finally {
    active.delete(object);
  }
}

function serialize(value: CanonicalJsonV1Value): string {
  // Every serializer input is the detached snapshot returned by capture(),
  // which already enforces the depth bound. Keeping a second unreachable
  // refusal here produced an untestable mutation site rather than protection.
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return escapeJsonString(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => serialize(item)).join(',')}]`;
  }
  const object = value as CanonicalJsonV1Object;
  const keys = Object.keys(object).sort(compareUtf8);
  return `{${keys.map((key) => `${escapeJsonString(key)}:${serialize(object[key])}`).join(',')}}`;
}

function escapeJsonString(value: string): string {
  let output = '"';
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(++index);
      output += `\\u${unit.toString(16).padStart(4, '0')}\\u${low.toString(16).padStart(4, '0')}`;
      continue;
    }
    switch (unit) {
      case 0x08: output += '\\b'; break;
      case 0x09: output += '\\t'; break;
      case 0x0a: output += '\\n'; break;
      case 0x0c: output += '\\f'; break;
      case 0x0d: output += '\\r'; break;
      case 0x22: output += '\\"'; break;
      case 0x5c: output += '\\\\'; break;
      default:
        output += unit < 0x20 || unit >= 0x7f
          ? `\\u${unit.toString(16).padStart(4, '0')}`
          : value[index];
    }
  }
  return `${output}"`;
}

export function parseCanonicalJsonV1(rawText: string): CanonicalJsonV1Value {
  assertRawBounds(rawText);
  assertNoDuplicateKeys(rawText);
  assertIntegerTokens(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    fail('AMBIGUOUS_CANONICAL_VALUE', '', 'input is not valid JSON');
  }
  return captureCanonicalJsonV1(parsed);
}

export function assertCanonicalJsonV1RawBounds(rawText: string): void {
  assertRawBounds(rawText);
}

function assertRawBounds(rawText: string): void {
  if (Buffer.byteLength(rawText, 'utf8') > CANONICAL_JSON_V1_MAX_BYTES) {
    fail('UNSAFE_SIZE', '', `raw JSON exceeds ${CANONICAL_JSON_V1_MAX_BYTES} bytes`);
  }
  let inString = false;
  let escaped = false;
  const stack: Array<{ commas: number; content: boolean }> = [];
  let totalEntries = 0;
  for (const character of rawText) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      if (stack.length) stack[stack.length - 1].content = true;
    } else if (character === '{' || character === '[') {
      if (stack.length) stack[stack.length - 1].content = true;
      stack.push({ commas: 0, content: false });
      if (stack.length > CANONICAL_JSON_V1_MAX_DEPTH) fail('UNSAFE_NESTING', '', 'raw JSON nesting depth exceeds maximum');
    } else if (character === ',' && stack.length) {
      stack[stack.length - 1].commas++;
    } else if (character === '}' || character === ']') {
      const container = stack.pop();
      if (container) {
        const count = container.content ? container.commas + 1 : 0;
        if (count > CANONICAL_JSON_V1_MAX_CONTAINER_ENTRIES) fail('UNSAFE_SIZE', '', 'raw container is too large');
        totalEntries += count;
        if (totalEntries > CANONICAL_JSON_V1_MAX_ENTRIES) fail('UNSAFE_SIZE', '', 'raw JSON has too many entries');
      }
    } else if (!/\s|:/.test(character) && stack.length) {
      stack[stack.length - 1].content = true;
    }
  }
}

function assertNoDuplicateKeys(rawText: string): void {
  let index = 0;
  const whitespace = () => { while (/\s/.test(rawText[index] ?? '')) index++; };
  const stringToken = (): string => {
    const start = index;
    index = skipString(rawText, index);
    try { return JSON.parse(rawText.slice(start, index)) as string; }
    catch { fail('AMBIGUOUS_CANONICAL_VALUE', '', 'invalid JSON string'); }
  };
  const value = (): void => {
    whitespace();
    if (rawText[index] === '{') {
      index++; whitespace();
      const keys = new Set<string>();
      if (rawText[index] === '}') { index++; return; }
      while (index < rawText.length) {
        whitespace();
        if (rawText[index] !== '"') fail('AMBIGUOUS_CANONICAL_VALUE', '', 'object key must be a string');
        const key = stringToken();
        if (keys.has(key)) fail('AMBIGUOUS_CANONICAL_VALUE', '', 'duplicate object key');
        keys.add(key); whitespace();
        if (rawText[index++] !== ':') fail('AMBIGUOUS_CANONICAL_VALUE', '', 'missing colon');
        value(); whitespace();
        if (rawText[index] === '}') { index++; return; }
        if (rawText[index++] !== ',') fail('AMBIGUOUS_CANONICAL_VALUE', '', 'missing comma');
      }
    }
    if (rawText[index] === '[') {
      index++; whitespace();
      if (rawText[index] === ']') { index++; return; }
      while (index < rawText.length) {
        value(); whitespace();
        if (rawText[index] === ']') { index++; return; }
        if (rawText[index++] !== ',') fail('AMBIGUOUS_CANONICAL_VALUE', '', 'missing comma');
      }
    }
    if (rawText[index] === '"') { stringToken(); return; }
    const start = index;
    while (index < rawText.length && !/[\s,\]}]/.test(rawText[index])) index++;
    if (start === index) fail('AMBIGUOUS_CANONICAL_VALUE', '', 'missing value');
  };
  value(); whitespace();
  if (index !== rawText.length) fail('AMBIGUOUS_CANONICAL_VALUE', '', 'trailing JSON content');
}

function assertIntegerTokens(rawText: string): void {
  for (let index = 0; index < rawText.length;) {
    if (rawText[index] === '"') { index = skipString(rawText, index); continue; }
    if (rawText[index] === '-' || /[0-9]/.test(rawText[index])) {
      const start = index++;
      while (/[0-9.eE+-]/.test(rawText[index] ?? '')) index++;
      const token = rawText.slice(start, index);
      if (token === '-0') {
        fail('AMBIGUOUS_CANONICAL_VALUE', '', 'numeric token is negative zero');
      }
      if (/[.eE]/.test(token) || !Number.isSafeInteger(Number(token))) {
        fail('AMBIGUOUS_CANONICAL_VALUE', '', 'numeric token is outside the safe-integer domain');
      }
      continue;
    }
    index++;
  }
}

function skipString(text: string, quote: number): number {
  let index = quote + 1;
  while (index < text.length) {
    if (text[index] === '\\') index += 2;
    else if (text[index++] === '"') return index;
  }
  return index;
}

function charge(budget: Budget, entries: number, bytes: number, path: string): void {
  budget.entries += entries;
  budget.bytes += bytes;
  if (budget.entries > CANONICAL_JSON_V1_MAX_ENTRIES || budget.bytes > CANONICAL_JSON_V1_MAX_BYTES) {
    fail('UNSAFE_SIZE', path, 'canonical document exceeds its resource budget');
  }
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function isEnumerableDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } {
  return descriptor !== undefined
    && descriptor.enumerable === true
    && Object.prototype.hasOwnProperty.call(descriptor, 'value');
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) return true;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function childPath(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

function fail(kind: CanonicalJsonV1FailureKind, path: string, message: string): never {
  throw new CanonicalJsonV1Error(kind, path || '<root>', message);
}
