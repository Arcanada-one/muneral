import * as fs from 'node:fs';
import { compileAssembly } from '../../src/assembly';
import { validateAssemblyRequest } from '../../src/assembly/assembly.validator';

const base = JSON.parse(
  fs.readFileSync(__dirname + '/fixtures/positive/full-request.json', 'utf8'),
).input as Record<string, unknown>;

function withTrace(trace: unknown): Record<string, unknown> {
  return { ...JSON.parse(JSON.stringify(base)), traceFields: trace };
}
function codeOf(req: Record<string, unknown>): string | undefined {
  return (validateAssemblyRequest(req) as { errorCode?: string }).errorCode;
}
function nest(depth: number): unknown {
  let value: unknown = { leaf: 'x' };
  for (let i = 0; i < depth; i++) value = { nested: value };
  return value;
}
function compileFailure(input: Record<string, unknown>) {
  const result = compileAssembly(input as never);
  if (result.ok) throw new Error('expected Assembly refusal');
  return result.error;
}

describe('request boundary depth hardening', () => {
  it('returns UNSAFE_NESTING rather than throwing at depth 20,000', () => {
    const input = withTrace(nest(20_000));
    expect(() => validateAssemblyRequest(input)).not.toThrow();
    expect(codeOf(input)).toBe('UNSAFE_NESTING');
  });

  it('accepts ordinary shallow canonical data', () => {
    expect(codeOf(withTrace({ a: { b: { c: 'ok' } } }))).toBeUndefined();
  });

  it.each(['taskId', 'causationId', 'correlationId'] as const)(
    'returns a typed error when captured %s nearly fills the raw byte budget',
    (field) => {
      const input = {
        ...base,
        [field]: 'a'.repeat(1_048_400),
      };
      let result: ReturnType<typeof compileAssembly> | undefined;
      expect(() => { result = compileAssembly(input as never); }).not.toThrow();
      expect(result?.ok).toBe(false);
      if (result?.ok === false) expect(result.error.errorCode).toBe('UNSAFE_SIZE');
    },
  );

  it.each(['taskId', 'causationId', 'correlationId'] as const)(
    'source-binds malformed primitive %s values before returning UNSAFE_SIZE',
    (field) => {
      const numeric = compileFailure({ ...base, [field]: 1 });
      const boolean = compileFailure({ ...base, [field]: false });

      expect(numeric.errorCode).toBe('UNSAFE_SIZE');
      expect(boolean.errorCode).toBe('UNSAFE_SIZE');
      expect(numeric.errorId).not.toBe(boolean.errorId);
    },
  );

  it.each(['taskId', 'causationId', 'correlationId'] as const)(
    'source-binds exact malformed UTF-16 code units for %s capture failures',
    (field) => {
      const first = compileFailure({ ...base, [field]: '\ud800' });
      const second = compileFailure({ ...base, [field]: '\ud801' });

      expect(first.errorCode).toBe('AMBIGUOUS_CANONICAL_VALUE');
      expect(second.errorCode).toBe('AMBIGUOUS_CANONICAL_VALUE');
      expect(first.errorId).not.toBe(second.errorId);
      expect(first[field]).toBe('');
      expect(second[field]).toBe('');
    },
  );

  it('binds canonical identity containers by value rather than insertion order', () => {
    const first = compileFailure({ ...base, taskId: { a: 1, b: 2 } });
    const reordered = compileFailure({ ...base, taskId: { b: 2, a: 1 } });
    const changed = compileFailure({ ...base, taskId: { a: 1, b: 3 } });

    expect(first.errorId).toBe(reordered.errorId);
    expect(first.errorId).not.toBe(changed.errorId);
  });

  it('uses stable opaque classes without invoking proxy traps or accessors', () => {
    let trapCalls = 0;
    const proxy = () => new Proxy({}, {
      get: () => { trapCalls++; throw new Error('get trap'); },
      getOwnPropertyDescriptor: () => { trapCalls++; throw new Error('descriptor trap'); },
      ownKeys: () => { trapCalls++; throw new Error('ownKeys trap'); },
    });
    const proxyFirst = compileFailure({ ...base, taskId: proxy() });
    const proxySecond = compileFailure({ ...base, taskId: proxy() });

    let getterCalls = 0;
    const accessorRequest = () => {
      const input = { ...base };
      Object.defineProperty(input, 'taskId', {
        enumerable: true,
        get: () => { getterCalls++; throw new Error('identity getter'); },
      });
      return input;
    };
    const accessorFirst = compileFailure(accessorRequest());
    const accessorSecond = compileFailure(accessorRequest());

    expect(trapCalls).toBe(0);
    expect(getterCalls).toBe(0);
    expect(proxyFirst.errorId).toBe(proxySecond.errorId);
    expect(accessorFirst.errorId).toBe(accessorSecond.errorId);
  });
});

describe('credential scan has no unconditional exemption', () => {
  it.each([
    ['embedded bearer', "curl -H 'Authorization: Bearer eyJzdWIiOiJhIn0abc'"], // gitleaks:allow -- synthetic detector regression
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIn0.SflKxwRJSMeKKF2QT4fwpM'],
    ['GitHub PAT', 'ghp_16C7e42F292c6912E7710c838347Ae178B4a'], // gitleaks:allow -- synthetic detector regression
    ['Slack token', `xoxb-${'2401234567'}-${'abcdefghijklmnop'}`],
    ['hex-shaped secret', 'de'.repeat(32)],
  ])('rejects %s in a free-form position', (_label, value) => {
    expect(codeOf(withTrace({ value }))).toBe('CREDENTIAL_IN_PROHIBITED_POSITION');
  });

  it('accepts schema-declared digests and ordinary identifiers', () => {
    expect(codeOf(JSON.parse(JSON.stringify(base)))).toBeUndefined();
    expect(codeOf(withTrace({ a: 'task-nodeadline', b: 'disk-optimization1' }))).toBeUndefined();
  });
});
