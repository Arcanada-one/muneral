// MUN-0043: the unit-level proofs for `AgentTaskScopeGuard`. The e2e suite
// exercises it through real HTTP against a real database; this one pins the
// decision table, including the cases that are awkward to provoke over HTTP.

import { ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Agent } from '@prisma/client';
import { AGENT_SCOPE_KEY } from '../src/auth/agent-scope.decorator.js';
import { AgentTaskScopeGuard } from '../src/auth/guards/agent-task-scope.guard.js';
import type { AgentScopedRequest } from '../src/auth/guards/agent-task-scope.guard.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
// ESM has no injected globals, so `jest` must be imported for the RUNTIME.
// Its type, though, comes from @types/jest (already in tsconfig `types`),
// which is what the 339 existing jest.fn() call sites are written against —
// @jest/globals ships a stricter generic whose bare jest.fn() infers `never`
// and would red 416 lines that are not otherwise wrong. Value from one,
// type from the other.
import { jest as _jestRuntime } from '@jest/globals';
const jest = _jestRuntime as unknown as typeof globalThis.jest;

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
    agent: { findFirst: jest.Mock };
  };
  let guard: AgentTaskScopeGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    prisma = {
      taskAgent: { findFirst: jest.fn() },
      project: { findFirst: jest.fn() },
      task: { findFirst: jest.fn() },
      agent: { findFirst: jest.fn() },
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
    prisma.task.findFirst.mockResolvedValue({ id: 't-1' });
    const { ctx, req } = makeContext({ apiKeyAgent: AGENT, params: { taskId: 't-1' } });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.agentScope).toEqual({ agentId: 'agent-1', kind: 'task' });
  });

  it('MUN-0051: asks ONE question for task — workspace, then assigned OR agent-created', async () => {
    reflector.getAllAndOverride.mockReturnValue('task');
    prisma.task.findFirst.mockResolvedValue({ id: 't-1' });
    const { ctx } = makeContext({ apiKeyAgent: AGENT, params: { taskId: 't-1' } });

    await guard.canActivate(ctx);

    // A stray assignment row pointing across a workspace boundary must not be
    // enough on its own — the query itself refuses to cross it. The creator
    // half needs actor_type 'agent' as well as the id.
    expect(prisma.task.findFirst).toHaveBeenCalledWith({
      where: {
        id: 't-1',
        project: { workspaceId: 'ws-1' },
        OR: [
          { agents: { some: { agentId: 'agent-1' } } },
          { createdById: 'agent-1', actorType: 'agent' },
        ],
      },
      select: { id: true },
    });
    expect(prisma.taskAgent.findFirst).not.toHaveBeenCalled();
  });

  it('refuses an agent that neither is assigned to nor created the task', async () => {
    reflector.getAllAndOverride.mockReturnValue('task');
    prisma.task.findFirst.mockResolvedValue(null);
    const { ctx } = makeContext({ apiKeyAgent: AGENT, params: { taskId: 't-9' } });

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('answers a malformed task id the same way as an unassigned one', async () => {
    reflector.getAllAndOverride.mockReturnValue('task');
    prisma.task.findFirst.mockRejectedValue(new Error('invalid input syntax for uuid'));
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

  // --- MUN-0045: 'project-write' — POST /tasks, projectId in the BODY, not params
  it('admits a create inside the agent workspace, reading projectId from the body', async () => {
    reflector.getAllAndOverride.mockReturnValue('project-write');
    prisma.project.findFirst.mockResolvedValue({ id: 'p-1' });
    const { ctx, req } = makeContext({
      apiKeyAgent: AGENT,
      params: {},
      body: { projectId: 'p-1', title: 'AUP-3001' },
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(prisma.project.findFirst).toHaveBeenCalledWith({
      where: { id: 'p-1', workspaceId: 'ws-1' },
      select: { id: true },
    });
    expect(req.agentScope).toEqual({ agentId: 'agent-1', kind: 'project-write' });
  });

  it('the negative control: a key WITHOUT this scope still gets 403 on POST /tasks', async () => {
    // The route carries no @AgentScope at all — the state MUN-0045 found it in.
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const { ctx } = makeContext({
      apiKeyAgent: AGENT,
      params: {},
      body: { projectId: 'p-1', title: 'AUP-3001' },
    });

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    expect(prisma.project.findFirst).not.toHaveBeenCalled();
  });

  it('refuses to create in a project outside the agent workspace, 404 like a missing one', async () => {
    reflector.getAllAndOverride.mockReturnValue('project-write');
    prisma.project.findFirst.mockResolvedValue(null);
    const { ctx } = makeContext({
      apiKeyAgent: AGENT,
      params: {},
      body: { projectId: 'p-elsewhere', title: 'x' },
    });

    await expect(guard.canActivate(ctx)).rejects.toThrow(NotFoundException);
  });

  it('refuses a project-write route whose body carries no projectId at all', async () => {
    reflector.getAllAndOverride.mockReturnValue('project-write');
    const { ctx } = makeContext({ apiKeyAgent: AGENT, params: {}, body: { title: 'x' } });

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    expect(prisma.project.findFirst).not.toHaveBeenCalled();
  });

  // --- MUN-0049: 'task-redaction' — POST /tasks/:taskId/redactions, bound like 'task'
  it('admits a redaction by the agent assigned to the task, under its own scope name', async () => {
    reflector.getAllAndOverride.mockReturnValue('task-redaction');
    prisma.taskAgent.findFirst.mockResolvedValue({ taskId: 't-1' });
    const { ctx, req } = makeContext({ apiKeyAgent: AGENT, params: { taskId: 't-1' } });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(prisma.taskAgent.findFirst).toHaveBeenCalledWith({
      where: { agentId: 'agent-1', taskId: 't-1', task: { project: { workspaceId: 'ws-1' } } },
      select: { taskId: true },
    });
    expect(req.agentScope).toEqual({ agentId: 'agent-1', kind: 'task-redaction' });
  });

  it('refuses a redaction by an agent not assigned to the task', async () => {
    reflector.getAllAndOverride.mockReturnValue('task-redaction');
    prisma.taskAgent.findFirst.mockResolvedValue(null);
    const { ctx } = makeContext({ apiKeyAgent: AGENT, params: { taskId: 't-1' } });

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  // --- MUN-0050: 'task-status' — PATCH /tasks/:taskId/status, creator OR executor
  it('admits the status route by ONE query: workspace, then creator-or-executor', async () => {
    reflector.getAllAndOverride.mockReturnValue('task-status');
    prisma.task.findFirst.mockResolvedValue({ id: 't-1' });
    const { ctx, req } = makeContext({ apiKeyAgent: AGENT, params: { taskId: 't-1' } });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // The rule is the query: the workspace boundary is unconditional, the
    // creator pair (id AND actor type) and the executor-role assignment are
    // the only two ways in. A lead or reviewer row does not match this.
    expect(prisma.task.findFirst).toHaveBeenCalledWith({
      where: {
        id: 't-1',
        project: { workspaceId: 'ws-1' },
        OR: [
          { createdById: 'agent-1', actorType: 'agent' },
          { agents: { some: { agentId: 'agent-1', role: 'executor' } } },
        ],
      },
      select: { id: true },
    });
    // No separate assignment lookup: 'task' semantics are not consulted.
    expect(prisma.taskAgent.findFirst).not.toHaveBeenCalled();
    expect(req.agentScope).toEqual({ agentId: 'agent-1', kind: 'task-status' });
  });

  it('refuses the status route when the agent neither created the task nor executes it', async () => {
    reflector.getAllAndOverride.mockReturnValue('task-status');
    prisma.task.findFirst.mockResolvedValue(null);
    const { ctx, req } = makeContext({ apiKeyAgent: AGENT, params: { taskId: 't-1' } });

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    expect(req.agentScope).toBeUndefined();
  });

  it('answers a malformed task id on the status route with 403, not 500', async () => {
    reflector.getAllAndOverride.mockReturnValue('task-status');
    prisma.task.findFirst.mockRejectedValue(new Error('invalid input syntax for uuid'));
    const { ctx } = makeContext({ apiKeyAgent: AGENT, params: { taskId: 'not-a-uuid' } });

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('refuses a status route that carries no task id, without querying', async () => {
    reflector.getAllAndOverride.mockReturnValue('task-status');
    const { ctx } = makeContext({ apiKeyAgent: AGENT, params: {} });

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    expect(prisma.task.findFirst).not.toHaveBeenCalled();
  });

  it('ignores a non-string projectId in the body rather than passing it to Prisma', async () => {
    reflector.getAllAndOverride.mockReturnValue('project-write');
    const { ctx } = makeContext({
      apiKeyAgent: AGENT,
      params: {},
      body: { projectId: { $ne: null }, title: 'x' },
    });

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    expect(prisma.project.findFirst).not.toHaveBeenCalled();
  });

  // --- MUN-0051: 'task-assign' — POST /agents/tasks/:taskId/assign
  const OTHER_AGENT = '00000000-0000-4000-8000-0000000000b2';
  const assignCtx = (body: Record<string, unknown>, agent: Agent = AGENT) =>
    makeContext({ apiKeyAgent: agent, params: { taskId: 't-1' }, body });
  const taskRow = (over: { createdById?: string | null; actorType?: string; roles?: string[] } = {}) => ({
    createdById: over.createdById === undefined ? 'someone-else' : over.createdById,
    actorType: over.actorType ?? 'human',
    agents: (over.roles ?? []).map((role) => ({ role })),
  });

  it('admits the creator to grant any role, and records the basis', async () => {
    reflector.getAllAndOverride.mockReturnValue('task-assign');
    prisma.task.findFirst.mockResolvedValue(taskRow({ createdById: 'agent-1', actorType: 'agent' }));
    prisma.agent.findFirst.mockResolvedValue({ id: OTHER_AGENT });
    const { ctx, req } = assignCtx({ agentId: OTHER_AGENT, role: 'lead' });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.agentScope).toEqual({ agentId: 'agent-1', kind: 'task-assign', assignBasis: 'creator' });
    // The task question is bounded by the workspace; the assignee question too.
    expect(prisma.task.findFirst).toHaveBeenCalledWith({
      where: { id: 't-1', project: { workspaceId: 'ws-1' } },
      select: {
        createdById: true,
        actorType: true,
        agents: { where: { agentId: 'agent-1' }, select: { role: true } },
      },
    });
    expect(prisma.agent.findFirst).toHaveBeenCalledWith({
      where: { id: OTHER_AGENT, workspaceId: 'ws-1' },
      select: { id: true },
    });
  });

  it('admits an executor to grant executor or reviewer', async () => {
    reflector.getAllAndOverride.mockReturnValue('task-assign');
    prisma.task.findFirst.mockResolvedValue(taskRow({ roles: ['executor'] }));
    prisma.agent.findFirst.mockResolvedValue({ id: OTHER_AGENT });
    for (const role of ['executor', 'reviewer']) {
      const { ctx, req } = assignCtx({ agentId: OTHER_AGENT, role });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(req.agentScope?.assignBasis).toBe('executor');
    }
  });

  it('refuses an executor granting lead — never above its own role', async () => {
    reflector.getAllAndOverride.mockReturnValue('task-assign');
    prisma.task.findFirst.mockResolvedValue(taskRow({ roles: ['executor'] }));
    prisma.agent.findFirst.mockResolvedValue({ id: OTHER_AGENT });
    const { ctx } = assignCtx({ agentId: OTHER_AGENT, role: 'lead' });

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('refuses a lead or reviewer assignee, a stranger and a human-created task', async () => {
    reflector.getAllAndOverride.mockReturnValue('task-assign');
    prisma.agent.findFirst.mockResolvedValue({ id: OTHER_AGENT });
    for (const row of [
      taskRow({ roles: ['lead'] }),
      taskRow({ roles: ['reviewer'] }),
      taskRow(),
      // an agent id stored under a HUMAN actor type is not authorship
      taskRow({ createdById: 'agent-1', actorType: 'human' }),
    ]) {
      prisma.task.findFirst.mockResolvedValue(row);
      const { ctx } = assignCtx({ agentId: OTHER_AGENT, role: 'reviewer' });
      await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    }
  });

  it('refuses a task outside the workspace, an unknown and a malformed id alike (403)', async () => {
    reflector.getAllAndOverride.mockReturnValue('task-assign');
    prisma.task.findFirst.mockResolvedValueOnce(null);
    await expect(guard.canActivate(assignCtx({ agentId: OTHER_AGENT, role: 'executor' }).ctx)).rejects.toThrow(
      ForbiddenException,
    );
    prisma.task.findFirst.mockRejectedValueOnce(new Error('invalid input syntax for uuid'));
    await expect(guard.canActivate(assignCtx({ agentId: OTHER_AGENT, role: 'executor' }).ctx)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('refuses an assignee that is not an agent of the key workspace', async () => {
    reflector.getAllAndOverride.mockReturnValue('task-assign');
    prisma.task.findFirst.mockResolvedValue(taskRow({ createdById: 'agent-1', actorType: 'agent' }));
    prisma.agent.findFirst.mockResolvedValue(null);
    const { ctx } = assignCtx({ agentId: OTHER_AGENT, role: 'executor' });

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('refuses an unknown role or a missing assignee even for the creator', async () => {
    reflector.getAllAndOverride.mockReturnValue('task-assign');
    prisma.task.findFirst.mockResolvedValue(taskRow({ createdById: 'agent-1', actorType: 'agent' }));
    prisma.agent.findFirst.mockResolvedValue({ id: OTHER_AGENT });
    await expect(guard.canActivate(assignCtx({ agentId: OTHER_AGENT, role: 'owner' }).ctx)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(guard.canActivate(assignCtx({ role: 'executor' }).ctx)).rejects.toThrow(ForbiddenException);
  });

  it('the compatibility window: a listed agent may still give ITSELF executor, until the expiry', async () => {
    const listed = { ...AGENT, id: '9437639a-5f7c-4fe4-be04-18112ba0bada' } as unknown as Agent;
    reflector.getAllAndOverride.mockReturnValue('task-assign');
    prisma.task.findFirst.mockResolvedValue(taskRow());
    prisma.agent.findFirst.mockResolvedValue({ id: listed.id });
    jest.useFakeTimers({ now: new Date('2026-09-20T00:00:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const self = assignCtx({ agentId: listed.id, role: 'executor' }, listed);
      await expect(guard.canActivate(self.ctx)).resolves.toBe(true);
      expect(self.req.agentScope?.assignBasis).toBe('compat-window');
      // not somebody else, not lead — even inside the window
      await expect(
        guard.canActivate(assignCtx({ agentId: OTHER_AGENT, role: 'executor' }, listed).ctx),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        guard.canActivate(assignCtx({ agentId: listed.id, role: 'lead' }, listed).ctx),
      ).rejects.toThrow(ForbiddenException);

      jest.setSystemTime(new Date('2026-09-28T00:00:00Z'));
      await expect(
        guard.canActivate(assignCtx({ agentId: listed.id, role: 'executor' }, listed).ctx),
      ).rejects.toThrow(ForbiddenException);
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses an assign route without a task id, without querying', async () => {
    reflector.getAllAndOverride.mockReturnValue('task-assign');
    const { ctx } = makeContext({ apiKeyAgent: AGENT, params: {}, body: { agentId: OTHER_AGENT, role: 'executor' } });

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    expect(prisma.task.findFirst).not.toHaveBeenCalled();
  });

  it('reads the scope from the handler first, then the controller', async () => {
    reflector.getAllAndOverride.mockReturnValue('task');
    prisma.task.findFirst.mockResolvedValue({ id: 't-1' });
    const { ctx } = makeContext({ apiKeyAgent: AGENT, params: { taskId: 't-1' } });

    await guard.canActivate(ctx);

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(AGENT_SCOPE_KEY, [
      expect.any(Function),
      expect.any(Function),
    ]);
  });
});
