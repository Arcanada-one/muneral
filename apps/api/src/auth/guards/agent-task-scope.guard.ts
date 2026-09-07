import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { Agent } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AGENT_SCOPE_KEY, AgentScopeKind } from '../agent-scope.decorator';

/** What an authorised agent request carries downstream: the id the handler must
 *  narrow its answer to. Absent on JWT requests, which are not narrowed. */
export interface AgentScopeContext {
  agentId: string;
  kind: AgentScopeKind;
}

export type AgentScopedRequest = Request & {
  apiKeyAgent?: Agent;
  agentScope?: AgentScopeContext;
};

/**
 * MUN-0043 — scope an agent's API key to its own assignments.
 *
 * Runs after `JwtOrApiKeyGuard`, which is what puts `req.apiKeyAgent` there.
 *
 * A JWT request passes straight through: this guard exists to bound API keys,
 * and human authorisation is the existing (unchanged) concern of the JWT
 * strategy. An API-key request must clear three things, in this order:
 *
 *   1. the route is marked `@AgentScope(...)` at all — an unmarked route is
 *      refused with 403 even for a perfectly valid key;
 *   2. the workspace matches — the agent's workspace must own the project the
 *      route touches, so a valid key from workspace A can never read a task in
 *      workspace B even if some assignment row got there by accident;
 *   3. the assignment exists — for a task route, `task_agents` must hold a row
 *      for (this task, this agent).
 *
 * One route family is scoped more weakly on purpose. `GET /tasks/:id/field-changes`
 * and `POST /tasks/:id/field-ack` were ALREADY reachable by any valid API key
 * before MUN-0043, with no ownership check at all — so an agent in workspace A
 * could read the tracked field VALUES (title, description, status, priority) of
 * any task in workspace B. That cross-tenant read is closed here with
 * `'task-workspace'`. It is not tightened all the way to `'task'` in the same
 * change because unattended pollers already depend on reading tasks inside their
 * own workspace, and silently narrowing a live route to assignments only would
 * break them without evidence of who calls it. The residual — an agent reading an
 * unassigned task's field state inside its OWN workspace — is recorded as a
 * finding with the measurement that would justify closing it.
 *
 * Two deliberate choices about what the refusals reveal. A task that does not
 * exist and a task the agent is not assigned to both answer 403, so a key
 * cannot be used to enumerate which task ids are real. And a project outside
 * the agent's workspace answers 404, the same answer a project id that never
 * existed gets; inside the workspace the agent receives its own slice, which is
 * an empty list when it has no assignments there rather than a refusal that
 * would confirm the project has tasks in it.
 */
@Injectable()
export class AgentTaskScopeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AgentScopedRequest>();
    const agent = req.apiKeyAgent;

    // Not an API-key request: nothing here to bound.
    if (!agent) return true;

    const kind = this.reflector.getAllAndOverride<AgentScopeKind | undefined>(
      AGENT_SCOPE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!kind) {
      throw new ForbiddenException(
        'This route is not available to an agent API key. ' +
          'Authenticate as a user, or ask for the route to be scoped (MUN-0043).',
      );
    }

    switch (kind) {
      case 'task': {
        const taskId = this.paramOf(req, 'taskId');
        if (!taskId) throw new ForbiddenException('No task in scope for this key.');
        await this.assertAssignedToTask(agent, taskId);
        break;
      }
      case 'task-workspace': {
        const taskId = this.paramOf(req, 'taskId');
        if (!taskId) throw new ForbiddenException('No task in scope for this key.');
        await this.assertTaskInWorkspace(agent, taskId);
        break;
      }
      case 'project-write': {
        const projectId = this.bodyFieldOf(req, 'projectId');
        if (!projectId) throw new ForbiddenException('No project in scope for this key.');
        await this.assertProjectInWorkspace(agent, projectId);
        break;
      }
      case 'project': {
        const projectId = this.paramOf(req, 'projectId');
        if (!projectId) throw new ForbiddenException('No project in scope for this key.');
        await this.assertProjectInWorkspace(agent, projectId);
        break;
      }
      // MUN-0045 (contract_diff ENUM_VALUE_ADDED): a future AgentScopeKind that
      // reaches here without its own case is a COMPILE ERROR, not a route that
      // silently falls back onto 'project' — the if/else chain this replaced
      // could not make that guarantee.
      default: {
        const exhaustive: never = kind;
        throw new ForbiddenException(`Unhandled agent scope kind: ${String(exhaustive)}`);
      }
    }

    req.agentScope = { agentId: agent.id, kind };
    return true;
  }

  private paramOf(req: AgentScopedRequest, name: string): string | undefined {
    const params = req.params as Record<string, string> | undefined;
    const value = params?.[name];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  /** MUN-0045: 'project-write' reads its scoped id from the body, because
   *  `POST /tasks` names the target project as a DTO field, not a route
   *  param. This runs BEFORE the body is validated/transformed by the
   *  handler's ValidationPipe, so it reads the raw field defensively rather
   *  than trusting its shape. */
  private bodyFieldOf(req: AgentScopedRequest, name: string): string | undefined {
    const body = req.body as Record<string, unknown> | undefined;
    const value = body?.[name];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  /** 403 for "no such task" as well as for "not yours": see the class comment. */
  private async assertAssignedToTask(agent: Agent, taskId: string): Promise<void> {
    const assignment = await this.prisma.taskAgent
      .findFirst({
        where: {
          agentId: agent.id,
          taskId,
          task: { project: { workspaceId: agent.workspaceId } },
        },
        select: { taskId: true },
      })
      // An id that is not a UUID reaches Prisma as a malformed argument rather
      // than as "no rows". It is still simply out of scope for this key.
      .catch(() => null);

    if (!assignment) {
      throw new ForbiddenException(
        `Agent "${agent.name}" is not assigned to task ${taskId}.`,
      );
    }
  }

  /**
   * The task must belong to the agent's workspace, but the agent need not be
   * assigned to it.
   *
   * The refusal is 404, which is the answer this route already gives for a task
   * id that does not exist — so closing the cross-tenant read adds no new signal
   * a caller could use to probe another workspace's ids.
   */
  private async assertTaskInWorkspace(agent: Agent, taskId: string): Promise<void> {
    const task = await this.prisma.task
      .findFirst({
        where: { id: taskId, project: { workspaceId: agent.workspaceId } },
        select: { id: true },
      })
      .catch(() => null);

    if (!task) {
      throw new NotFoundException('Task not found');
    }
  }

  /** The project must at least belong to the agent's workspace. Which tasks
   *  inside it the agent may see is then narrowed by the handler from
   *  `req.agentScope`. */
  private async assertProjectInWorkspace(agent: Agent, projectId: string): Promise<void> {
    const project = await this.prisma.project
      .findFirst({
        where: { id: projectId, workspaceId: agent.workspaceId },
        select: { id: true },
      })
      .catch(() => null);

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found.`);
    }
  }
}
