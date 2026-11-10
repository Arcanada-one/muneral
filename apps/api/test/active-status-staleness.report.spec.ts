// MUN-0067: pure active-status staleness report + threshold validation.
import {
  buildActiveStatusStalenessReport,
  parsePositiveFiniteDays,
  resolveActiveStatusThresholds,
  ThresholdValidationError,
  DEFAULT_SOFT_DAYS,
  DEFAULT_HARD_DAYS,
  type BodylessIndexTask,
  type ProjectIndexEnvelope,
} from '../src/tasks/active-status-staleness.report.js';

const GENERATED = '2026-11-07T23:29:12.304Z';
const DAY_MS = 24 * 3_600_000;

function task(
  partial: Partial<BodylessIndexTask> & Pick<BodylessIndexTask, 'id' | 'status' | 'updatedAt'>,
): BodylessIndexTask {
  return {
    parentId: null,
    priority: 'high',
    actorType: 'agent',
    createdAt: '2026-10-01T00:00:00.000Z',
    titleSha256: 'abc',
    ...partial,
  };
}

function index(tasks: BodylessIndexTask[]): ProjectIndexEnvelope {
  return { projectId: 'proj-1', generatedAt: GENERATED, tasks };
}

describe('active-status-staleness.report (MUN-0067)', () => {
  describe('parsePositiveFiniteDays / resolveActiveStatusThresholds', () => {
    it('defaults softDays=3 and hardDays=14 when omitted', () => {
      expect(resolveActiveStatusThresholds({})).toEqual({
        softDays: DEFAULT_SOFT_DAYS,
        hardDays: DEFAULT_HARD_DAYS,
      });
    });

    it('accepts valid fractional day values', () => {
      expect(resolveActiveStatusThresholds({ softDays: '0.5', hardDays: '1.5' })).toEqual({
        softDays: 0.5,
        hardDays: 1.5,
      });
    });

    it('rejects malformed, blank, non-positive, repeated, structured, and overflowing values', () => {
      const bad = [
        { softDays: 'abc' },
        { softDays: 'NaN' },
        { softDays: 'Infinity' },
        { softDays: '' },
        { softDays: '  ' },
        { softDays: '0' },
        { softDays: '-1' },
        { softDays: '1', 'softDays[0]': '2' },
        { 'softDays[value]': '1' },
        { softDays: '1e302' },
        { softDays: '1e309' },
        { hardDays: 'abc' },
        { hardDays: '0' },
        { hardDays: '-2' },
        { softDays: '14', hardDays: '3' },
        { softDays: '3', hardDays: '3' },
      ];
      for (const query of bad) {
        expect(() => resolveActiveStatusThresholds(query)).toThrow(ThresholdValidationError);
      }
    });

    it('rejects array-shaped softDays before evaluation', () => {
      expect(() => parsePositiveFiniteDays({ softDays: ['1', '2'] } as never, 'softDays')).toThrow(
        ThresholdValidationError,
      );
    });
  });

  describe('buildActiveStatusStalenessReport', () => {
    it('buckets active statuses by generatedAt vs updatedAt and ignores non-active', () => {
      const generatedMs = Date.parse(GENERATED);
      const report = buildActiveStatusStalenessReport(
        index([
          task({
            id: 'fresh-ip',
            status: 'in_progress',
            updatedAt: new Date(generatedMs - 2 * DAY_MS).toISOString(),
          }),
          task({
            id: 'soft-ip',
            status: 'in_progress',
            updatedAt: new Date(generatedMs - 4 * DAY_MS).toISOString(),
          }),
          task({
            id: 'hard-ip',
            status: 'in_progress',
            updatedAt: new Date(generatedMs - 15 * DAY_MS).toISOString(),
          }),
          task({
            id: 'hard-blocked',
            status: 'blocked',
            updatedAt: new Date(generatedMs - 20 * DAY_MS).toISOString(),
          }),
          task({
            id: 'todo-ignored',
            status: 'todo',
            updatedAt: new Date(generatedMs - 40 * DAY_MS).toISOString(),
          }),
          task({
            id: 'done-ignored',
            status: 'done',
            updatedAt: new Date(generatedMs - 40 * DAY_MS).toISOString(),
          }),
        ]),
      );

      expect(report.autoPatch).toBe(false);
      expect(report.byStatus.in_progress).toMatchObject({
        n: 3,
        fresh: 1,
        gtSoft: 2,
        gtHard: 1,
      });
      expect(report.byStatus.in_progress.stale.map((t) => t.id)).toEqual(['hard-ip', 'soft-ip']);
      expect(report.byStatus.blocked).toMatchObject({ n: 1, fresh: 0, gtSoft: 1, gtHard: 1 });
      expect(report.byStatus.review).toMatchObject({ n: 0, fresh: 0, gtSoft: 0, gtHard: 0 });
      expect(JSON.stringify(report)).not.toMatch(/todo-ignored|Secret title|description/i);
    });

    it('treats exact soft/hard boundaries as fresh / gtSoft (strict greater-than)', () => {
      const generatedMs = Date.parse(GENERATED);
      const report = buildActiveStatusStalenessReport(
        index([
          task({
            id: 'exact-soft',
            status: 'review',
            updatedAt: new Date(generatedMs - 3 * DAY_MS).toISOString(),
          }),
          task({
            id: 'exact-hard',
            status: 'review',
            updatedAt: new Date(generatedMs - 14 * DAY_MS).toISOString(),
          }),
        ]),
      );
      expect(report.byStatus.review).toMatchObject({ n: 2, fresh: 1, gtSoft: 1, gtHard: 0 });
      expect(report.byStatus.review.stale[0]?.id).toBe('exact-hard');
      expect(report.byStatus.review.stale[0]?.bucket).toBe('gtSoft');
    });

    it('emits only bodyless fields on stale rows', () => {
      const generatedMs = Date.parse(GENERATED);
      const report = buildActiveStatusStalenessReport(
        index([
          task({
            id: 'stale-1',
            status: 'in_progress',
            parentId: 'parent-1',
            priority: 'critical',
            actorType: 'human',
            titleSha256: 'deadbeef',
            updatedAt: new Date(generatedMs - 10 * DAY_MS).toISOString(),
          }),
        ]),
      );
      expect(Object.keys(report.byStatus.in_progress.stale[0]!).sort()).toEqual(
        [
          'actorType',
          'ageMs',
          'bucket',
          'createdAt',
          'id',
          'parentId',
          'priority',
          'status',
          'titleSha256',
          'updatedAt',
        ].sort(),
      );
    });

    it('rejects inverted thresholds without inventing buckets', () => {
      expect(() =>
        buildActiveStatusStalenessReport(index([]), { softDays: 14, hardDays: 3 }),
      ).toThrow(ThresholdValidationError);
    });
  });
});
