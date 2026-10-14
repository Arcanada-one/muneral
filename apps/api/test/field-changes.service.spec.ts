import { jest as jestRuntime } from '@jest/globals';
import { ACTIVITY_SENTINEL } from '../src/tasks/field-state/task-field-state.service.js';
import { FieldChangesService } from '../src/tasks/field-state/field-changes.service.js';
import { TASK_GRANTED_READ_ACTION } from '../src/activity/activity-actions.js';

const jest = jestRuntime as unknown as typeof globalThis.jest;

describe('FieldChangesService', () => {
  it('does not expose audit-only granted reads as poller activity changes', async () => {
    const prisma = {
      task: { findUnique: jest.fn().mockResolvedValue({ id: 'task-1' }) },
      taskFieldState: { findMany: jest.fn().mockResolvedValue([]) },
      agentFieldRead: { findMany: jest.fn().mockResolvedValue([
        { fieldName: ACTIVITY_SENTINEL, lastSeenVersion: 0n, lastSeenHash: 'activity-before' },
      ]) },
      activityLog: { findFirst: jest.fn().mockResolvedValue({ id: 'activity-before' }) },
    };
    const service = new FieldChangesService(prisma as never);

    const result = await service.getFieldChanges({ taskId: 'task-1', agentId: 'agent-1' });

    expect(prisma.activityLog.findFirst).toHaveBeenCalledWith({
      where: { taskId: 'task-1', action: { not: TASK_GRANTED_READ_ACTION } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    expect(result.activity).toEqual({
      field: ACTIVITY_SENTINEL,
      changed: false,
      latestActivityId: 'activity-before',
      lastSeenActivityId: 'activity-before',
    });
  });
});
