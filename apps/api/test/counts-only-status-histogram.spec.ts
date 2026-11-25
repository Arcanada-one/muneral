import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  buildCountsOnlyStatusHistogram,
  readCountsOnlyStatusHistogram,
  serializeCountsOnlyStatusHistogram,
} from '../src/tasks/counts-only-status-histogram.js';

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

const COHORT = { workspaceId: 'workspace-1' };
const SCOPE = {
  scopeVersion: 'fixture-scope-1',
  allowedScopeVersions: new Set(['fixture-scope-1']),
};
const CAPTURE = {
  ...SCOPE,
  captureStart: new Date('2026-11-25T19:00:00.000Z'),
  captureEnd: new Date('2026-11-25T19:00:01.250Z'),
};
const FIXTURE_SHA256 = '4fa134fcf664be1861d7a64bb651854796a4de9bb35caaf2ccb33d46c4b26213';

describe('counts-only status histogram', () => {
  it('returns one count for each public status', () => {
    const rows = [
      { status: 'todo' },
      { status: 'in_progress' },
      { status: 'review' },
      { status: 'blocked' },
      { status: 'done' },
      { status: 'cancelled' },
      { status: 'archived' },
    ];
    expect(buildCountsOnlyStatusHistogram(rows, 7)).toEqual({
      byStatus: {
        todo: 1,
        in_progress: 1,
        review: 1,
        blocked: 1,
        done: 1,
        cancelled: 1,
        archived: 1,
        unknown: 0,
        invalid: 0,
      },
      total: 7,
    });
  });

  it('returns all fixed buckets for an empty cohort', () => {
    expect(buildCountsOnlyStatusHistogram([], 0)).toEqual({
      byStatus: EMPTY_COUNTS,
      total: 0,
    });
  });

  it('classifies non-strings as unknown and unrecognized strings as invalid', () => {
    const result = buildCountsOnlyStatusHistogram(
      [{ status: 'future_status' }, { status: 'unknown' }, { status: null }],
      3,
    );
    expect(result.byStatus).toEqual({ ...EMPTY_COUNTS, unknown: 1, invalid: 2 });
  });

  it('does not treat prototype property names as histogram keys', () => {
    const rows = ['constructor', 'toString', '__proto__'].map((status) => ({ status }));
    const { byStatus } = buildCountsOnlyStatusHistogram(rows, 3);
    expect(Object.getPrototypeOf(byStatus)).toBeNull();
    expect(byStatus).toEqual({ ...EMPTY_COUNTS, invalid: 3 });
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, -1, 0.5, Number.NaN])(
    'refuses an unsafe cohort count of %s',
    (count) => {
      expect(() => buildCountsOnlyStatusHistogram([], count)).toThrow(
        'Cohort count must be a nonnegative safe integer.',
      );
    },
  );

  it('refuses a histogram that does not reconcile with the cohort', () => {
    expect(() => buildCountsOnlyStatusHistogram([{ status: 'done' }], 2)).toThrow(
      'Status counts do not reconcile with the cohort count.',
    );
  });

  it.each([undefined, 'project-1'])(
    'reads only status within the requested cohort (%s)',
    async (projectId) => {
      const findMany = jest.fn(async () => [{ status: 'done' }]);
      const result = await readCountsOnlyStatusHistogram(
        { task: { findMany } },
        { ...COHORT, projectId },
        SCOPE,
      );

      expect(findMany).toHaveBeenCalledTimes(1);
      expect(findMany).toHaveBeenCalledWith({
        where: projectId
          ? { project: { workspaceId: 'workspace-1' }, projectId }
          : { project: { workspaceId: 'workspace-1' } },
        select: { status: true },
      });
      expect(JSON.parse(result)).toMatchObject({ total: '1', by_status: { done: '1' } });
    },
  );

  it('produces the pinned UTF-8 fixture with capture instants bracketing the read', async () => {
    const rows = [
      'todo', 'todo', 'todo', 'in_progress', 'in_progress', 'review',
      'done', 'done', 'done', 'done', 'cancelled', null,
    ].map((status) => ({ status }));
    const calls: string[] = [];
    const findMany = jest.fn(async () => {
      calls.push('query');
      return rows;
    });
    const now = jest.fn(() => CAPTURE.captureStart)
      .mockImplementationOnce(() => {
        calls.push('before');
        return CAPTURE.captureStart;
      })
      .mockImplementationOnce(() => {
        calls.push('after');
        return CAPTURE.captureEnd;
      });
    const result = await readCountsOnlyStatusHistogram({ task: { findMany } }, COHORT, SCOPE, now);
    const bytes = Buffer.from(result, 'utf8');
    const fixture = readFileSync(new URL('./fixtures/d182-counts-fixture-1.json', import.meta.url));

    expect(calls).toEqual(['before', 'query', 'after']);
    expect(bytes).toEqual(fixture);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(FIXTURE_SHA256);
  });

  it('serializes all nine zero buckets for an empty cohort', () => {
    const result = serializeCountsOnlyStatusHistogram(buildCountsOnlyStatusHistogram([], 0), CAPTURE);
    expect(JSON.parse(result)).toMatchObject({
      total: '0',
      by_status: Object.fromEntries(Object.keys(EMPTY_COUNTS).map((key) => [key, '0'])),
    });
  });

  it('serializes the largest safe count as a decimal string', () => {
    const total = Number.MAX_SAFE_INTEGER;
    const result = serializeCountsOnlyStatusHistogram(
      { byStatus: { ...EMPTY_COUNTS, done: total }, total },
      CAPTURE,
    );
    expect(JSON.parse(result)).toMatchObject({
      total: '9007199254740991',
      by_status: { done: '9007199254740991' },
    });
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, -1, 0.5, Number.NaN])(
    'refuses an unsafe bucket count of %s before serialization',
    (done) => {
      expect(() => serializeCountsOnlyStatusHistogram(
        { byStatus: { ...EMPTY_COUNTS, done }, total: 0 },
        CAPTURE,
      )).toThrow('Status count must be a nonnegative safe integer.');
    },
  );

  it('refuses a forced bucket mismatch before serialization', () => {
    expect(() => serializeCountsOnlyStatusHistogram(
      { byStatus: { ...EMPTY_COUNTS, todo: 1 }, total: 2 },
      CAPTURE,
    )).toThrow('Status counts do not reconcile with the cohort count.');
  });

  it('refuses a scope outside the allowlist before reading the cohort', async () => {
    const findMany = jest.fn(async () => []);
    await expect(readCountsOnlyStatusHistogram(
      { task: { findMany } },
      COHORT,
      { ...SCOPE, scopeVersion: 'unreviewed-scope' },
    )).rejects.toThrow('Scope version is not allowlisted.');
    expect(findMany).not.toHaveBeenCalled();
  });

  it.each(['00000000-0000-4000-8000-000000000000', 'workspace-1', 'project-1'])(
    'refuses an identifier as scope version before reading the cohort',
    async (scopeVersion) => {
      const findMany = jest.fn(async () => []);
      await expect(readCountsOnlyStatusHistogram(
        { task: { findMany } },
        { ...COHORT, projectId: 'project-1' },
        { scopeVersion, allowedScopeVersions: new Set([scopeVersion]) },
      )).rejects.toThrow('Scope version must be a public label.');
      expect(findMany).not.toHaveBeenCalled();
    },
  );

  it('refuses a clock that moves backward over the read', async () => {
    const findMany = jest.fn(async () => []);
    const now = jest.fn(() => CAPTURE.captureStart).mockReturnValueOnce(CAPTURE.captureEnd);
    await expect(readCountsOnlyStatusHistogram(
      { task: { findMany } }, COHORT, SCOPE, now,
    )).rejects.toThrow('Capture end must not precede capture start.');
  });

  it.each([
    { status: 'todo', title: 'synthetic title' },
    { status: 'todo', description: 'synthetic body' },
    { status: 'todo', id: 'synthetic id' },
    Object.defineProperty({ status: 'todo' }, 'hidden', { value: 'synthetic field' }),
    Object.assign(Object.create({ title: 'inherited synthetic title' }), { status: 'todo' }),
  ])('refuses any unexpected field carried by the query result', async (row) => {
    const findMany = jest.fn(async () => [row]);
    await expect(readCountsOnlyStatusHistogram(
      { task: { findMany } }, COHORT, SCOPE,
    )).rejects.toThrow('Cohort query rows must contain only the status field.');
  });
});
