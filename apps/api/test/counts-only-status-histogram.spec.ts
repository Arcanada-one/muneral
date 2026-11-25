import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import type { PrismaClient } from '@prisma/client';
import ts from 'typescript';
import { readCountsOnlyStatusHistogram } from '../src/tasks/counts-only-status-histogram.js';

const EMPTY_COUNTS = {
  todo: 0,
  in_progress: 0,
  review: 0,
  blocked: 0,
  done: 0,
  cancelled: 0,
  archived: 0,
  unknown: 0,
  invalid: 0,
};
const SCOPE_VERSION = 'fixture-scope-1';
const PROJECT_IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
];
const START = new Date('2026-11-25T19:00:00.000Z');
const END = new Date('2026-11-25T19:00:01.250Z');
const REFUSAL = 'D182_COUNTS_REFUSED';
const FIXTURE_SHA256 = 'c447b6258cae0b3ae9a7717e337b3ae915e6fbf60f1f11ca49c5b6e256782b1d';
const SOURCE = readFileSync(
  new URL('../src/tasks/counts-only-status-histogram.ts', import.meta.url),
  'utf8',
);

const group = (status: unknown, count = 1) => ({ status, _count: { _all: count } });

function makeReader(groups: ReturnType<typeof group>[], total: number) {
  return {
    task: {
      groupBy: jest.fn(async () => groups),
      count: jest.fn(async () => total),
    },
  };
}

function evaluateAdapter(source: string, bindings: Record<string, unknown> = {}): unknown {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  runInNewContext(outputText, { ...bindings, module, exports: module.exports });
  return module.exports;
}

async function expectRefusal(result: Promise<string>) {
  const error: unknown = await result.catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({ name: 'Error', message: REFUSAL });
  expect(Object.getOwnPropertyNames(error).sort()).toEqual(['message', 'stack']);
}

describe('counts-only status histogram', () => {
  it('keeps scope in source and imports no environment, Prisma or request dependency', async () => {
    const file = ts.createSourceFile('adapter.ts', SOURCE, ts.ScriptTarget.Latest, true);
    const imports = file.statements.filter(ts.isImportDeclaration).map((statement) => ({
      module: statement.moduleSpecifier.getText(file),
      typeOnly: statement.importClause?.isTypeOnly,
    }));
    expect(imports).toEqual([{ module: "'@muneral/types'", typeOnly: true }]);
    expect(SOURCE).not.toMatch(/\b(?:process|prisma|request)\b/i);

    const payload = await readCountsOnlyStatusHistogram(makeReader([], 0), SCOPE_VERSION);
    expect(JSON.parse(payload).scope_version).toBe('fixture-scope-1');
  });

  it('refuses malformed allowlist entries during module initialization', () => {
    const malformed = SOURCE.replace("'fixture-scope-1'", "'INVALID_SCOPE'");
    expect(malformed).not.toBe(SOURCE);
    expect(() => evaluateAdapter(malformed)).toThrow(REFUSAL);
  });

  it.each([
    ['empty', '[]'],
    ['malformed', "['not-a-project-uuid']"],
  ])('refuses an %s project list at load before any query', (_description, replacement) => {
    const malformed = SOURCE.replace(/projectIds: \[[^\]]*\]/, `projectIds: ${replacement}`);
    expect(malformed).not.toBe(SOURCE);
    const reader = makeReader([], 0);
    const source = `${malformed}\nvoid readCountsOnlyStatusHistogram(reader, '${SCOPE_VERSION}');`;

    expect(() => evaluateAdapter(source, { reader })).toThrow(REFUSAL);
    expect(reader.task.groupBy).not.toHaveBeenCalled();
    expect(reader.task.count).not.toHaveBeenCalled();
  });

  it('has no separate cohort parameter for the same scope label', () => {
    const file = ts.createSourceFile('adapter.ts', SOURCE, ts.ScriptTarget.Latest, true);
    const reader = file.statements.filter(ts.isFunctionDeclaration)
      .find((declaration) => declaration.name?.text === 'readCountsOnlyStatusHistogram');
    expect(reader?.parameters.map((parameter) => [
      parameter.name.getText(file),
      parameter.type?.getText(file),
    ])).toEqual([
      ['db', 'StatusCohortReader'],
      ['scopeVersion', 'string'],
      ['now', '() => Date'],
    ]);
  });

  it.each([
    ['unknown', 'unlisted-scope-1'],
    ['malformed', 'UNLISTED_SCOPE'],
  ])('refuses a %s scope before either query', async (_description, scopeVersion) => {
    const reader = makeReader([], 0);
    await expectRefusal(readCountsOnlyStatusHistogram(reader, scopeVersion));
    expect(reader.task.groupBy).not.toHaveBeenCalled();
    expect(reader.task.count).not.toHaveBeenCalled();
  });

  it('refuses a null status group even when the independent count agrees', async () => {
    const reader = makeReader([{ status: null, _count: { _all: 1 } }], 1);
    await expectRefusal(readCountsOnlyStatusHistogram(reader, SCOPE_VERSION));
  });

  it('refuses an invalid-only constructor status cohort', async () => {
    const reader = makeReader([{ status: 'constructor', _count: { _all: 1 } }], 1);
    await expectRefusal(readCountsOnlyStatusHistogram(reader, SCOPE_VERSION));
  });

  it('keeps nine internal buckets with distinct unknown and invalid counts', () => {
    const statuses = ['todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled', 'archived'];
    const groups = [...statuses.map((status) => group(status, 2)), group(null, 3), group('unknown', 4)];
    const counts = evaluateAdapter(`${SOURCE}\nmodule.exports = buildCounts(${JSON.stringify(groups)}, 21);`);
    expect(counts).toEqual({
      todo: 2, in_progress: 2, review: 2, blocked: 2, done: 2, cancelled: 2, archived: 2,
      unknown: 3, invalid: 4,
    });
  });

  it('uses an own-property-safe accumulator for prototype property names', () => {
    const groups = ['constructor', 'toString', '__proto__'].map((status) => group(status));
    const counts = evaluateAdapter(`${SOURCE}\nmodule.exports = buildCounts(${JSON.stringify(groups)}, 3);`);
    expect(Object.getPrototypeOf(counts)).toBeNull();
    expect(counts).toEqual({ ...EMPTY_COUNTS, invalid: 3 });
  });

  it.each([
    { groups: [], total: 0 },
    { groups: [group('blocked', 3)], total: 3 },
  ])('emits zero done only for a reconciled set with no done group', async ({ groups, total }) => {
    const payload = await readCountsOnlyStatusHistogram(makeReader(groups, total), SCOPE_VERSION);
    expect(JSON.parse(payload)).toMatchObject({
      'tasks.total_current': String(total),
      'tasks.source_done_current': '0',
    });
  });

  it('emits only the two metrics with no status, completeness or as_of claim', async () => {
    const groups = [
      group('todo'), group('in_progress'), group('review'), group('blocked'), group('done'),
      group('cancelled'), group('archived'),
    ];
    const payload = await readCountsOnlyStatusHistogram(makeReader(groups, 7), SCOPE_VERSION);
    expect(Object.keys(JSON.parse(payload))).toEqual([
      'contract', 'scope_version', 'capture_start', 'capture_end',
      'tasks.total_current', 'tasks.source_done_current',
    ]);
    expect(payload).not.toMatch(/by_status|todo|in_progress|review|blocked|cancelled|archived|unknown|invalid|unlisted_status/);
  });

  it('uses only the scope projectId IN list for grouping and independent count', async () => {
    const reader = makeReader([group('done', 3)], 3);
    const acceptsGeneratedPrismaClient:
      PrismaClient extends Parameters<typeof readCountsOnlyStatusHistogram>[0] ? true : never = true;
    expect(acceptsGeneratedPrismaClient).toBe(true);

    const payload = await readCountsOnlyStatusHistogram(reader, SCOPE_VERSION);
    const where = { projectId: { in: PROJECT_IDS } };

    expect(reader.task.groupBy.mock.calls).toEqual([[{ where, by: ['status'], _count: { _all: true } }]]);
    expect(reader.task.count.mock.calls).toEqual([[{ where }]]);
    expect(JSON.parse(payload)).toMatchObject({
      'tasks.total_current': '3',
      'tasks.source_done_current': '3',
    });
  });

  it('reproduces the exact fixture and brackets both reads with capture instants', async () => {
    const reader = makeReader([
      group('todo', 3), group('in_progress', 2), group('review'), group('done', 4),
      group('cancelled', 2),
    ], 12);
    const now = jest.fn(() => END).mockReturnValueOnce(START);
    const payload = await readCountsOnlyStatusHistogram(reader, SCOPE_VERSION, now);
    const callOrder = [
      now.mock.invocationCallOrder[0],
      reader.task.groupBy.mock.invocationCallOrder[0],
      reader.task.count.mock.invocationCallOrder[0],
      now.mock.invocationCallOrder[1],
    ];
    expect(callOrder).toEqual([...callOrder].sort((left, right) => left - right));

    const bytes = Buffer.from(payload, 'utf8');
    const fixture = readFileSync(new URL('./fixtures/d182-counts-fixture-2.json', import.meta.url));
    expect(bytes).toEqual(fixture);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(FIXTURE_SHA256);
  });

  it('serializes the largest safe count as a decimal string', async () => {
    const total = Number.MAX_SAFE_INTEGER;
    const payload = await readCountsOnlyStatusHistogram(makeReader([group('done', total)], total), SCOPE_VERSION);
    expect(JSON.parse(payload)).toMatchObject({
      'tasks.total_current': '9007199254740991',
      'tasks.source_done_current': '9007199254740991',
    });
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, -1, 0.5, Number.NaN])(
    'refuses an unsafe independent count of %s',
    async (total) => {
      await expectRefusal(readCountsOnlyStatusHistogram(makeReader([], total), SCOPE_VERSION));
    },
  );

  it.each([Number.MAX_SAFE_INTEGER + 1, -1, 0.5, Number.NaN])(
    'refuses an unsafe group count of %s',
    async (count) => {
      await expectRefusal(readCountsOnlyStatusHistogram(makeReader([group('done', count)], 0), SCOPE_VERSION));
    },
  );

  it.each(['done', 'blocked'])(
    'refuses when the grouped %s counts differ from the independent count',
    async (status) => {
      await expectRefusal(readCountsOnlyStatusHistogram(makeReader([group(status, 3)], 2), SCOPE_VERSION));
    },
  );

  it('refuses out-of-cohort groups from a faulty mock through the count mismatch', async () => {
    const reader = makeReader([group('done', 4), group('cancelled')], 4);
    await expectRefusal(readCountsOnlyStatusHistogram(reader, SCOPE_VERSION));
  });

  it('refuses when combining status groups would overflow a bucket', async () => {
    const groups = [group('future_status', Number.MAX_SAFE_INTEGER), group('other_future_status')];
    await expectRefusal(readCountsOnlyStatusHistogram(makeReader(groups, Number.MAX_SAFE_INTEGER), SCOPE_VERSION));
  });

  it('refuses a clock that moves backward between the reads', async () => {
    const now = jest.fn(() => START).mockReturnValueOnce(END);
    await expectRefusal(readCountsOnlyStatusHistogram(makeReader([], 0), SCOPE_VERSION, now));
  });

  class OverridesISOString extends Date {
    override toISOString(): string {
      return 'synthetic capture text!!';
    }
  }

  class OverridesGetTime extends Date {
    override getTime(): number {
      return 0;
    }
  }

  class OverridesPrimitiveConversion extends Date {
    override [Symbol.toPrimitive](): never {
      throw new Error('the formatter must not coerce the clock object');
    }
  }

  it.each([
    ['toISOString', OverridesISOString],
    ['getTime', OverridesGetTime],
    ['Symbol.toPrimitive', OverridesPrimitiveConversion],
  ] as const)('serializes the intrinsic clock time despite a %s override', async (_method, ClockDate) => {
    const now = jest.fn(() => new ClockDate(END.getTime()))
      .mockReturnValueOnce(new ClockDate(START.getTime()));
    const payload = await readCountsOnlyStatusHistogram(makeReader([], 0), SCOPE_VERSION, now);

    const { capture_start, capture_end } = JSON.parse(payload);
    expect([capture_start, capture_end]).toEqual([
      '2026-11-25T19:00:00.000Z',
      '2026-11-25T19:00:01.250Z',
    ]);
  });

  it.each([
    ['non-Date receiver', () => ({ toISOString: () => START.toISOString() }) as Date],
    ['invalid Date', () => new Date(Number.NaN)],
    ['extended year', () => new Date('+010000-01-01T00:00:00.000Z')],
  ] as const)('returns the fixed refusal for a %s from the clock', async (_label, now) => {
    await expectRefusal(readCountsOnlyStatusHistogram(makeReader([], 0), SCOPE_VERSION, now));
  });

  it('wraps clock exceptions in the same fixed refusal', async () => {
    await expectRefusal(readCountsOnlyStatusHistogram(makeReader([], 0), SCOPE_VERSION, () => {
      throw new Error('synthetic clock diagnostic');
    }));
  });

  it.each([
    { ...group('todo'), title: 'synthetic title' },
    { ...group('todo'), description: 'synthetic body' },
    { ...group('todo'), id: 'synthetic id' },
    Object.defineProperty(group('todo'), 'hidden', { value: 'synthetic field' }),
    Object.assign(Object.create({ title: 'synthetic inherited field' }), group('todo')),
    { status: 'todo', _count: { _all: 1, title: 1 } },
  ])('refuses unexpected fields in grouped results', async (row) => {
    await expectRefusal(readCountsOnlyStatusHistogram(makeReader([row], 1), SCOPE_VERSION));
  });

  it.each(['groupBy', 'count'] as const)(
    'wraps %s errors in a fixed refusal and emits no log output',
    async (method) => {
      const reader = makeReader([], 0);
      const source = Object.assign(new Error('synthetic private ID, row and body'), {
        meta: { id: 'synthetic id', title: 'synthetic title', body: 'synthetic body' },
      });
      reader.task[method].mockRejectedValueOnce(source);
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const)
        .map((level) => jest.spyOn(console, level).mockImplementation(() => {}));

      try {
        const result = readCountsOnlyStatusHistogram(reader, SCOPE_VERSION);
        await expectRefusal(result);
        await expect(result).rejects.not.toBe(source);
        await expect(result).rejects.not.toHaveProperty('cause');
        expect(spies.flatMap((spy) => spy.mock.calls)).toEqual([]);
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    },
  );
});
