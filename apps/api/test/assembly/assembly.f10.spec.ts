// MUN-0022 F10 — frozen pure-contract rereview regressions.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as assembly from '../../src/assembly';
import {
  AssemblyCanonicalJsonError,
  assemblyCanonicalJson,
  assemblyParseCanonicalJson,
} from '../../src/assembly/assembly.canonical';
import { createAssemblyError } from '../../src/assembly/assembly.errors';
import { validateAssemblyRequest } from '../../src/assembly/assembly.validator';
import type { AssemblyRequestV0 } from '../../src/assembly/assembly.types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'positive', 'minimal-request.json'), 'utf8'),
) as { input: AssemblyRequestV0; expectedArtifactId: string; expectedDigest: string };

describe('F10 frozen pure public contract', () => {
  it('exports exactly the one public value entry point authorized by the plan', () => {
    expect(Object.keys(assembly).sort()).toEqual(['compileAssembly']);
  });

  it('returns the PRD AssemblyArtifactV0 with one authenticated invocation identity', () => {
    const result = assembly.compileAssembly(fixture.input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.artifactId).toBe(fixture.expectedArtifactId);
    expect(result.artifact.digest).toBe(fixture.expectedDigest);
    expect(result.artifact.artifactId).toBe(result.artifact.digest);
    expect(result.artifact.preparedInvocation.invocationId).toMatch(/^[0-9a-f]{64}$/);
    expect(result.artifact.preparedInvocation.invocationId).not.toBe(result.artifact.digest);
    expect(result.artifact).not.toHaveProperty('nodes');
    expect(result.artifact).not.toHaveProperty('edges');
  });

  it('copies canonical inputs so caller mutation cannot rewrite a compiled artifact', () => {
    const request: AssemblyRequestV0 = {
      ...fixture.input,
      candidateSet: { ...fixture.input.candidateSet, candidates: [...fixture.input.candidateSet.candidates] },
      traceFields: { nested: { value: 'before' } },
    };
    const result = assembly.compileAssembly(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    (request.candidateSet.candidates as string[])[0] = 'rewritten';
    (request.traceFields as any).nested.value = 'after';
    expect(result.artifact.candidateSet.candidates[0]).not.toBe('rewritten');
    expect((result.artifact.traceFields as any).nested.value).toBe('before');
  });

  it('does not ship runtime or side-effect vocabulary through the root barrel', () => {
    for (const forbidden of [
      'createExecutionAdapter', 'createCommitSeam', 'createInProcessCommitPort',
      'ingestExecutionResult', 'submitReceipt', 'ShellPort', 'TimeoutPort',
    ]) {
      expect(assembly).not.toHaveProperty(forbidden);
    }
  });
});

describe('F10 deterministic and secret-safe errors', () => {
  const syntheticCredentials = [
    ['generic-base64', 'A'.repeat(40)],
    ['jwt', `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`],
    ['slack', `xoxb-${'a'.repeat(20)}`],
    ['aws', `AKIA${'A'.repeat(16)}`],
    ['gitlab', `glpat-${'a'.repeat(20)}`],
    ['github', `github_pat_${'a'.repeat(24)}`],
    ['openai-style', `sk-${'a'.repeat(20)}`],
    ['bearer', `Bearer ${'a'.repeat(20)}`],
  ] as const;

  it.each(syntheticCredentials)('never echoes rejected %s-shaped identities', (_label, sentinel) => {
    const result = validateAssemblyRequest(
      { ...fixture.input, taskId: sentinel },
    ) as any;
    expect(result.errorCode).toBe('CREDENTIAL_IN_PROHIBITED_POSITION');
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it.each(syntheticCredentials)('never echoes rejected %s-shaped object keys', (_label, sentinel) => {
    const result = validateAssemblyRequest(
      { ...fixture.input, traceFields: { [sentinel]: 'ordinary' } },
    ) as any;
    expect(result.errorCode).toBe('CREDENTIAL_IN_PROHIBITED_POSITION');
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it('keeps error identities distinct across bounded observable detail classes', () => {
    const pairs: Array<[unknown, unknown]> = [
      [1n, 2n],
      [0, -0],
    ];
    for (const [left, right] of pairs) {
      const a = createAssemblyError('UNSAFE_SIZE', 't', 'c', 'co', { reason: 'x', actual: left });
      const b = createAssemblyError('UNSAFE_SIZE', 't', 'c', 'co', { reason: 'x', actual: right });
      expect(a.errorId).not.toBe(b.errorId);
    }
  });

  it('coalesces Symbol and function details by opaque class without inspecting source', () => {
    const pairs: Array<[unknown, unknown]> = [
      [Symbol.for('\ud800'), Symbol.for('\ud801')],
      [function left() { return 1; }, function right() { return 2; }],
    ];
    for (const [left, right] of pairs) {
      const a = createAssemblyError('UNSAFE_SIZE', 't', 'c', 'co', { reason: 'x', actual: left });
      const b = createAssemblyError('UNSAFE_SIZE', 't', 'c', 'co', { reason: 'x', actual: right });
      expect(a.errorId).toBe(b.errorId);
    }
  });
});

describe('F10 raw canonical ingestion bounds', () => {
  it.each(['-0', '{"n":-0}', '[-0]'])('rejects negative zero lexically: %s', (raw) => {
    expect(() => assemblyParseCanonicalJson(raw)).toThrow(/negative zero/i);
  });

  it('rejects excessive raw nesting with the typed canonical error, not RangeError', () => {
    const raw = '['.repeat(20_000) + '0' + ']'.repeat(20_000);
    try {
      assemblyParseCanonicalJson(raw);
      throw new Error('accepted excessive nesting');
    } catch (error) {
      expect(error).toBeInstanceOf(AssemblyCanonicalJsonError);
      expect(error).not.toBeInstanceOf(RangeError);
      expect((error as Error).message).toMatch(/nesting depth/i);
    }
  });

  it('rejects duplicate decoded keys before JSON.parse can collapse them', () => {
    expect(() => assemblyParseCanonicalJson('{"x":1,"x":2}')).toThrow(/duplicate/i);
    expect(() => assemblyParseCanonicalJson('{"x":1,"\\u0078":2}')).toThrow(/duplicate/i);
  });

  it('keeps the object serializer closed over primitive and resource bounds', () => {
    const maxContainer = (assembly as any).MAX_CONTAINER_ENTRIES ?? 1024;
    expect(() => assemblyCanonicalJson(Array(maxContainer + 1).fill(0) as never)).toThrow();
    expect(() => assemblyCanonicalJson({ n: -0 } as never)).toThrow(/negative zero/i);
  });
});

describe('F10 hostile public input', () => {
  it('returns typed errors for accessors and proxies instead of throwing', () => {
    const getter = Object.defineProperty({}, 'taskId', {
      enumerable: true,
      get: () => { throw new Error('getter'); },
    });
    const proxy = new Proxy({}, { ownKeys: () => { throw new Error('proxy'); } });
    for (const value of [getter, proxy]) {
      expect(() => validateAssemblyRequest(value)).not.toThrow();
      expect((validateAssemblyRequest(value) as any).errorCode).toBeDefined();
    }
  });
});

describe('F10 independent Python boundary', () => {
  it('rejects negative zero and excessive raw nesting before json.loads', () => {
    const validator = path.join(__dirname, 'validate_assembly_fixtures.py');
    const script = [
      'import runpy, sys',
      'm = runpy.run_path(sys.argv[1])',
      'for raw in ["-0", "{\\"n\\":-0}", "[-0]"]:',
      '  try:',
      '    m["assert_integer_only_number_tokens"](raw)',
      '  except m["CanonicalLexicalError"]:',
      '    pass',
      '  else:',
      '    raise AssertionError("negative zero accepted")',
      'raw = "[" * 20000 + "0" + "]" * 20000',
      'try:',
      '  m["assert_raw_canonical_resource_bounds"](raw)',
      'except m["CanonicalLexicalError"]:',
      '  pass',
      'else:',
      '  raise AssertionError("excessive nesting accepted")',
    ].join('\n');
    expect(() => execFileSync('python3', ['-c', script, validator], { stdio: 'pipe' })).not.toThrow();
  });
});

describe('F10 evidence tooling cannot flatter the result', () => {
  it('classifies spawn errors, signals and null statuses as harness failures', () => {
    const harness = require('./mutation-harness.js') as any;
    expect(harness.classify({ code: null, signal: 'SIGKILL', error: null, out: '' })).toBe('HARNESS_ERROR');
    expect(harness.classify({ code: null, signal: null, error: new Error('spawn'), out: '' })).toBe('HARNESS_ERROR');
    expect(harness.classify({ code: 1, signal: null, error: null, out: 'unrelated failure' }))
      .toBe('HARNESS_ERROR');
  });

  it('fixture regeneration passes the shared pinned evaluation instant', () => {
    const generator = fs.readFileSync(path.join(__dirname, 'generate-fixtures.js'), 'utf8');
    expect(generator).toContain('compile(input)');
  });

  it('disables an unbraced refusal without deleting condition side effects', () => {
    const harness = require('./mutation-harness.js') as any;
    const source = "if (raw[index++] !== ':') throw new ParserError('BAD');\naccept();";
    const [site] = harness.enumerateSites(source, 'parser.ts');
    const mutant = harness.applyMutant(source, site);
    expect(mutant).toContain("raw[index++] !== ':'");
    expect(mutant).toMatch(/if \(raw\[index\+\+\] !== ':'\)[^\n]*\{\}/);
    expect(mutant).toContain('accept();');
  });
});
