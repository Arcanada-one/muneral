import { ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Agent } from '@prisma/client';
import { AGENT_SCOPE_KEY } from '../src/auth/agent-scope.decorator.js';
import { AgentTaskScopeGuard } from '../src/auth/guards/agent-task-scope.guard.js';
import type { AgentScopedRequest } from '../src/auth/guards/agent-task-scope.guard.js';
import { PROJECT_INDEX_READ_ACTION, TasksService } from '../src/tasks/tasks.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { ActivityService } from '../src/activity/activity.service.js';
import type { KanbanService } from '../src/ws/kanban.service.js';
import type { TaskFieldStateService } from '../src/tasks/field-state/task-field-state.service.js';
import type { TaskExecutionRecorderService } from '../src/execution-authority/task-execution-recorder.service.js';
import { TasksController } from '../src/tasks/tasks.controller.js';
import { jest as _jestRuntime } from '@jest/globals';
const jest = _jestRuntime as unknown as typeof globalThis.jest;

const AGENT = { id: 'agent-1', workspaceId: 'ws-1', name: 'reader' } as unknown as Agent;
const GRANT = {
  agentId: 'agent-1', agentName: 'reader', projectId: 'project-1',
  until: '2999-01-01T00:00:00Z', decision: 'DEC-TEST', evidence: 'unit',
};

function guardFor(grants: typeof GRANT[]) {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue('task-read') };
  const prisma = {
    task: { findFirst: jest.fn() },
    taskAgent: { findFirst: jest.fn() },
    project: { findFirst: jest.fn() },
    agent: { findFirst: jest.fn() },
  };
  const guard = new AgentTaskScopeGuard(
    reflector as unknown as Reflector,
    prisma as unknown as PrismaService,
    grants,
  );
  const req = { params: { taskId: 'task-1' }, apiKeyAgent: AGENT } as unknown as AgentScopedRequest;
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
  return { guard, prisma, req, context, reflector };
}

describe('project-granted GET /tasks/:taskId metadata read', () => {
  it('uses a live grant only for an unassigned task in the exact granted project and workspace', async () => {
    const { guard, prisma, req, context } = guardFor([GRANT]);
    prisma.task.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'task-1', projectId: 'project-1' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(prisma.task.findFirst).toHaveBeenNthCalledWith(1, {
      where: { id: 'task-1', project: { workspaceId: 'ws-1' }, OR: [
        { agents: { some: { agentId: 'agent-1' } } },
        { createdById: 'agent-1', actorType: 'agent' },
      ] },
      select: { id: true },
    });
    expect(prisma.task.findFirst).toHaveBeenNthCalledWith(2, {
      where: { id: 'task-1', project: { workspaceId: 'ws-1' } },
      select: { id: true, projectId: true },
    });
    expect(req.agentScope).toEqual({
      agentId: 'agent-1', kind: 'task-read', projectTaskReadOnly: true,
      projectId: 'project-1', workspaceId: 'ws-1', projectReadGrant: GRANT,
    });
  });

  it('keeps the existing full task path for an assigned or agent-created task', async () => {
    const { guard, prisma, req, context } = guardFor([]);
    prisma.task.findFirst.mockResolvedValueOnce({ id: 'task-1' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.agentScope).toEqual({ agentId: 'agent-1', kind: 'task-read', workspaceId: 'ws-1' });
    expect(prisma.task.findFirst).toHaveBeenCalledTimes(1);
  });

  it('denies missing grants and grants for another agent or project', async () => {
    for (const grants of [[], [{ ...GRANT, agentId: 'agent-2' }], [{ ...GRANT, projectId: 'project-2' }]]) {
      const { guard, prisma, req, context } = guardFor(grants);
      prisma.task.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'task-1', projectId: 'project-1' });
      await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
      expect(req.agentScope).toBeUndefined();
    }
  });

  it('denies expired grants and tasks outside the credential workspace', async () => {
    const expired = { ...GRANT, until: '2000-01-01T00:00:00Z' };
    const expiredCase = guardFor([expired]);
    expiredCase.prisma.task.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'task-1', projectId: 'project-1' });
    const error = await expiredCase.guard.canActivate(expiredCase.context).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({ code: 'GRANT_EXPIRED', projectId: 'project-1' });

    const foreignCase = guardFor([GRANT]);
    foreignCase.prisma.task.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(foreignCase.guard.canActivate(foreignCase.context)).rejects.toThrow(ForbiddenException);
    expect(foreignCase.req.agentScope).toBeUndefined();
  });

  it('leaves task history and writes under the original assignment-only scope', async () => {
    const { guard, prisma, context, reflector } = guardFor([GRANT]);
    reflector.getAllAndOverride.mockReturnValue('task');
    prisma.task.findFirst.mockResolvedValue(null);
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    expect(prisma.task.findFirst).toHaveBeenCalledTimes(1);
  });

  it('keeps the task GET decorated with the read-only composite scope', () => {
    expect(Reflect.getMetadata(AGENT_SCOPE_KEY, TasksController.prototype.findOne)).toBe('task-read');
  });

  it('keeps human JWT requests outside agent grant scoping', async () => {
    const { guard, reflector, context, req, prisma } = guardFor([]);
    delete req.apiKeyAgent;
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(reflector.getAllAndOverride).not.toHaveBeenCalled();
    expect(prisma.task.findFirst).not.toHaveBeenCalled();
  });

  it('returns only metadata on the granted branch and preserves the full human task branch', async () => {
    const task = { id: 'task-1', projectId: 'project-1', title: 'title', description: 'description', status: 'todo' };
    const tasksService = {
      findOne: jest.fn().mockResolvedValue(task),
      findOneForProjectReadGrant: jest.fn().mockResolvedValue({ ...task, auditEventId: 'audit-1' }),
    };
    const fieldChanges = { computeTaskEtag: jest.fn().mockResolvedValue(undefined) };
    const controller = new TasksController(
      tasksService as unknown as TasksService,
      fieldChanges as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const response = { setHeader: jest.fn(), status: jest.fn() };
    const grantRequest = {
      actor: { type: 'agent', id: 'agent-1' },
      agentScope: {
        kind: 'task-read', agentId: 'agent-1', projectTaskReadOnly: true as const,
        projectId: 'project-1', workspaceId: 'ws-1', projectReadGrant: GRANT,
      },
    } as unknown as Parameters<TasksController['findOne']>[1];

    await expect(controller.findOne('task-1', grantRequest, undefined, response as never)).resolves.toEqual({ ...task, auditEventId: 'audit-1' });
    expect(tasksService.findOneForProjectReadGrant).toHaveBeenCalledWith('task-1', 'project-1', 'ws-1', 'agent-1', GRANT);
    expect(tasksService.findOne).not.toHaveBeenCalled();

    const humanRequest = { actor: { type: 'human', id: 'user-1' } } as unknown as Parameters<TasksController['findOne']>[1];
    await expect(controller.findOne('task-1', humanRequest, undefined, response as never)).resolves.toEqual(task);
    expect(tasksService.findOne).toHaveBeenCalledWith('task-1', 'user-1');
  });
});

describe('TasksService.findOneForProjectReadGrant', () => {
  function serviceFor(taskValue: unknown = {
    id: 'task-1', projectId: 'project-1', title: 'title', description: 'description', status: 'todo',
  }) {
    const prisma = {
      task: { findFirst: jest.fn().mockResolvedValue(taskValue) },
      activityLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
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

  it('selects only task identity, project, title, description and status, then uses the index audit event', async () => {
    const { prisma, service } = serviceFor();
    const result = await service.findOneForProjectReadGrant('task-1', 'project-1', 'ws-1', 'agent-1', GRANT);
    expect(prisma.task.findFirst).toHaveBeenCalledWith({
      where: { id: 'task-1', projectId: 'project-1', project: { workspaceId: 'ws-1' } },
      select: { id: true, projectId: true, title: true, description: true, status: true },
    });
    expect(result).toEqual({ id: 'task-1', projectId: 'project-1', title: 'title', description: 'description', status: 'todo', auditEventId: 'audit-1' });
    expect(prisma.activityLog.create).toHaveBeenCalledWith({
      data: {
        workspaceId: 'ws-1', taskId: null, actorType: 'agent', actorId: 'agent-1',
        action: PROJECT_INDEX_READ_ACTION,
        payload: { projectId: 'project-1', decision: 'DEC-TEST', rowCount: 1 },
      },
      select: { id: true },
    });
  });

  it('does not return a task or write an audit when the exact task/project/workspace query misses', async () => {
    const { prisma, service } = serviceFor(null);
    await expect(service.findOneForProjectReadGrant('task-1', 'project-1', 'ws-1', 'agent-1', GRANT)).rejects.toThrow(NotFoundException);
    expect(prisma.activityLog.create).not.toHaveBeenCalled();
  });

  it('fails closed when the audit event cannot be recorded', async () => {
    const { prisma, service } = serviceFor();
    prisma.activityLog.create.mockRejectedValue(new Error('audit unavailable'));
    await expect(service.findOneForProjectReadGrant('task-1', 'project-1', 'ws-1', 'agent-1', GRANT)).rejects.toThrow('audit unavailable');
  });
});
