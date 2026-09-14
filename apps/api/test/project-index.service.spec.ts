// MUN-0052: unit proofs for `TasksService.indexForProject` that are awkward to
// provoke over HTTP — the audit row is a precondition of the answer, and the
// query itself is pinned to the project and to the index columns.

import { NotFoundException } from '@nestjs/common';
import { TasksService } from '../src/tasks/tasks.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { ActivityService } from '../src/activity/activity.service.js';
import type { KanbanService } from '../src/ws/kanban.service.js';
import type { TaskFieldStateService } from '../src/tasks/field-state/task-field-state.service.js';
import type { TaskExecutionRecorderService } from '../src/execution-authority/task-execution-recorder.service.js';
// Value from @jest/globals, type from @types/jest — see tasks.service.spec.ts.
import { jest as _jestRuntime } from '@jest/globals';
const jest = _jestRuntime as unknown as typeof globalThis.jest;

const GRANT = {
  agentId: 'agent-1',
  agentName: 'aup-orchestrator',
  projectId: 'proj-1',
  until: '2999-01-01T00:00:00Z',
  decision: 'DEC-TEST',
  evidence: 'unit',
};

function makeService() {
  const prisma = {
    project: { findUnique: jest.fn().mockResolvedValue({ workspaceId: 'ws-1' }) },
    task: {
      findMany: jest.fn().mockResolvedValue([
        { id: 't-1', parentId: null, status: 'todo', priority: 'high', actorType: 'human', createdAt: new Date(0), updatedAt: new Date(0), title: 'plain' },
      ]),
    },
    activityLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-1', createdAt: new Date('2026-09-14T00:00:00Z') }),
      count: jest.fn().mockResolvedValue(1),
    },
  };
  const service = new TasksService(
    prisma as unknown as PrismaService,
    {} as ActivityService,
    {} as KanbanService,
    {} as TaskFieldStateService,
    {} as TaskExecutionRecorderService,
  );
  return { prisma, service };
}

describe('TasksService.indexForProject (MUN-0052)', () => {
  it('queries exactly the project, every status, with an explicit select that has no free-text or provenance column', async () => {
    const { prisma, service } = makeService();

    const res = await service.indexForProject('proj-1', 'agent-1', GRANT);

    const args = prisma.task.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ projectId: 'proj-1' });
    expect(Object.keys(args.select).sort()).toEqual(
      ['actorType', 'createdAt', 'id', 'parentId', 'priority', 'status', 'title', 'updatedAt'],
    );
    expect(res.tasks[0]).not.toHaveProperty('title');
    expect(res.tasks[0].titleSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails the read when its audit row cannot be written — no answer without a log entry', async () => {
    const { prisma, service } = makeService();
    prisma.activityLog.create.mockRejectedValue(new Error('db down'));

    await expect(service.indexForProject('proj-1', 'agent-1', GRANT)).rejects.toThrow('db down');
  });

  it('answers 404 for a project that disappeared between the guard and the read', async () => {
    const { prisma, service } = makeService();
    prisma.project.findUnique.mockResolvedValue(null);

    await expect(service.indexForProject('proj-1', 'agent-1', GRANT)).rejects.toThrow(NotFoundException);
    expect(prisma.activityLog.create).not.toHaveBeenCalled();
  });
});
