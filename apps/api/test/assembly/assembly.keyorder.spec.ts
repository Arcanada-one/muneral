// MUN-0022 Phase A / A3 — canonical object keys are ordered by UTF-8 byte
// sequence, which is identical to Unicode code-point order.
//
// The defect: Array.prototype.sort() orders by UTF-16 code unit, so an
// astral-plane key (surrogate pair, lead unit 0xD800-0xDBFF) sorts BEFORE
// U+FFFF in TypeScript and AFTER it in Python, whose sort_keys=True compares
// code points. Same input, two different canonical byte strings, two different
// digests — while both validators report success.
//
// Expected values below are pinned to Python's output, because code-point order
// is the cross-language contract (RFC 8785 specifies UTF-16 order, which is
// exactly what this package must NOT adopt: it would force the Python side to
// reimplement UTF-16 ordering, reintroducing the divergence class).

import { assemblyCanonicalJson } from '../../src/assembly/assembly.canonical';

describe('A3: object keys order by code point, matching the Python validator', () => {
  it('orders an astral key AFTER U+FFFF', () => {
    // RED on today's code: TS emits the emoji first.
    expect(assemblyCanonicalJson({ '￿': 1, '\u{1F600}': 2 } as never)).toBe(
      '{"\\uffff":1,"\\ud83d\\ude00":2}',
    );
  });

  it('orders a second astral key after a BMP key', () => {
    expect(assemblyCanonicalJson({ '＀': 1, '\u{10000}': 2 } as never)).toBe(
      '{"\\uff00":1,"\\ud800\\udc00":2}',
    );
  });

  it('leaves pure-ASCII ordering unchanged', () => {
    expect(assemblyCanonicalJson({ b: 1, a: 2, C: 3 } as never)).toBe(
      '{"C":3,"a":2,"b":1}',
    );
  });

  it('orders BMP non-ASCII keys by code point', () => {
    expect(assemblyCanonicalJson({ 'я': 1, 'a': 2 } as never)).toBe(
      '{"a":2,"\\u044f":1}',
    );
  });

  it('applies the same order inside nested objects', () => {
    expect(
      assemblyCanonicalJson({ outer: { '￿': 1, '\u{1F600}': 2 } } as never),
    ).toBe('{"outer":{"\\uffff":1,"\\ud83d\\ude00":2}}');
  });

  it('orders a prefix key before its extension', () => {
    expect(assemblyCanonicalJson({ ab: 1, a: 2 } as never)).toBe(
      '{"a":2,"ab":1}',
    );
  });
});
