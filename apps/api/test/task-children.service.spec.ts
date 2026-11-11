// MUN-0070: unit proofs for `TasksService.listChildren` — agent bodyless
// projection vs human full rows, parent gate, and select allowlist.

import { NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TasksService } from '../src/tasks/tasks.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { ActivityService } from '../src/activity/activity.service.js';
import type { KanbanService } from '../src/ws/kanban.service.js';
import type { TaskFieldStateService } from '../src/tasks/field-state/task-field-state.service.js';
import type { TaskExecutionRecorderService } from '../src/execution-authority/task-execution-recorder.service.js';
import { jest as _jestRuntime } from '@jest/globals';
const jest = _jestRuntime as unknown as typeof globalThis.jest;

function makeService() {
  const parent = {
    id: 'parent-1',
    projectId: 'proj-1',
    parentId: null,
    title: 'Parent',
    description: 'secret parent',
    status: 'in_progress',
  };
  const childRow = {
    id: 'child-1',
    parentId: 'parent-1',
    status: 'todo',
    priority: 'high',
    actorType: 'agent',
    createdAt: new Date('2026-11-10T00:00:00Z'),
    updatedAt: new Date('2026-11-10T00:00:00Z'),
    title: 'plain child title',
  };
  const prisma = {
    task: {
      findUnique: jest.fn().mockResolvedValue(parent),
      findFirst: jest.fn().mockResolvedValue(parent),
      findMany: jest.fn().mockResolvedValue([childRow]),
    },
  };
  const service = new TasksService(
    prisma as unknown as PrismaService,
    {} as ActivityService,
    {} as KanbanService,
    {} as TaskFieldStateService,
    {} as TaskExecutionRecorderService,
  );
  return { prisma, service, parent, childRow };
}

describe('TasksService.listChildren (MUN-0070)', () => {
  it('agent path selects bodyless columns and never returns plain title/description', async () => {
    const { prisma, service, childRow } = makeService();

    const res = await service.listChildren('parent-1');

    expect(prisma.task.findUnique).toHaveBeenCalledWith({ where: { id: 'parent-1' } });
    const args = prisma.task.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ parentId: 'parent-1' });
    expect(Object.keys(args.select).sort()).toEqual(
      ['actorType', 'createdAt', 'id', 'parentId', 'priority', 'status', 'title', 'updatedAt'],
    );
    expect(res).toMatchObject({
      parentId: 'parent-1',
      total: 1,
      projection: 'bodyless',
    });
    expect(res.projection).toBe('bodyless');
    const row = res.tasks[0] as { titleSha256?: string; title?: string; description?: string };
    expect(row).not.toHaveProperty('title');
    expect(row).not.toHaveProperty('description');
    expect(row.titleSha256).toBe(
      createHash('sha256').update(childRow.title, 'utf8').digest('hex'),
    );
  });

  it('human path returns full rows narrowed by workspace membership', async () => {
    const { prisma, service, childRow } = makeService();
    prisma.task.findMany.mockResolvedValue([
      { ...childRow, title: 'plain child title', description: 'child body' },
    ]);

    const res = await service.listChildren('parent-1', 'human-1');

    expect(prisma.task.findFirst).toHaveBeenCalled();
    const args = prisma.task.findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      parentId: 'parent-1',
      project: { workspace: { members: { some: { userId: 'human-1' } } } },
    });
    expect(args.select).toBeUndefined();
    expect(res.projection).toBe('full');
    expect(res.tasks[0]).toMatchObject({ id: 'child-1', title: 'plain child title' });
  });

  it('refuses when the parent is not readable (same findOne 404)', async () => {
    const { prisma, service } = makeService();
    prisma.task.findUnique.mockResolvedValue(null);

    await expect(service.listChildren('missing')).rejects.toThrow(NotFoundException);
    expect(prisma.task.findMany).not.toHaveBeenCalled();
  });
});
