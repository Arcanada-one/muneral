// MUN-0043: the unit-level proofs for `AgentTaskScopeGuard`. The e2e suite
// exercises it through real HTTP against a real database; this one pins the
// decision table, including the cases that are awkward to provoke over HTTP.

import { ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Agent } from '@prisma/client';
import { AGENT_SCOPE_KEY } from '../src/auth/agent-scope.decorator';
import {
  AgentScopedRequest,
  AgentTaskScopeGuard,
} from '../src/auth/guards/agent-task-scope.guard';
import { PrismaService } from '../src/prisma/prisma.service';

const AGENT = {
  id: 'agent-1',
  workspaceId: 'ws-1',
  name: 'aup-executor',
} as unknown as Agent;

function makeContext(req: Partial<AgentScopedRequest>): {
  ctx: ExecutionContext;
  req: AgentScopedRequest;
} {
  const request = { params: {}, ...req } as AgentScopedRequest;
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
  return { ctx, req: request };
}

describe('AgentTaskScopeGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let prisma: {
    taskAgent: { findFirst: jest.Mock };
    project: { findFirst: jest.Mock };
    task: { findFirst: jest.Mock };
  };
  let guard: AgentTaskScopeGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    prisma = {
      taskAgent: { findFirst: jest.fn() },
      project: { findFirst: jest.fn() },
      task: { findFirst: jest.fn() },
    };
    guard = new AgentTaskScopeGuard(
      reflector as unknown as Reflector,
      prisma as unknown as PrismaService,
    );
  });

  it('lets a JWT request through untouched and never queries for a scope', async () => {
    const { ctx, req } = makeContext({ params: { taskId: 't-1' } });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(reflector.getAllAndOverride).not.toHaveBeenCalled();
    expect(prisma.taskAgent.findFirst).not.toHaveBeenCalled();
    // No scope is attached, so the handler answers the unnarrowed question.
    expect(req.agentScope).toBeUndefined();
  });

  it('refuses an API key on a route that was never marked @AgentScope', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const { ctx } = makeContext({ apiKeyAgent: AGENT, params: { taskId: 't-1' } });

    // Default-deny: an unmarked route is closed to keys the day it is added,
    // rather than open until somebody remembers to close it.
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    expect(prisma.taskAgent.findFirst).not.toHaveBeenCalled();
  });

  it('admits an assigned agent to its own task and records the scope', async () => {
    reflector.getAllAndOverride.mockReturnValue('task');
    prisma.taskAgent.findFirst.mockResolvedValue({ taskId: 't-1' });
    const { ctx, req } = makeContext({ apiKeyAgent: AGENT, params: { taskId: 't-1' } });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.agentScope).toEqual({ agentId: 'agent-1', kind: 'task' });
  });

  it('constrains the assignment lookup by workspace as well as by agent', async () => {
    reflector.getAllAndOverride.mockReturnValue('task');
    prisma.taskAgent.findFirst.mockResolvedValue({ taskId: 't-1' });
    const { ctx } = makeContext({ apiKeyAgent: AGENT, params: { taskId: 't-1' } });

    await guard.canActivate(ctx);

    // A stray assignment row pointing across a workspace boundary must not be
    // enough on its own — the query itself refuses to cross it.
    expect(prisma.taskAgent.findFirst).toHaveBeenCalledWith({
      where: {
        agentId: 'agent-1',
        taskId: 't-1',
        task: { project: { workspaceId: 'ws-1' } },
      },
      select: { taskId: true },
    });
  });

  it('refuses an agent that is not assigned to the task', async () => {
    reflector.getAllAndOverride.mockReturnValue('task');
    prisma.taskAgent.findFirst.mockResolvedValue(null);
    const { ctx } = makeContext({ apiKeyAgent: AGENT, params: { taskId: 't-9' } });

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('answers a malformed task id the same way as an unassigned one', async () => {
    reflector.getAllAndOverride.mockReturnValue('task');
    prisma.taskAgent.findFirst.mockRejectedValue(new Error('invalid input syntax for uuid'));
    const { ctx } = makeContext({ apiKeyAgent: AGENT, params: { taskId: 'not-a-uuid' } });

    // 403, not a 500 that tells the caller its id was at least well-formed.
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('refuses a task-scoped route that carries no task id at all', async () => {
    reflector.getAllAndOverride.mockReturnValue('task');
    const { ctx } = makeContext({ apiKeyAgent: AGENT, params: {} });

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    expect(prisma.taskAgent.findFirst).not.toHaveBeenCalled();
  });

  // --- the weaker 'task-workspace' scope, used only where a route was already open
  it('admits an UNASSIGNED agent to a task in its own workspace under task-workspace', async () => {
    reflector.getAllAndOverride.mockReturnValue('task-workspace');
    prisma.task.findFirst.mockResolvedValue({ id: 't-1' });
    const { ctx, req } = makeContext({ apiKeyAgent: AGENT, params: { taskId: 't-1' } });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // No assignment lookup at all: this scope is the workspace boundary, and
    // narrowing a live route to assignments is a separate, evidenced change.
    expect(prisma.taskAgent.findFirst).not.toHaveBeenCalled();
    expect(prisma.task.findFirst).toHaveBeenCalledWith({
      where: { id: 't-1', project: { workspaceId: 'ws-1' } },
      select: { id: true },
    });
    expect(req.agentScope).toEqual({ agentId: 'agent-1', kind: 'task-workspace' });
  });

  it('refuses a task in another workspace with the same 404 a missing task gets', async () => {
    reflector.getAllAndOverride.mockReturnValue('task-workspace');
    prisma.task.findFirst.mockResolvedValue(null);
    const { ctx } = makeContext({ apiKeyAgent: AGENT, params: { taskId: 't-elsewhere' } });

    await expect(guard.canActivate(ctx)).rejects.toThrow(NotFoundException);
  });

  it('admits a project in the agent workspace and records the scope to narrow by', async () => {
    reflector.getAllAndOverride.mockReturnValue('project');
    prisma.project.findFirst.mockResolvedValue({ id: 'p-1' });
    const { ctx, req } = makeContext({ apiKeyAgent: AGENT, params: { projectId: 'p-1' } });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(prisma.project.findFirst).toHaveBeenCalledWith({
      where: { id: 'p-1', workspaceId: 'ws-1' },
      select: { id: true },
    });
    // The handler must narrow by this; without it the route would answer with
    // the whole board.
    expect(req.agentScope).toEqual({ agentId: 'agent-1', kind: 'project' });
  });

  it('answers 404 for a project outside the agent workspace', async () => {
    reflector.getAllAndOverride.mockReturnValue('project');
    prisma.project.findFirst.mockResolvedValue(null);
    const { ctx } = makeContext({ apiKeyAgent: AGENT, params: { projectId: 'p-other' } });

    // The same answer a project id that never existed gets: a key cannot use
    // the difference to map another workspace.
    await expect(guard.canActivate(ctx)).rejects.toThrow(NotFoundException);
  });

  it('reads the scope from the handler first, then the controller', async () => {
    reflector.getAllAndOverride.mockReturnValue('task');
    prisma.taskAgent.findFirst.mockResolvedValue({ taskId: 't-1' });
    const { ctx } = makeContext({ apiKeyAgent: AGENT, params: { taskId: 't-1' } });

    await guard.canActivate(ctx);

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(AGENT_SCOPE_KEY, [
      expect.any(Function),
      expect.any(Function),
    ]);
  });
});
