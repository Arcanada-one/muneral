import { jest } from '@jest/globals';
import {
  buildCountsOnlyStatusHistogram,
  readCountsOnlyStatusHistogram,
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

  it('counts unrecognized strings and malformed values separately', () => {
    const result = buildCountsOnlyStatusHistogram(
      [{ status: 'future_status' }, { status: 'invalid' }, { status: null }],
      3,
    );
    expect(result.byStatus).toEqual({ ...EMPTY_COUNTS, unknown: 2, invalid: 1 });
  });

  it('does not treat prototype property names as histogram keys', () => {
    const rows = ['constructor', 'toString', '__proto__'].map((status) => ({ status }));
    const { byStatus } = buildCountsOnlyStatusHistogram(rows, 3);
    expect(Object.getPrototypeOf(byStatus)).toBeNull();
    expect(byStatus).toEqual({ ...EMPTY_COUNTS, unknown: 3 });
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

  it.each([undefined, 'project-1'])('reads only status within the requested cohort (%s)', async (projectId) => {
    const findMany = jest.fn(async () => [{ status: 'done' }]);
    const result = await readCountsOnlyStatusHistogram(
      { task: { findMany } },
      'workspace-1',
      projectId,
    );

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: projectId
        ? { project: { workspaceId: 'workspace-1' }, projectId }
        : { project: { workspaceId: 'workspace-1' } },
      select: { status: true },
    });
    expect(result).toEqual({ byStatus: { ...EMPTY_COUNTS, done: 1 }, total: 1 });
  });
});
