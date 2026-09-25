/**
 * A2-284 — the two proofs that are awkward to provoke over HTTP.
 *
 * 1. The JWT branch of `GET /tasks/digest`. `AgentTaskScopeGuard` lets a JWT
 *    request straight through — bounding human authorisation is not its job —
 *    so a JWT reaches the handler with no `agentScope` and the HANDLER is what
 *    refuses it. The e2e suite authenticates with keys and never exercises it,
 *    and it is the branch a later edit is most likely to drop.
 * 2. The shape of the query itself: the workspace predicate is not a filter the
 *    caller can influence, the select is the seven columns and nothing else,
 *    and the audit row is a PRECONDITION of the answer — a read whose row
 *    cannot be written must fail rather than answer unlogged.
 */
import { ForbiddenException } from '@nestjs/common';
import { TasksController } from '../src/tasks/tasks.controller.js';
import { TasksService } from '../src/tasks/tasks.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { ActivityService } from '../src/activity/activity.service.js';
import type { KanbanService } from '../src/ws/kanban.service.js';
import type { TaskFieldStateService } from '../src/tasks/field-state/task-field-state.service.js';
import type { TaskExecutionRecorderService } from '../src/execution-authority/task-execution-recorder.service.js';
import type { WorkspaceDigestGrantEntry } from '../src/auth/workspace-digest-grants.js';
// vitest exposes describe/it/expect as globals (vitest.config.ts `globals: true`);
// `vi` is the one name that must be imported, exactly as `jest` had to be.
import { vi } from 'vitest';

const GRANT: WorkspaceDigestGrantEntry = {
  agentId: 'agent-1',
  agentName: 'assistant',
  workspaceId: 'ws-1',
  until: '2999-01-01T00:00:00Z',
  decision: 'DEC-TEST',
  evidence: 'unit',
};

describe('TasksController.digest (A2-284)', () => {
  const digestForWorkspace = vi.fn().mockResolvedValue({ items: [], total: 0 });
  const tasks = { digestForWorkspace } as unknown as TasksService;
  const stub = {} as never;
  const controller = new TasksController(tasks, stub, stub, stub, stub);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = (agentScope: unknown) => controller.digest({ agentScope } as any, {});

  beforeEach(() => digestForWorkspace.mockClear());

  it('refuses a request with no agent scope — which is every JWT request', () => {
    expect(() => call(undefined)).toThrow(ForbiddenException);
    expect(digestForWorkspace).not.toHaveBeenCalled();
  });

  it('refuses a scope of another kind, and one missing its grant or its workspace', () => {
    expect(() => call({ agentId: 'a', kind: 'task' })).toThrow(ForbiddenException);
    expect(() => call({ agentId: 'a', kind: 'workspace-digest', workspaceId: 'ws-1' })).toThrow(
      ForbiddenException,
    );
    expect(() => call({ agentId: 'a', kind: 'workspace-digest', workspaceDigestGrant: GRANT })).toThrow(
      ForbiddenException,
    );
    // The kind is checked on its own, not implied by the two fields: a scope
    // of another kind carrying both would otherwise walk straight through.
    expect(() =>
      call({ agentId: 'a', kind: 'task', workspaceDigestGrant: GRANT, workspaceId: 'ws-1' }),
    ).toThrow(ForbiddenException);
    expect(digestForWorkspace).not.toHaveBeenCalled();
  });

  it('passes the workspace the GUARD resolved, never one from the request', async () => {
    await call({
      agentId: 'agent-1',
      kind: 'workspace-digest',
      workspaceDigestGrant: GRANT,
      workspaceId: 'ws-1',
    });
    expect(digestForWorkspace).toHaveBeenCalledWith('ws-1', 'agent-1', GRANT, {});
  });
});

function makeService() {
  const row = {
    id: 't-1',
    projectId: 'p-1',
    title: 'plain',
    status: 'done',
    priority: 'high',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const prisma = {
    $transaction: vi.fn().mockResolvedValue([[row], 1]),
    task: { findMany: vi.fn(), count: vi.fn() },
    activityLog: {
      create: vi.fn().mockResolvedValue({ id: 'audit-1', createdAt: new Date('2026-09-24T00:00:00Z') }),
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

describe('TasksService.digestForWorkspace (A2-284)', () => {
  it('pins the workspace and the seven columns in the query it issues', async () => {
    const { prisma, service } = makeService();
    await service.digestForWorkspace('ws-1', 'agent-1', GRANT, { status: 'done', limit: 10 });

    expect(prisma.task.findMany).toHaveBeenCalledTimes(1);
    const args = prisma.task.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      select: Record<string, true>;
      take: number;
    };
    expect(args.where.project).toEqual({ workspaceId: 'ws-1' });
    expect(args.where.status).toBe('done');
    expect(args.take).toBe(10);
    expect(Object.keys(args.select).sort()).toEqual([
      'createdAt',
      'id',
      'priority',
      'projectId',
      'status',
      'title',
      'updatedAt',
    ]);
    // The count runs against the SAME predicate: a `total` computed over a
    // wider where clause would be a number about somebody else's board.
    const countArgs = prisma.task.count.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(countArgs.where).toEqual(args.where);
  });

  it('cannot be asked for another workspace through the dto: the filters only narrow', async () => {
    const { prisma, service } = makeService();
    await service.digestForWorkspace('ws-1', 'agent-1', GRANT, {
      // A caller naming a project it does not own still gets the workspace
      // predicate ANDed in — the answer is empty, not somebody else's.
      projectId: 'p-elsewhere',
    });
    const args = prisma.task.findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(args.where).toEqual({ project: { workspaceId: 'ws-1' }, projectId: 'p-elsewhere' });
  });

  it('fails the read when its audit row cannot be written', async () => {
    const { prisma, service } = makeService();
    prisma.activityLog.create.mockRejectedValueOnce(new Error('log is down'));
    await expect(service.digestForWorkspace('ws-1', 'agent-1', GRANT, {})).rejects.toThrow('log is down');
  });
});
