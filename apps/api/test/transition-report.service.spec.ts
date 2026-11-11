import { jest } from '@jest/globals';
import { TasksService } from '../src/tasks/tasks.service.js';
import { resolveTransitionReportWindow } from '../src/tasks/transition-report.report.js';

describe('TasksService.transitionReportForProject (MUN-0076)', () => {
  it('builds a measured report from seeded status_changed rows with from/to', async () => {
    const prisma = {
      project: {
        findUnique: jest.fn(async () => ({ workspaceId: 'ws-1' })),
      },
      task: {
        findMany: jest.fn(async () => [
          { id: 't1', status: 'todo' },
          { id: 't2', status: 'in_progress' },
        ]),
      },
      activityLog: {
        findMany: jest.fn(async () => [
          {
            id: 'e1',
            taskId: 't1',
            createdAt: new Date('2026-11-10T12:00:00.000Z'),
            payload: { from: 'todo', to: 'in_progress' },
          },
          {
            id: 'e2',
            taskId: 't2',
            createdAt: new Date('2026-11-11T01:00:00.000Z'),
            payload: { from: 'in_progress', to: 'review' },
          },
        ]),
        create: jest.fn(async () => ({
          id: 'audit-1',
          createdAt: new Date('2026-11-12T00:00:00.000Z'),
        })),
        count: jest.fn(async () => 1),
      },
    };

    const service = new TasksService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const window = resolveTransitionReportWindow({
      startInclusiveUtc: '2026-11-10T00:00:00.000Z',
      endExclusiveUtc: '2026-11-12T00:00:00.000Z',
    });

    const report = await service.transitionReportForProject(
      'project-1',
      'agent-1',
      {
        agentId: 'agent-1',
        agentName: 'test-agent',
        projectId: 'project-1',
        decision: 'test',
        until: '2999-01-01T00:00:00Z',
        evidence: 'unit',
        standing: true,
      },
      window,
    );

    expect(prisma.activityLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          action: 'task:status_changed',
          taskId: { in: ['t1', 't2'] },
        }),
        select: expect.objectContaining({
          payload: true,
        }),
      }),
    );
    expect(report.statusCounts.verdict).toBe('MEASURED');
    expect(report.statusCounts.byStatus.todo).toBe(1);
    expect(report.statusCounts.byStatus.in_progress).toBe(1);
    expect(report.transitions.verdict).toBe('MEASURED');
    expect(report.transitions.observedTotal).toBe(2);
    expect(report.transitions.edgeCounts).toEqual([
      { from: 'in_progress', to: 'review', count: 1 },
      { from: 'todo', to: 'in_progress', count: 1 },
    ]);
    expect(report.auditEventId).toBe('audit-1');
    expect(report.autoPatch).toBe(false);
    expect(report.rates.verdict).toBe('NOT_MEASURED');
  });
});
