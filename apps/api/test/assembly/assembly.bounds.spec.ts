// MUN-0022 Phase A / A4 — string length bounds are measured in UTF-8 bytes.
//
// The defect: TypeScript `.length` counts UTF-16 code units and Python `len()`
// counts code points, so a character-length limit means two different things. For a
// string of N emoji (1 code point, 2 UTF-16 units, 4 UTF-8 bytes each) against
// the 256 limit:
//
//   byte rule      rejects when 4N > 256  -> N > 64
//   TS .length     rejects when 2N > 256  -> N > 128
//   Python len()   rejects when  N > 256  -> N > 256
//
// So 65..128 emoji are accepted by BOTH implementations today and must be
// rejected under the byte rule; 129..256 are rejected by TypeScript and
// accepted by Python — a straight cross-language disagreement about which
// documents are valid.
//
// UTF-8 bytes is the convergent measure: the same 130-emoji string measures 260
// in TS, 130 in Python, and 520 bytes in both.

import { validateAssemblyRequest } from '../../src/assembly/assembly.validator';
import { MAX_FIELD_BYTES } from '../../src/assembly/assembly.types';
import * as fs from 'node:fs';

const base = JSON.parse(
  fs.readFileSync(__dirname + '/fixtures/positive/minimal-request.json', 'utf8'),
).input as Record<string, unknown>;

function withTaskId(taskId: string): Record<string, unknown> {
  return { ...JSON.parse(JSON.stringify(base)), taskId };
}

function isRejected(req: Record<string, unknown>): boolean {
  return 'errorCode' in (validateAssemblyRequest(req) as object);
}

describe('A4: string bounds are measured in UTF-8 bytes', () => {
  it('MAX_FIELD_BYTES names and pins the byte budget', () => {
    expect(MAX_FIELD_BYTES).toBe(256);
  });

  // 64 emoji = 256 bytes exactly — at the limit, accepted.
  it('accepts a value exactly at the byte limit', () => {
    expect(Buffer.byteLength('😀'.repeat(64), 'utf8')).toBe(256);
    expect(isRejected(withTaskId('😀'.repeat(64)))).toBe(false);
  });

  // The case BOTH implementations accept today and must reject.
  it('rejects 65 emoji (260 bytes) — accepted by both runtimes before A4', () => {
    expect(Buffer.byteLength('😀'.repeat(65), 'utf8')).toBe(260);
    expect(isRejected(withTaskId('😀'.repeat(65)))).toBe(true);
  });

  it('rejects a 2-byte-per-char value that overflows in bytes only', () => {
    // 'я' is 1 code point, 1 UTF-16 unit, 2 UTF-8 bytes.
    // 129 of them = 129 units, 129 code points, 258 bytes -> byte rule rejects,
    // both .length and len() would accept.
    expect(Buffer.byteLength('я'.repeat(129), 'utf8')).toBe(258);
    expect(isRejected(withTaskId('я'.repeat(129)))).toBe(true);
  });

  // NOTE: the ASCII probes deliberately include a hyphen. A long unbroken run
  // of [A-Za-z0-9+/] matches the base64-shaped credential pattern and is
  // rejected as CREDENTIAL_IN_PROHIBITED_POSITION before the size rule is ever
  // consulted — which would make a size assertion pass for the wrong reason.
  it('still accepts a plain ASCII value at the limit', () => {
    const value = 'abc-'.repeat(64); // 256 chars, 256 bytes, not base64-shaped
    expect(value).toHaveLength(256);
    expect(Buffer.byteLength(value, 'utf8')).toBe(256);
    expect(isRejected(withTaskId(value))).toBe(false);
  });

  it('still rejects a plain ASCII value over the limit', () => {
    const value = 'abc-'.repeat(64) + 'x'; // 257 chars
    expect(Buffer.byteLength(value, 'utf8')).toBe(257);
    expect(isRejected(withTaskId(value))).toBe(true);
  });

  it('reports UNSAFE_SIZE for a byte-overflowing value', () => {
    const result = validateAssemblyRequest(withTaskId('😀'.repeat(65))) as {
      errorCode?: string;
    };
    expect(result.errorCode).toBe('UNSAFE_SIZE');
  });
});
