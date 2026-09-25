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
// vitest exposes describe/it/expect as globals (vitest.config.ts `globals: true`);
// `vi` is the one name that must be imported, exactly as `jest` had to be.
import { vi, type Mock } from 'vitest';

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
  let reflector: { getAllAndOverride: Mock };
  let prisma: {
    taskAgent: { findFirst: Mock };
    project: { findFirst: Mock };
    task: { findFirst: Mock };
    agent: { findFirst: Mock };
  };
  let guard: AgentTaskScopeGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: vi.fn() };
    prisma = {
      taskAgent: { findFirst: vi.fn() },
      project: { findFirst: vi.fn() },
      task: { findFirst: vi.fn() },
      agent: { findFirst: vi.fn() },
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
  //
  // A2-294. The route stays OPEN to an unassigned key in its own workspace — the
  // pollers that depend on it are why it was not narrowed to assignments — but
  // the free-text VALUES are withheld from it. Until A2-294 they were not: the
  // guard took an early return on "holds no project-read grant" and answered
  // plaintext `title` and `description`, which is the opposite of DEC-AUP-0033 R4.
  it('admits an UNASSIGNED agent to a task in its own workspace under task-workspace, and WITHHOLDS its free text', async () => {
    reflector.getAllAndOverride.mockReturnValue('task-workspace');
    prisma.task.findFirst
      .mockResolvedValueOnce({ id: 't-1' }) // in the workspace
      .mockResolvedValueOnce(null); // not owned by this key
    const { ctx, req } = makeContext({ apiKeyAgent: AGENT, params: { taskId: 't-1' } });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    // No assignment lookup at all: this scope is the workspace boundary, and
    // narrowing the ROUTE to assignments is still a separate, evidenced change.
    expect(prisma.taskAgent.findFirst).not.toHaveBeenCalled();
    expect(prisma.task.findFirst).toHaveBeenNthCalledWith(1, {
      where: { id: 't-1', project: { workspaceId: 'ws-1' } },
      // A2-294: `projectId` left the select again — nothing reads it now that the
      // withholding does not depend on which project holds a grant. The where
      // clause, the workspace boundary itself, is what it has always been.
      select: { id: true },
    });
    // The ownership query is the only thing the decision rests on, so it is
    // always issued: the default (empty) grant list no longer short-circuits it.
    expect(prisma.task.findFirst).toHaveBeenCalledTimes(2);
    expect(req.agentScope).toEqual({
      agentId: 'agent-1',
      kind: 'task-workspace',
      withholdFreeTextValues: true,
    });
  });

  it('does NOT withhold from a key that OWNS the task, with no grant list at all', async () => {
    reflector.getAllAndOverride.mockReturnValue('task-workspace');
    prisma.task.findFirst
      .mockResolvedValueOnce({ id: 't-1' })
      .mockResolvedValueOnce({ id: 't-1' }); // owned: creator or assignee
    const { ctx, req } = makeContext({ apiKeyAgent: AGENT, params: { taskId: 't-1' } });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.agentScope?.withholdFreeTextValues).toBe(false);
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
    // A2-304c: jest took `doNotFake` (a deny-list); vitest takes `toFake` (an
    // allow-list), and silently IGNORED the unknown key — the test stayed green
    // while faking more than it meant to. Only the clock is under test here
    // (`vi.setSystemTime` below is the whole point), and nextTick/setImmediate must
    // stay real or the awaits in this block never settle. `toFake: ['Date']` says
    // exactly that. Caught by `pnpm run test:types`, not by the suite.
    vi.useFakeTimers({ now: new Date('2026-09-20T00:00:00Z'), toFake: ['Date'] });
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

      vi.setSystemTime(new Date('2026-09-28T00:00:00Z'));
      await expect(
        guard.canActivate(assignCtx({ agentId: listed.id, role: 'executor' }, listed).ctx),
      ).rejects.toThrow(ForbiddenException);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses an assign route without a task id, without querying', async () => {
    reflector.getAllAndOverride.mockReturnValue('task-assign');
    const { ctx } = makeContext({ apiKeyAgent: AGENT, params: {}, body: { agentId: OTHER_AGENT, role: 'executor' } });

    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
    expect(prisma.task.findFirst).not.toHaveBeenCalled();
  });

  // MUN-0052 — 'project-index': workspace, then a live grant for (agent, project).
  describe("'project-index'", () => {
    const GRANT = {
      agentId: 'agent-1',
      agentName: 'aup-executor',
      projectId: 'p-1',
      until: '2999-01-01T00:00:00Z',
      decision: 'DEC-TEST',
      evidence: 'unit',
    };
    const indexGuard = (grants: (typeof GRANT)[]) =>
      new AgentTaskScopeGuard(
        reflector as unknown as Reflector,
        prisma as unknown as PrismaService,
        grants,
      );

    it('admits a key with a live grant for the project and hands the grant downstream', async () => {
      reflector.getAllAndOverride.mockReturnValue('project-index');
      prisma.project.findFirst.mockResolvedValue({ id: 'p-1' });
      const { ctx, req } = makeContext({ apiKeyAgent: AGENT, params: { projectId: 'p-1' } });

      await expect(indexGuard([GRANT]).canActivate(ctx)).resolves.toBe(true);
      expect(prisma.project.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'p-1', workspaceId: 'ws-1' } }),
      );
      expect(req.agentScope).toEqual({ agentId: 'agent-1', kind: 'project-index', projectReadGrant: GRANT });
    });

    // MUN-0055 (DEC-AUP-0033 R1) splits ONE case out of this equivalence
    // class: an entry that names this key and this project and has simply run
    // out of time. Everything else still answers the identical 404.
    it('answers 404 without a grant, with a grant for another project, and with a grant for another agent', async () => {
      reflector.getAllAndOverride.mockReturnValue('project-index');
      prisma.project.findFirst.mockResolvedValue({ id: 'p-1' });
      for (const grants of [[], [{ ...GRANT, projectId: 'p-2' }], [{ ...GRANT, agentId: 'agent-2' }]]) {
        const { ctx, req } = makeContext({ apiKeyAgent: AGENT, params: { projectId: 'p-1' } });
        await expect(indexGuard(grants).canActivate(ctx)).rejects.toThrow(NotFoundException);
        expect(req.agentScope).toBeUndefined();
      }
    });

    it('answers 403 GRANT_EXPIRED — not 404 — when THIS key had a grant on THIS project and it lapsed', async () => {
      reflector.getAllAndOverride.mockReturnValue('project-index');
      prisma.project.findFirst.mockResolvedValue({ id: 'p-1' });
      const expired = { ...GRANT, until: '2000-01-01T00:00:00Z', decision: 'DEC-TEST-OLD' };
      const { ctx, req } = makeContext({ apiKeyAgent: AGENT, params: { projectId: 'p-1' } });

      const err = await indexGuard([expired]).canActivate(ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getStatus()).toBe(403);
      expect((err as ForbiddenException).getResponse()).toEqual({
        code: 'GRANT_EXPIRED',
        message: expect.stringContaining('2000-01-01T00:00:00Z'),
        projectId: 'p-1',
        until: '2000-01-01T00:00:00Z',
        decision: 'DEC-TEST-OLD',
      });
      // A refusal narrows nothing downstream: no scope is handed on.
      expect(req.agentScope).toBeUndefined();
    });

    it('an expired grant for ANOTHER project still answers the blanket 404, revealing no entry', async () => {
      reflector.getAllAndOverride.mockReturnValue('project-index');
      prisma.project.findFirst.mockResolvedValue({ id: 'p-1' });
      const expiredElsewhere = { ...GRANT, projectId: 'p-2', until: '2000-01-01T00:00:00Z' };
      const { ctx } = makeContext({ apiKeyAgent: AGENT, params: { projectId: 'p-1' } });

      await expect(indexGuard([expiredElsewhere]).canActivate(ctx)).rejects.toThrow(NotFoundException);
    });

    it('a project outside the workspace answers 404 even when the key holds an EXPIRED grant naming it', async () => {
      reflector.getAllAndOverride.mockReturnValue('project-index');
      prisma.project.findFirst.mockResolvedValue(null);
      const expired = { ...GRANT, until: '2000-01-01T00:00:00Z' };
      const { ctx } = makeContext({ apiKeyAgent: AGENT, params: { projectId: 'p-1' } });

      // The workspace wall runs FIRST and must stay indistinguishable from an
      // unknown project: otherwise `grant_expired` would confirm, to a foreign
      // workspace's key, that a project it was once named for exists.
      await expect(indexGuard([expired]).canActivate(ctx)).rejects.toThrow(NotFoundException);
    });

    it('with two entries for the same pair the LATEST window decides, and the refusal cites it', async () => {
      reflector.getAllAndOverride.mockReturnValue('project-index');
      prisma.project.findFirst.mockResolvedValue({ id: 'p-1' });
      const older = { ...GRANT, until: '2000-01-01T00:00:00Z', decision: 'DEC-TEST-OLD' };
      const newer = { ...GRANT, until: '2020-01-01T00:00:00Z', decision: 'DEC-TEST-NEW' };
      const { ctx } = makeContext({ apiKeyAgent: AGENT, params: { projectId: 'p-1' } });

      // Declared oldest-first on purpose: a plain `.find()` would cite the
      // superseded decision in the refusal a caller records as evidence.
      const err = await indexGuard([older, newer]).canActivate(ctx).catch((e: unknown) => e);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: 'GRANT_EXPIRED',
        decision: 'DEC-TEST-NEW',
        until: '2020-01-01T00:00:00Z',
      });
    });

    it('matches the project id case-insensitively, as the uuid column does', async () => {
      reflector.getAllAndOverride.mockReturnValue('project-index');
      const upper = 'A3CA0FB1-2B67-430B-A7D9-5849785A4543';
      prisma.project.findFirst.mockResolvedValue({ id: upper });
      const grant = { ...GRANT, projectId: upper.toLowerCase() };
      const { ctx, req } = makeContext({ apiKeyAgent: AGENT, params: { projectId: upper } });

      await expect(indexGuard([grant]).canActivate(ctx)).resolves.toBe(true);
      expect(req.agentScope?.projectReadGrant).toEqual(grant);
    });

    it('answers 404 for a project outside the workspace even when a grant names it', async () => {
      reflector.getAllAndOverride.mockReturnValue('project-index');
      prisma.project.findFirst.mockResolvedValue(null);
      const { ctx } = makeContext({ apiKeyAgent: AGENT, params: { projectId: 'p-1' } });

      await expect(indexGuard([GRANT]).canActivate(ctx)).rejects.toThrow(NotFoundException);
    });

    // MUN-0055 (DEC-AUP-0033 R4) — the residual DEC-AUP-0029 R7 accepted for a
    // week: index (which ids) + field-changes (which values) = every title and
    // description of the project. MUN-0055 removed the second half for the
    // granted key ONLY, which left every other key reading plaintext; A2-294
    // removed it for every key that does not own the task. These tests keep the
    // granted key in the picture because it is the case MUN-0055 got right.
    describe("'task-workspace' withholding, with a grant list present", () => {
      const twGuard = (grants: (typeof GRANT)[]) =>
        new AgentTaskScopeGuard(
          reflector as unknown as Reflector,
          prisma as unknown as PrismaService,
          grants,
        );

      it('withholds free text from a granted key on a task it does NOT own', async () => {
        reflector.getAllAndOverride.mockReturnValue('task-workspace');
        prisma.task.findFirst
          .mockResolvedValueOnce({ id: 't-1', projectId: 'p-1' }) // in workspace
          .mockResolvedValueOnce(null); // not owned
        const { ctx, req } = makeContext({ apiKeyAgent: AGENT, params: { taskId: 't-1' } });

        await expect(twGuard([GRANT]).canActivate(ctx)).resolves.toBe(true);
        expect(req.agentScope).toEqual({
          agentId: 'agent-1',
          kind: 'task-workspace',
          withholdFreeTextValues: true,
        });
      });

      it('does NOT withhold on a task the granted key owns', async () => {
        reflector.getAllAndOverride.mockReturnValue('task-workspace');
        prisma.task.findFirst
          .mockResolvedValueOnce({ id: 't-1', projectId: 'p-1' })
          .mockResolvedValueOnce({ id: 't-1' }); // owned
        const { ctx, req } = makeContext({ apiKeyAgent: AGENT, params: { taskId: 't-1' } });

        await expect(twGuard([GRANT]).canActivate(ctx)).resolves.toBe(true);
        expect(req.agentScope?.withholdFreeTextValues).toBe(false);
      });

      // A2-294 — the three cases below are the ones MUN-0055 got backwards. Each
      // one is a key with LESS entitlement than the grant holder the withholding
      // was written for, and each one used to read plaintext.
      it('withholds when the task is in a project the grant does not name', async () => {
        reflector.getAllAndOverride.mockReturnValue('task-workspace');
        prisma.task.findFirst
          .mockResolvedValueOnce({ id: 't-9', projectId: 'p-OTHER' })
          .mockResolvedValueOnce(null); // not owned
        const { ctx, req } = makeContext({ apiKeyAgent: AGENT, params: { taskId: 't-9' } });

        await expect(twGuard([GRANT]).canActivate(ctx)).resolves.toBe(true);
        expect(req.agentScope?.withholdFreeTextValues).toBe(true);
      });

      it('withholds once the grant has expired — an expired grant entitles nothing', async () => {
        reflector.getAllAndOverride.mockReturnValue('task-workspace');
        prisma.task.findFirst
          .mockResolvedValueOnce({ id: 't-1', projectId: 'p-1' })
          .mockResolvedValueOnce(null); // not owned
        const { ctx, req } = makeContext({ apiKeyAgent: AGENT, params: { taskId: 't-1' } });

        await expect(
          twGuard([{ ...GRANT, until: '2000-01-01T00:00:00Z' }]).canActivate(ctx),
        ).resolves.toBe(true);
        expect(req.agentScope?.withholdFreeTextValues).toBe(true);
      });

      // The invariant behind all of it, stated once so a future change to the
      // grant list cannot quietly reopen the route: for 'task-workspace' the
      // grant list is not an input. Ownership is the whole rule.
      it('answers identically whatever the grant list holds — it is not an input to this scope', async () => {
        const lists = [
          [] as (typeof GRANT)[],
          [GRANT],
          [{ ...GRANT, projectId: 'p-OTHER' }],
          [{ ...GRANT, until: '2000-01-01T00:00:00Z' }],
          [{ ...GRANT, agentId: 'someone-else' }],
        ];
        for (const owned of [false, true]) {
          const answers: (boolean | undefined)[] = [];
          for (const list of lists) {
            vi.clearAllMocks();
            reflector.getAllAndOverride.mockReturnValue('task-workspace');
            prisma.task.findFirst
              .mockResolvedValueOnce({ id: 't-1', projectId: 'p-1' })
              .mockResolvedValueOnce(owned ? { id: 't-1' } : null);
            const { ctx, req } = makeContext({ apiKeyAgent: AGENT, params: { taskId: 't-1' } });
            await expect(twGuard(list).canActivate(ctx)).resolves.toBe(true);
            answers.push(req.agentScope?.withholdFreeTextValues);
          }
          // one distinct answer across every grant shape, and it is ownership
          expect([...new Set(answers)]).toEqual([!owned]);
        }
      });
    });

    it('the default grant list is consulted by no other scope kind', async () => {
      reflector.getAllAndOverride.mockReturnValue('task');
      prisma.task.findFirst.mockResolvedValue(null);
      const { ctx } = makeContext({ apiKeyAgent: { ...AGENT, id: GRANT.agentId } as unknown as Agent, params: { taskId: 't-1' } });

      await expect(indexGuard([GRANT]).canActivate(ctx)).rejects.toThrow(ForbiddenException);
    });
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
