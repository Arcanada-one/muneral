import { describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import {
  buildTaskActivitySnapshot,
  createTaskActivitySnapshotPages,
  normalizeExactDecimalToken,
  tagLosslessActivityPayload,
  TaskActivitySnapshotCodecError,
  validateAndReconstructTaskActivitySnapshot,
  type LosslessActivityJson,
  type SnapshotActivityInput,
  type TaskActivitySnapshotInput,
} from '../src/activity-snapshot/task-activity-snapshot-canonical.js';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const SNAPSHOT_ID = '55555555-5555-4555-8555-555555555555';

function activity(
  idTail: string,
  createdAt = '2026-01-02T03:04:05.123456Z',
  payload: LosslessActivityJson | null = null,
): SnapshotActivityInput {
  return {
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${idTail.padStart(12, '0')}`,
    task_id: TASK_ID,
    workspace_id: WORKSPACE_ID,
    actor_type: 'human',
    actor_id: OWNER_ID,
    action: 'task:updated',
    payload,
    created_at: createdAt,
  };
}

function input(activities: readonly SnapshotActivityInput[], pageSize = 2): TaskActivitySnapshotInput {
  return {
    snapshot_id: SNAPSHOT_ID,
    task_id: TASK_ID,
    workspace_id: WORKSPACE_ID,
    owner: { actor_type: 'human', actor_id: OWNER_ID },
    captured_at: '2024-02-28T23:59:59.123456Z',
    page_size: pageSize,
    task_at_snapshot: {
      id: TASK_ID,
      project_id: PROJECT_ID,
      status: 'in_progress',
      revision: 7,
      updated_at: '2024-02-29T00:14:59.654321Z',
    },
    activities,
  };
}

function expectCodecError(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error('expected codec operation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(TaskActivitySnapshotCodecError);
    expect((error as TaskActivitySnapshotCodecError).code).toBe(code);
  }
}

describe('TaskActivitySnapshotCanonical/v1 pure codec', () => {
  it('normalizes exact decimal tokens without IEEE-754 conversion', () => {
    const cases: readonly [string, string][] = [
      ['1.2300', '123e-2'],
      ['1000', '1e3'],
      ['-0.010', '-1e-2'],
      ['1', '1e0'],
      ['1e-0', '1e0'],
      ['1e+0', '1e0'],
      ['1.0', '1e0'],
      ['-1e-0', '-1e0'],
      ['-0e-0', '0e0'],
      ['900719925474099312345.00', '900719925474099312345e0'],
      ['0.00000120e+3', '12e-4'],
      ['1e-000', '1e0'],
    ];
    for (const [source, expected] of cases) expect(normalizeExactDecimalToken(source)).toBe(expected);
  });

  it.each(['', '+1', '01', '1.', '.1', '1e', '1e+', 'NaN', 'Infinity', '0x10'])(
    'rejects malformed or non-JSON numeric token %s', (token) => {
      expectCodecError(() => normalizeExactDecimalToken(token), 'SNAPSHOT_CONTENT_UNSUPPORTED');
    },
  );

  it.each([
    ['LF', '\n'],
    ['CR', '\r'],
    ['CRLF', '\r\n'],
    ['line separator', '\u2028'],
    ['paragraph separator', '\u2029'],
  ])('rejects a numeric token followed by a final %s', (_label, terminator) => {
    expectCodecError(() => normalizeExactDecimalToken(`1${terminator}`), 'SNAPSHOT_CONTENT_UNSUPPORTED');
  });

  it('tags all JSON shapes recursively and sorts object keys by UTF-16 code units', () => {
    const astralKey = '\u{10000}';
    const bmpKey = '\uE000';
    const payload: LosslessActivityJson = {
      type: 'object',
      entries: [
        { key: bmpKey, value: { type: 'boolean', value: false } },
        { key: 'control', value: { type: 'string', value: 'line\n\u0001' } },
        { key: astralKey, value: { type: 'array', items: [
          { type: 'null' },
          { type: 'number', token: '12.50e-1' },
          { type: 'object', entries: [] },
          { type: 'array', items: [] },
        ] } },
      ],
    };
    const tagged = tagLosslessActivityPayload(payload);
    expect(tagged).toEqual(['object', [
      ['control', ['string', 'line\n\u0001']],
      [astralKey, ['array', [['null'], ['number', '125e-2'], ['object', []], ['array', []]]]],
      [bmpKey, ['boolean', false]],
    ]]);
    expect(Object.isFrozen(tagged)).toBe(true);
  });

  it('rejects duplicate keys, lone surrogates, ordinary numbers and invalid node shapes', () => {
    expectCodecError(() => tagLosslessActivityPayload({
      type: 'object',
      entries: [
        { key: 'same', value: { type: 'null' } },
        { key: 'same', value: { type: 'boolean', value: true } },
      ],
    }), 'SNAPSHOT_CONTENT_UNSUPPORTED');
    expectCodecError(() => tagLosslessActivityPayload({ type: 'string', value: '\uD800' }), 'SNAPSHOT_CONTENT_UNSUPPORTED');
    expectCodecError(() => tagLosslessActivityPayload(3 as unknown as LosslessActivityJson), 'SNAPSHOT_CONTENT_UNSUPPORTED');
    expectCodecError(() => tagLosslessActivityPayload({ type: 'wat' } as unknown as LosslessActivityJson), 'SNAPSHOT_CONTENT_UNSUPPORTED');
    expectCodecError(() => tagLosslessActivityPayload({ type: 'null', extra: true } as unknown as LosslessActivityJson), 'SNAPSHOT_CONTENT_UNSUPPORTED');
  });

  it('validates exact UTC microseconds and derives expiry by exactly 900 seconds', () => {
    const snapshot = buildTaskActivitySnapshot(input([activity('000000000002')]));
    expect(snapshot.document.captured_at).toBe('2024-02-28T23:59:59.123456Z');
    expect(snapshot.document.expires_at).toBe('2024-02-29T00:14:59.123456Z');
    expect(snapshot.document.rows[0].activity.created_at).toBe('2026-01-02T03:04:05.123456Z');
    expect(snapshot.document.task_at_snapshot.updated_at).toBe('2024-02-29T00:14:59.654321Z');
    for (const invalidTimestamp of [
      '2024-02-29T00:00:00.123Z',
      '2023-02-29T00:00:00.123456Z',
      '2024-01-01T00:00:60.000000Z',
      '2024-01-01T00:00:00.000000+00:00',
      '0000-01-01T00:00:00.000000Z',
    ]) {
      expectCodecError(() => buildTaskActivitySnapshot({
        ...input([]),
        captured_at: invalidTimestamp,
      }), 'SNAPSHOT_CONTENT_UNSUPPORTED');
    }
    expectCodecError(() => buildTaskActivitySnapshot({ ...input([]), captured_at: '9999-12-31T23:59:59.000000Z' }), 'SNAPSHOT_CONTENT_UNSUPPORTED');
  });

  it('preserves the sole nullable activity identity through build and page reconstruction', () => {
    const nullableActivity = { ...activity('000000000001'), task_id: null };
    const snapshot = buildTaskActivitySnapshot(input([nullableActivity], 1));
    expect(snapshot.document.rows[0].activity.task_id).toBeNull();

    const pages = createTaskActivitySnapshotPages(snapshot);
    expect(validateAndReconstructTaskActivitySnapshot(pages)).toEqual(snapshot);
    expect(pages[0].rows[0].activity.task_id).toBeNull();

    const foreignActivity = { ...activity('000000000002'), task_id: PROJECT_ID };
    expectCodecError(() => buildTaskActivitySnapshot(input([foreignActivity], 1)), 'SNAPSHOT_CONTENT_UNSUPPORTED');
  });

  it('matches a literal canonical byte and digest vector', () => {
    const snapshot = buildTaskActivitySnapshot(input([activity('000000000001')]));
    const expectedCanonicalBytes = [
      '{"captured_at":"2024-02-28T23:59:59.123456Z","consistency":"materialized_repeatable_read","expires_at":"2024-02-29T00:14:59.123456Z","order":["created_at:desc","id:desc"],',
      '"owner":{"actor_id":"44444444-4444-4444-8444-444444444444","actor_type":"human"},"page_size":2,"rows":[{"activity":{"action":"task:updated","actor_id":"44444444-4444-4444-8444-444444444444","actor_type":"human","created_at":"2026-01-02T03:04:05.123456Z",',
      '"id":"aaaaaaaa-aaaa-4aaa-8aaa-000000000001","payload":["null"],"task_id":"11111111-1111-4111-8111-111111111111","workspace_id":"22222222-2222-4222-8222-222222222222"},"position":1}],"schema":"TaskActivitySnapshotCanonical/v1","snapshot_id":"55555555-5555-4555-8555-555555555555",',
      '"task_at_snapshot":{"id":"11111111-1111-4111-8111-111111111111","project_id":"33333333-3333-4333-8333-333333333333","revision":7,"status":"in_progress","updated_at":"2024-02-29T00:14:59.654321Z"},"task_id":"11111111-1111-4111-8111-111111111111","total":1,"workspace_id":"22222222-2222-4222-8222-222222222222"}',
    ].join('');

    expect(snapshot.canonical_bytes).toBe(expectedCanonicalBytes);
    expect(snapshot.snapshot_digest).toBe('sha256:5ecacd154adf7f10556e9edbb9daea77aeb2865331847d5c00879f410bc82c71');
  });

  it('builds stable canonical bytes and the domain-separated SHA-256 digest', () => {
    const first = buildTaskActivitySnapshot(input([
      activity('000000000002', '2026-01-02T03:04:05.123456Z', { type: 'number', token: '1.00' }),
      activity('000000000001', '2026-01-02T03:04:05.123456Z'),
    ]));
    const reorderedObjectKeys = buildTaskActivitySnapshot(input([
      activity('000000000002', '2026-01-02T03:04:05.123456Z', {
        type: 'object', entries: [
          { key: 'z', value: { type: 'number', token: '1000' } },
          { key: 'a', value: { type: 'string', value: 'é' } },
        ],
      }),
    ]));
    const sameObjectKeys = buildTaskActivitySnapshot(input([
      activity('000000000002', '2026-01-02T03:04:05.123456Z', {
        type: 'object', entries: [
          { key: 'a', value: { type: 'string', value: 'é' } },
          { key: 'z', value: { type: 'number', token: '1e3' } },
        ],
      }),
    ]));
    expect(first.canonical_bytes.endsWith('\n')).toBe(false);
    expect(first.canonical_bytes).toContain('"schema":"TaskActivitySnapshotCanonical/v1"');
    expect(first.snapshot_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(reorderedObjectKeys.canonical_bytes).toBe(sameObjectKeys.canonical_bytes);
    expect(reorderedObjectKeys.snapshot_digest).toBe(sameObjectKeys.snapshot_digest);
    const changedOwner = buildTaskActivitySnapshot({
      ...input([activity('000000000002', '2026-01-02T03:04:05.123456Z', { type: 'number', token: '1.00' })]),
      owner: { actor_type: 'human', actor_id: '66666666-6666-4666-8666-666666666666' },
    });
    const changedArrayOrder = buildTaskActivitySnapshot(input([
      activity('000000000002', '2026-01-02T03:04:05.123456Z', {
        type: 'array', items: [{ type: 'string', value: 'a' }, { type: 'string', value: 'b' }],
      }),
    ]));
    const reversedArrayOrder = buildTaskActivitySnapshot(input([
      activity('000000000002', '2026-01-02T03:04:05.123456Z', {
        type: 'array', items: [{ type: 'string', value: 'b' }, { type: 'string', value: 'a' }],
      }),
    ]));
    expect(changedOwner.snapshot_digest).not.toBe(buildTaskActivitySnapshot(input([
      activity('000000000002', '2026-01-02T03:04:05.123456Z', { type: 'number', token: '1.00' }),
    ])).snapshot_digest);
    expect(changedArrayOrder.snapshot_digest).not.toBe(reversedArrayOrder.snapshot_digest);
    expect(Object.isFrozen(first.document.rows[0].activity.payload)).toBe(true);
    expect(Reflect.set(first.document, 'total', 99)).toBe(false);
  });

  it('rejects unsorted ties, duplicate ids, invalid identities, statuses and exact field mismatches', () => {
    const newest = activity('000000000002');
    const olderId = activity('000000000001');
    expectCodecError(() => buildTaskActivitySnapshot(input([olderId, newest])), 'SNAPSHOT_CONTENT_UNSUPPORTED');
    expectCodecError(() => buildTaskActivitySnapshot(input([newest, newest])), 'SNAPSHOT_CONTENT_UNSUPPORTED');
    expectCodecError(() => buildTaskActivitySnapshot({
      ...input([]), task_id: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    }), 'SNAPSHOT_CONTENT_UNSUPPORTED');
    expectCodecError(() => buildTaskActivitySnapshot({
      ...input([]), task_at_snapshot: { ...input([]).task_at_snapshot, status: 'unknown' as never },
    }), 'SNAPSHOT_CONTENT_UNSUPPORTED');
    expectCodecError(() => buildTaskActivitySnapshot({ ...input([]), extra: true } as unknown as TaskActivitySnapshotInput), 'SNAPSHOT_INVALID_INPUT');
  });

  it('enforces page, row, depth, node and encoded-byte bounds', () => {
    expectCodecError(() => buildTaskActivitySnapshot(input([], 0)), 'SNAPSHOT_INVALID_INPUT');
    expectCodecError(() => buildTaskActivitySnapshot(input([], 501)), 'SNAPSHOT_INVALID_INPUT');
    const tooManyRows = Array.from({ length: 10_001 }, (_, index) => activity(String(index + 1).padStart(12, '0')));
    expectCodecError(() => buildTaskActivitySnapshot(input(tooManyRows)), 'SNAPSHOT_LIMIT_EXCEEDED');
    expectCodecError(() => buildTaskActivitySnapshot(input([activity('000000000001', '2026-01-02T03:04:05.123456Z', {
      type: 'string', value: 'x'.repeat(65 * 1024),
    })])), 'SNAPSHOT_LIMIT_EXCEEDED');

    let deep: LosslessActivityJson = { type: 'null' };
    for (let i = 0; i < 65; i++) deep = { type: 'array', items: [deep] };
    expectCodecError(() => tagLosslessActivityPayload(deep), 'SNAPSHOT_LIMIT_EXCEEDED');

    const manyNodes: LosslessActivityJson = {
      type: 'array',
      items: Array.from({ length: 16_384 }, () => ({ type: 'null' as const })),
    };
    expectCodecError(() => tagLosslessActivityPayload(manyNodes), 'SNAPSHOT_LIMIT_EXCEEDED');

    const sparse = new Array(1) as unknown as LosslessActivityJson;
    expectCodecError(() => tagLosslessActivityPayload({ type: 'array', items: sparse as never }), 'SNAPSHOT_CONTENT_UNSUPPORTED');
  });

  it('reconstructs the complete canonical document from immutable ordinal pages', () => {
    const snapshot = buildTaskActivitySnapshot(input([
      activity('000000000003', '2026-01-03T00:00:00.000001Z'),
      activity('000000000002', '2026-01-02T00:00:00.000001Z'),
      activity('000000000001', '2026-01-01T00:00:00.000001Z'),
    ]));
    const pages = createTaskActivitySnapshotPages(snapshot);
    expect(pages.map((page) => page.rows.map((row) => row.position))).toEqual([[1, 2], [3]]);
    expect(validateAndReconstructTaskActivitySnapshot(pages)).toEqual(snapshot);
    const independentDocument = {
      schema: pages[0].schema,
      snapshot_id: pages[0].snapshot_id,
      task_id: pages[0].task_id,
      workspace_id: pages[0].workspace_id,
      owner: pages[0].owner,
      captured_at: pages[0].captured_at,
      expires_at: pages[0].expires_at,
      consistency: pages[0].consistency,
      order: pages[0].order,
      page_size: pages[0].page_size,
      total: pages[0].total,
      task_at_snapshot: pages[0].task_at_snapshot,
      rows: pages.flatMap((page) => page.rows),
    };
    const independentBytes = independentJcs(independentDocument);
    const independentDigest = `sha256:${createHash('sha256')
      .update('Muneral.TaskActivitySnapshotCanonical/v1', 'ascii')
      .update(Buffer.from([0]))
      .update(independentBytes, 'utf8')
      .digest('hex')}`;
    expect(independentBytes).toBe(snapshot.canonical_bytes);
    expect(independentDigest).toBe(snapshot.snapshot_digest);

    const changed = pages.map((page, index) => index === 1 ? { ...page, task_id: PROJECT_ID } : page);
    expectCodecError(() => validateAndReconstructTaskActivitySnapshot(changed), 'SNAPSHOT_INVALID_PAGE');
    const reordered = [...pages].reverse();
    expectCodecError(() => validateAndReconstructTaskActivitySnapshot(reordered), 'SNAPSHOT_INVALID_PAGE');
    const changedActivity = pages.map((page, index) => index === 0
      ? { ...page, rows: page.rows.map((row, rowIndex) => rowIndex === 0
        ? { ...row, activity: { ...row.activity, action: 'task:deleted' } }
        : row) }
      : page);
    expectCodecError(() => validateAndReconstructTaskActivitySnapshot(changedActivity), 'SNAPSHOT_INVALID_PAGE');
    const changedPosition = pages.map((page, index) => index === 0
      ? { ...page, rows: page.rows.map((row, rowIndex) => rowIndex === 0 ? { ...row, position: 2 } : row) }
      : page);
    expectCodecError(() => validateAndReconstructTaskActivitySnapshot(changedPosition), 'SNAPSHOT_INVALID_PAGE');
  });

  it('checks the first page count before touching any later page body', () => {
    const basePage = createTaskActivitySnapshotPages(buildTaskActivitySnapshot(input([activity('000000000001')], 1)))[0];
    const rows = new Proxy(basePage.rows, {
      get: () => { throw new Error('later page body must not be read'); },
    });
    expect(() => validateAndReconstructTaskActivitySnapshot([{
      ...basePage,
      total: 2,
      total_pages: 2,
      rows,
    }])).toThrow('page count does not match total and page_size');
  });

  it('enforces the 64 MiB aggregate encoded-page budget during sequential validation', () => {
    const payloadText = 'x'.repeat(60 * 1024);
    const basePage = createTaskActivitySnapshotPages(buildTaskActivitySnapshot(input([
      activity('000000000001', '2026-01-02T03:04:05.123456Z', { type: 'string', value: payloadText }),
    ], 1)))[0];
    const pageCount = 1_100;
    const templateActivity = basePage.rows[0].activity;
    const pages = Array.from({ length: pageCount }, (_, index) => ({
      ...basePage,
      total: pageCount,
      page: index + 1,
      total_pages: pageCount,
      has_more: index + 1 < pageCount,
      rows: [{
        position: index + 1,
        activity: {
          ...templateActivity,
          id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, '0')}`,
        },
      }],
    }));
    expectCodecError(() => validateAndReconstructTaskActivitySnapshot(pages), 'SNAPSHOT_LIMIT_EXCEEDED');
  });

  it('represents empty history as one empty page with page one and total_pages one', () => {
    const snapshot = buildTaskActivitySnapshot(input([]));
    const pages = createTaskActivitySnapshotPages(snapshot);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ page: 1, total_pages: 1, has_more: false, total: 0, rows: [] });
    expect(validateAndReconstructTaskActivitySnapshot(pages)).toEqual(snapshot);
  });
});

function independentJcs(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)!;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[${value.map(independentJcs).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${independentJcs(object[key])}`).join(',')}}`;
}
