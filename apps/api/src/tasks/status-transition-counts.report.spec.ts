import {
  MAX_WINDOW_DAYS,
  WindowValidationError,
  buildStatusTransitionCountsReport,
  resolveStatusTransitionWindow,
} from './status-transition-counts.report.js';

describe('status-transition-counts.report (MUN-0075)', () => {
  it('rejects missing, malformed, inverted, and oversized windows', () => {
    expect(() => resolveStatusTransitionWindow({})).toThrow(WindowValidationError);
    expect(() =>
      resolveStatusTransitionWindow({
        startInclusiveUtc: 'not-a-date',
        endExclusiveUtc: '2026-11-11T00:00:00.000Z',
      }),
    ).toThrow(WindowValidationError);
    expect(() =>
      resolveStatusTransitionWindow({
        startInclusiveUtc: '2026-11-11T00:00:00.000Z',
        endExclusiveUtc: '2026-11-11T00:00:00.000Z',
      }),
    ).toThrow(WindowValidationError);
    expect(() =>
      resolveStatusTransitionWindow({
        startInclusiveUtc: '2020-01-01T00:00:00.000Z',
        endExclusiveUtc: '2035-01-01T00:00:00.000Z',
      }),
    ).toThrow(new WindowValidationError(
      `The half-open UTC window must be at most ${MAX_WINDOW_DAYS} days.`,
    ));
    expect(() =>
      resolveStatusTransitionWindow({
        startInclusiveUtc: ['2026-11-10T00:00:00.000Z', '2026-11-11T00:00:00.000Z'],
        endExclusiveUtc: '2026-11-12T00:00:00.000Z',
      }),
    ).toThrow(WindowValidationError);
  });

  it('accepts a valid half-open window', () => {
    const window = resolveStatusTransitionWindow({
      startInclusiveUtc: '2026-11-10T00:00:00.000Z',
      endExclusiveUtc: '2026-11-12T00:00:00.000Z',
    });
    expect(window.startMs).toBe(Date.parse('2026-11-10T00:00:00.000Z'));
    expect(window.endMs).toBe(Date.parse('2026-11-12T00:00:00.000Z'));
  });

  it('counts in-window transitions by UTC day and keeps rates NOT_MEASURED', () => {
    const window = resolveStatusTransitionWindow({
      startInclusiveUtc: '2026-11-10T00:00:00.000Z',
      endExclusiveUtc: '2026-11-12T00:00:00.000Z',
    });
    const report = buildStatusTransitionCountsReport({
      projectId: 'project-1',
      generatedAt: '2026-11-12T01:00:00.000Z',
      auditEventId: 'audit-1',
      cohortTaskCount: 2,
      window,
      events: [
        {
          id: 'e1',
          taskId: 't1',
          createdAt: '2026-11-10T12:00:00.000Z',
          createdAtMs: Date.parse('2026-11-10T12:00:00.000Z'),
        },
        {
          id: 'e2',
          taskId: 't2',
          createdAt: '2026-11-10T18:00:00.000Z',
          createdAtMs: Date.parse('2026-11-10T18:00:00.000Z'),
        },
        {
          id: 'e3',
          taskId: 't1',
          createdAt: '2026-11-11T09:00:00.000Z',
          createdAtMs: Date.parse('2026-11-11T09:00:00.000Z'),
        },
        {
          id: 'e-out',
          taskId: 't1',
          createdAt: '2026-11-12T00:00:00.000Z',
          createdAtMs: Date.parse('2026-11-12T00:00:00.000Z'),
        },
      ],
    });

    expect(report.transitions.verdict).toBe('MEASURED');
    expect(report.transitions.observedTotal).toBe(3);
    expect(report.transitions.dailyCounts).toEqual([
      { dateUtc: '2026-11-10', count: 2 },
      { dateUtc: '2026-11-11', count: 1 },
    ]);
    expect(report.inputCompleteness.state).toBe('DB_COHORT_COMPLETE');
    expect(report.rates.verdict).toBe('NOT_MEASURED');
    expect(report.comparability.verdict).toBe('NOT_MEASURED');
    expect(report.autoPatch).toBe(false);
  });
});
