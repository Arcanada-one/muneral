/**
 * MUN-0069 — pure transition-sourced digest report + window validation.
 */
import {
  buildDigestTransitionsReport,
  parseTransitionPayload,
  resolveDigestTransitionWindow,
  DigestTransitionWindowError,
  MAX_DIGEST_TRANSITION_WINDOW_DAYS,
  type DigestTransitionEvent,
} from '../src/tasks/workspace-digest-transitions.report.js';

const WINDOW = {
  sinceInclusive: '2026-11-10T00:00:00.000Z',
  beforeExclusive: '2026-11-11T00:00:00.000Z',
};

function event(
  partial: Partial<DigestTransitionEvent> &
    Pick<DigestTransitionEvent, 'id' | 'taskId' | 'to'>,
): DigestTransitionEvent {
  return {
    createdAt: '2026-11-10T12:00:00.000Z',
    from: 'todo',
    projectId: 'proj-1',
    title: 'MUN-0069: sample title',
    status: partial.to,
    ...partial,
  };
}

describe('workspace-digest-transitions.report (MUN-0069)', () => {
  describe('resolveDigestTransitionWindow', () => {
    it('normalizes a valid half-open window', () => {
      expect(
        resolveDigestTransitionWindow({
          sinceInclusive: '2026-11-10T00:00:00Z',
          beforeExclusive: '2026-11-11T00:00:00Z',
        }),
      ).toEqual(WINDOW);
    });

    it('rejects missing, inverted, non-UTC, and oversized windows', () => {
      const bad: Array<Record<string, string>> = [
        {},
        { sinceInclusive: '2026-11-10T00:00:00Z' },
        {
          sinceInclusive: '2026-11-11T00:00:00Z',
          beforeExclusive: '2026-11-10T00:00:00Z',
        },
        {
          sinceInclusive: '2026-11-10T00:00:00+00:00',
          beforeExclusive: '2026-11-11T00:00:00Z',
        },
        {
          sinceInclusive: '2026-01-01T00:00:00Z',
          beforeExclusive: '2026-02-15T00:00:00Z',
        },
      ];
      expect(MAX_DIGEST_TRANSITION_WINDOW_DAYS).toBe(30);
      for (const input of bad) {
        expect(() => resolveDigestTransitionWindow(input)).toThrow(
          DigestTransitionWindowError,
        );
      }
    });
  });

  describe('parseTransitionPayload', () => {
    it('accepts from/to status pairs and rejects comments / same-status / junk', () => {
      expect(parseTransitionPayload({ from: 'todo', to: 'done' })).toEqual({
        from: 'todo',
        to: 'done',
      });
      expect(parseTransitionPayload({ body: 'progress comment' })).toBeNull();
      expect(parseTransitionPayload({ from: 'todo', to: 'todo' })).toBeNull();
      expect(parseTransitionPayload(null)).toBeNull();
      expect(parseTransitionPayload('x')).toBeNull();
    });
  });

  describe('buildDigestTransitionsReport', () => {
    it('counts transitions by destination status and project; excludes comments and age crossings', () => {
      const report = buildDigestTransitionsReport({
        window: WINDOW,
        events: [
          event({
            id: 'e1',
            taskId: 't1',
            to: 'done',
            title: 'MUN-0069: done item',
          }),
          event({
            id: 'e2',
            taskId: 't2',
            to: 'in_progress',
            projectId: 'proj-2',
            title: 'CTRL-0091: started',
          }),
          event({
            id: 'e3',
            taskId: 't3',
            to: 'done',
            title: 'MUN-0069: second done',
          }),
        ],
        limit: 2,
        offset: 0,
        statusRows: [
          { status: 'done' },
          { status: 'done' },
          { status: 'todo' },
        ],
      });

      expect(report.transitions.observedTotal).toBe(3);
      expect(report.transitions.byToStatus.done).toBe(2);
      expect(report.transitions.byToStatus.in_progress).toBe(1);
      expect(report.transitions.byProjectId['proj-1']?.total).toBe(2);
      expect(report.transitions.byProjectId['proj-2']?.total).toBe(1);
      expect(report.commentVolume.included).toBe(false);
      expect(report.ageCrossings.included).toBe(false);
      expect(report.ageCrossings.reason).toMatch(/active-status-staleness/);
      expect(report.statusHistogram.included).toBe(true);
      expect(report.statusHistogram.byStatus).toEqual({ done: 2, todo: 1 });
      expect(report.items).toHaveLength(2);
      expect(report.items[0]?.title).toBe('MUN-0069: done item');
      expect(report.items[1]?.title).toBe('CTRL-0091: started');
      expect(report.total).toBe(3);
      expect(report.limit).toBe(2);
    });

    it('omits status histogram when rows are not supplied', () => {
      const report = buildDigestTransitionsReport({
        window: WINDOW,
        events: [],
      });
      expect(report.statusHistogram.included).toBe(false);
      expect(report.statusHistogram.source).toBe('omitted');
      expect(report.transitions.observedTotal).toBe(0);
    });
  });
});
