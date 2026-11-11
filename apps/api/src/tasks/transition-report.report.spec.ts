import {
  WindowValidationError,
  buildTransitionReport,
  resolveTransitionReportWindow,
} from './transition-report.report.js';

describe('transition-report.report (MUN-0076)', () => {
  it('rejects missing/malformed/inverted/oversized windows', () => {
    expect(() => resolveTransitionReportWindow({})).toThrow(WindowValidationError);
    expect(() =>
      resolveTransitionReportWindow({
        startInclusiveUtc: '2026-11-10T00:00:00.000Z',
      }),
    ).toThrow(WindowValidationError);
    expect(() =>
      resolveTransitionReportWindow({
        startInclusiveUtc: 'not-a-date',
        endExclusiveUtc: '2026-11-11T00:00:00.000Z',
      }),
    ).toThrow(WindowValidationError);
    expect(() =>
      resolveTransitionReportWindow({
        startInclusiveUtc: '2026-11-11T00:00:00.000Z',
        endExclusiveUtc: '2026-11-10T00:00:00.000Z',
      }),
    ).toThrow(WindowValidationError);
    expect(() =>
      resolveTransitionReportWindow({
        startInclusiveUtc: '2020-01-01T00:00:00.000Z',
        endExclusiveUtc: '2040-01-01T00:00:00.000Z',
      }),
    ).toThrow(WindowValidationError);
  });

  it('accepts a valid half-open UTC window', () => {
    const window = resolveTransitionReportWindow({
      startInclusiveUtc: '2026-11-10T00:00:00.000Z',
      endExclusiveUtc: '2026-11-11T00:00:00.000Z',
    });
    expect(window.startMs).toBeLessThan(window.endMs);
  });

  it('builds statusCounts, dailyCounts and edgeCounts without free text', () => {
    const window = resolveTransitionReportWindow({
      startInclusiveUtc: '2026-11-10T00:00:00.000Z',
      endExclusiveUtc: '2026-11-12T00:00:00.000Z',
    });
    const report = buildTransitionReport({
      projectId: 'project-1',
      generatedAt: '2026-11-12T00:00:00.000Z',
      auditEventId: 'audit-1',
      cohortStatuses: ['todo', 'in_progress', 'todo'],
      window,
      events: [
        {
          id: 'e1',
          taskId: 't1',
          createdAt: '2026-11-10T12:00:00.000Z',
          createdAtMs: Date.parse('2026-11-10T12:00:00.000Z'),
          from: 'todo',
          to: 'in_progress',
        },
        {
          id: 'e2',
          taskId: 't2',
          createdAt: '2026-11-11T01:00:00.000Z',
          createdAtMs: Date.parse('2026-11-11T01:00:00.000Z'),
          from: 'in_progress',
          to: 'review',
        },
        {
          id: 'e3',
          taskId: 't3',
          createdAt: '2026-11-11T02:00:00.000Z',
          createdAtMs: Date.parse('2026-11-11T02:00:00.000Z'),
          from: 'bogus',
          to: 'review',
        },
      ],
    });

    expect(report.statusCounts.verdict).toBe('MEASURED');
    expect(report.statusCounts.byStatus.todo).toBe(2);
    expect(report.statusCounts.byStatus.in_progress).toBe(1);
    expect(report.transitions.verdict).toBe('MEASURED');
    expect(report.transitions.observedTotal).toBe(3);
    expect(report.transitions.dailyCounts).toEqual([
      { dateUtc: '2026-11-10', count: 1 },
      { dateUtc: '2026-11-11', count: 2 },
    ]);
    expect(report.transitions.edgeCounts).toEqual([
      { from: 'in_progress', to: 'review', count: 1 },
      { from: 'todo', to: 'in_progress', count: 1 },
    ]);
    expect(report.rates.verdict).toBe('NOT_MEASURED');
    expect(report.comparability.verdict).toBe('NOT_MEASURED');
    expect(report.autoPatch).toBe(false);
    expect(JSON.stringify(report)).not.toMatch(/title/i);
  });
});
