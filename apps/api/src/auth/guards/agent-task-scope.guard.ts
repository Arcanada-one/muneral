import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Agent } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AGENT_SCOPE_KEY } from '../agent-scope.decorator.js';
import type { AgentScopeKind } from '../agent-scope.decorator.js';
import { agentOwnTaskWhere, agentStatusAuthorityWhere } from '../agent-task-visibility.js';
import { assignCompatWindowAdmits } from '../assign-compat-window.js';
import {
  PROJECT_READ_GRANTS,
  PROJECT_READ_GRANT_LIST,
  agentHoldsAnyLiveProjectReadGrant,
  projectHasLiveGrantForAgent,
  projectReadGrantState,
} from '../project-read-grants.js';
import type { ProjectReadGrantEntry } from '../project-read-grants.js';

/** What an authorised agent request carries downstream: the id the handler must
 *  narrow its answer to. Absent on JWT requests, which are not narrowed. */
export interface AgentScopeContext {
  agentId: string;
  kind: AgentScopeKind;
  /** MUN-0051, 'task-assign' only: what entitled the key to assign — recorded
   *  in the activity row the assignment writes. */
  assignBasis?: AssignBasis;
  /** MUN-0052, 'project-index' only: the grant that admitted the read. */
  projectReadGrant?: ProjectReadGrantEntry;
  /** MUN-0055, 'task-workspace' only: this key holds an index grant on the
   *  task's project and does not own the task, so the free-text field VALUES
   *  (title, description) are withheld from the field-change read. The change
   *  signal — version, hash, changed — is not. See DEC-AUP-0033 R4. */
  withholdFreeTextValues?: boolean;
}

export type AssignBasis = 'creator' | 'executor' | 'compat-window';

/** MUN-0051: the order in which an assignment may be handed on. A creator may
 *  grant any role; an executor may grant executor or reviewer, never lead. */
const ROLE_RANK: Readonly<Record<string, number>> = {
  reviewer: 1,
  executor: 2,
  lead: 3,
};

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
 *      for (this task, this agent); each scope kind below says which rows and
 *      which authorship count (MUN-0050, MUN-0051).
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
 *
 * MUN-0052 (DEC-AUP-0029) — the one exception to the own slice is
 * 'project-index': a key named in `project-read-grants.ts` for a project reads
 * that project's task index (ids, status, title hashes; no free text). Without a
 * live grant the route answers the same 404 as a project outside the workspace,
 * so it does not confirm that a project exists. No other scope kind consults
 * the grant list — in particular no write does.
 */
@Injectable()
export class AgentTaskScopeGuard implements CanActivate {
  private readonly projectReadGrants: readonly ProjectReadGrantEntry[];

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(PROJECT_READ_GRANTS)
    projectReadGrants?: readonly ProjectReadGrantEntry[],
  ) {
    this.projectReadGrants = projectReadGrants ?? PROJECT_READ_GRANT_LIST;
  }

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
      // MUN-0051: 'task' (read, activity, comment) admits the creator as well
      // as an assignee — see agentOwnTaskWhere.
      case 'task': {
        const taskId = this.paramOf(req, 'taskId');
        if (!taskId) throw new ForbiddenException('No task in scope for this key.');
        await this.assertOwnTask(agent, taskId);
        break;
      }
      // MUN-0049: 'task-redaction' is bound to the assignment — the agent
      // must be assigned to the task — and is listed separately so the write
      // can be revoked without touching the read/comment/status routes.
      // MUN-0051 deliberately did not widen it to the creator.
      case 'task-redaction': {
        const taskId = this.paramOf(req, 'taskId');
        if (!taskId) throw new ForbiddenException('No task in scope for this key.');
        await this.assertAssignedToTask(agent, taskId);
        break;
      }
      // A2-274: 'task-evidence' — attaching a ReadinessReceipt to a work item
      // and reading the list back. Creator OR assignee (assertOwnTask), NOT
      // assertAssignedToTask: an executor that registered its own work item
      // holds no `task_agents` row for it, and the assignment-only rule would
      // refuse it on exactly the task whose evidence it has (MUN-0054). Its own
      // scope name so the write can be revoked without touching the reads.
      case 'task-evidence': {
        const taskId = this.paramOf(req, 'taskId');
        if (!taskId) throw new ForbiddenException('No task in scope for this key.');
        await this.assertOwnTask(agent, taskId);
        break;
      }
      // MUN-0051: the assign route — see assertMayAssign.
      case 'task-assign': {
        const taskId = this.paramOf(req, 'taskId');
        if (!taskId) throw new ForbiddenException('No task in scope for this key.');
        const assignBasis = await this.assertMayAssign(
          agent,
          taskId,
          this.bodyFieldOf(req, 'agentId'),
          this.bodyFieldOf(req, 'role'),
          new Date(),
        );
        req.agentScope = { agentId: agent.id, kind, assignBasis };
        return true;
      }
      // MUN-0055 (DEC-AUP-0033 R4). The workspace check is unchanged. What is
      // new is that a key holding a LIVE index grant on this task's project
      // does not get the free-text VALUES of a task it does not own — see
      // assertTaskInWorkspace. DEC-AUP-0029 R7 accepted, for one week, that the
      // index (which ids) plus this route (which values) let the granted key
      // rebuild every title and description of project aup. Renewing the grant
      // without removing that combination would have made a one-week residual
      // permanent, so the renewal removes it instead.
      case 'task-workspace': {
        const taskId = this.paramOf(req, 'taskId');
        if (!taskId) throw new ForbiddenException('No task in scope for this key.');
        const withhold = await this.assertTaskInWorkspace(agent, taskId);
        req.agentScope = { agentId: agent.id, kind, withholdFreeTextValues: withhold };
        return true;
      }
      // MUN-0050: the status route. Creator OR executor assignment, inside the
      // agent's own workspace — see assertCreatorOrExecutorOfTask.
      case 'task-status': {
        const taskId = this.paramOf(req, 'taskId');
        if (!taskId) throw new ForbiddenException('No task in scope for this key.');
        await this.assertCreatorOrExecutorOfTask(agent, taskId);
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
      // MUN-0052: the task index. Workspace first, then the grant list.
      //
      // MUN-0055 (DEC-AUP-0033 R1) splits one of the refusals out of the
      // blanket 404. A key whose own entry has simply run out of time is told
      // so, with a machine-readable `GRANT_EXPIRED`; every other refusal keeps
      // the identical 404 `Project <id> not found.` that DEC-AUP-0029 R2 chose
      // so the route cannot be used to enumerate projects.
      //
      // That is not a hole, because the 403 is reachable only by a key that a
      // merged decision already named for this project: it learns that its own
      // grant lapsed, which is a fact about itself. And the secrecy it would
      // otherwise protect is not there to protect — measured 2026-09-23, an
      // agent key holding NO grant already tells an existing in-workspace
      // project (200, own slice, possibly empty) from an unknown or foreign one
      // (404) through the sibling route `GET /tasks/project/:projectId`, which
      // consults no grant list. The uniform 404 cost a legitimate holder its
      // diagnosis — two days of a silently dead board read — and bought no
      // secrecy against the one caller who could reach it.
      case 'project-index': {
        const projectId = this.paramOf(req, 'projectId');
        if (!projectId) throw new ForbiddenException('No project in scope for this key.');
        await this.assertProjectInWorkspace(agent, projectId);
        const state = projectReadGrantState(agent.id, projectId, new Date(), this.projectReadGrants);
        if (state.kind === 'expired') {
          // The body is an object, so NestJS serialises it verbatim: a caller
          // reads `code`, not prose. Same convention as migration.errors.ts.
          throw new ForbiddenException({
            code: 'GRANT_EXPIRED',
            message:
              `The project read grant for this key expired at ${state.entry.until}. ` +
              'It is renewed by a pull request citing a program decision, not by an environment edit (MUN-0055).',
            projectId,
            until: state.entry.until,
            decision: state.entry.decision,
          });
        }
        if (state.kind === 'none') throw new NotFoundException(`Project ${projectId} not found.`);
        req.agentScope = { agentId: agent.id, kind, projectReadGrant: state.entry };
        return true;
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

  /** MUN-0051 — 'task': assigned to the task OR its creator, inside the
   *  agent's workspace. 403 for every other case, as assertAssignedToTask. */
  private async assertOwnTask(agent: Agent, taskId: string): Promise<void> {
    const task = await this.prisma.task
      .findFirst({
        where: {
          id: taskId,
          project: { workspaceId: agent.workspaceId },
          ...agentOwnTaskWhere(agent.id),
        },
        select: { id: true },
      })
      .catch(() => null);

    if (!task) {
      throw new ForbiddenException(
        `Agent "${agent.name}" neither created task ${taskId} nor is assigned to it.`,
      );
    }
  }

  /**
   * MUN-0051 — who may write a `task_agents` row with a key.
   *
   * The caller's authority on the task comes first: the task must be in the
   * agent's workspace, and the agent must have created it (rank of lead: any
   * role may be granted) or hold an executor assignment (executor or reviewer
   * may be granted, never lead). A lead or reviewer assignment carries no
   * authority to assign — before MUN-0050 it did not move status either, and
   * handing on an assignment is the step that turns into a status move. Without
   * authority the one remaining door is the dated compatibility window (self,
   * executor/reviewer, listed agents only).
   *
   * Then the grant: the role must be a known role no higher than the caller's
   * own, and the assignee must be an agent of the caller's workspace — an id
   * from another workspace, an unknown id and a malformed id answer the same
   * 403, so the route cannot be used to discover agents elsewhere.
   *
   * Refusals about the task all use one message, so the route does not tell a
   * key which task ids exist.
   */
  private async assertMayAssign(
    agent: Agent,
    taskId: string,
    assigneeAgentId: string | undefined,
    role: string | undefined,
    now: Date,
  ): Promise<AssignBasis> {
    const task = await this.prisma.task
      .findFirst({
        where: { id: taskId, project: { workspaceId: agent.workspaceId } },
        select: {
          createdById: true,
          actorType: true,
          agents: { where: { agentId: agent.id }, select: { role: true } },
        },
      })
      .catch(() => null);

    const refuseTask = () =>
      new ForbiddenException(
        `Agent "${agent.name}" may not assign on task ${taskId}: only its creator or its executor may (MUN-0051).`,
      );
    if (!task) throw refuseTask();

    const isCreator = task.createdById === agent.id && task.actorType === 'agent';
    const isExecutor = task.agents.some((a) => a.role === 'executor');

    let basis: AssignBasis;
    let callerRank: number;
    if (isCreator) {
      basis = 'creator';
      callerRank = ROLE_RANK.lead;
    } else if (isExecutor) {
      basis = 'executor';
      callerRank = ROLE_RANK.executor;
    } else if (assignCompatWindowAdmits(agent.id, assigneeAgentId, role, now)) {
      basis = 'compat-window';
      callerRank = ROLE_RANK.executor;
    } else {
      throw refuseTask();
    }

    const requestedRank = role !== undefined ? ROLE_RANK[role] : undefined;
    if (requestedRank === undefined || requestedRank > callerRank) {
      throw new ForbiddenException(
        `Agent "${agent.name}" may not grant role "${String(role)}" on task ${taskId}: ` +
          `a ${basis} may grant ${basis === 'creator' ? 'lead, executor or reviewer' : 'executor or reviewer'} (MUN-0051).`,
      );
    }

    const assignee = assigneeAgentId
      ? await this.prisma.agent
          .findFirst({
            where: { id: assigneeAgentId, workspaceId: agent.workspaceId },
            select: { id: true },
          })
          .catch(() => null)
      : null;
    if (!assignee) {
      throw new ForbiddenException(
        `The assignee is not an agent of this key's workspace (MUN-0051).`,
      );
    }

    return basis;
  }

  /**
   * MUN-0050 — the status route's rule, in one query so the database and not
   * a sequence of checks is what answers it: the task must be in the agent's
   * workspace, and the agent must either be its creator (`created_by_id` is
   * this agent AND `actor_type` is 'agent' — a human's user id can never
   * satisfy the pair, and a creator row that names an agent id under a human
   * actor type is a forgery, not a grant) or hold a `task_agents` row for it
   * with role `executor`. A lead or reviewer assignment is not enough: those
   * roles read and comment (`'task'`), they do not move the card.
   *
   * 403 for "no such task", "not yours" and a malformed id alike, as on
   * `assertAssignedToTask`, so the status route cannot be used to enumerate
   * task ids either.
   */
  private async assertCreatorOrExecutorOfTask(agent: Agent, taskId: string): Promise<void> {
    const task = await this.prisma.task
      .findFirst({
        where: {
          id: taskId,
          project: { workspaceId: agent.workspaceId },
          ...agentStatusAuthorityWhere(agent.id),
        },
        select: { id: true },
      })
      .catch(() => null);

    if (!task) {
      throw new ForbiddenException(
        `Agent "${agent.name}" neither created task ${taskId} nor is assigned to it as executor.`,
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
  /**
   * The task must be in the agent's workspace. Returns whether the free-text
   * field VALUES must be withheld from this key (MUN-0055, DEC-AUP-0033 R4):
   * true only when the key holds a live index grant on THIS task's project and
   * does not own the task. Every key that holds no grant — which is every key
   * but the ones the grant list names — takes the early return and issues
   * exactly the queries it issued before.
   */
  private async assertTaskInWorkspace(agent: Agent, taskId: string): Promise<boolean> {
    const task = await this.prisma.task
      .findFirst({
        where: { id: taskId, project: { workspaceId: agent.workspaceId } },
        select: { id: true, projectId: true },
      })
      .catch(() => null);

    if (!task) {
      throw new NotFoundException('Task not found');
    }

    const now = new Date();
    if (!agentHoldsAnyLiveProjectReadGrant(agent.id, now, this.projectReadGrants)) {
      return false;
    }
    if (!projectHasLiveGrantForAgent(agent.id, task.projectId, now, this.projectReadGrants)) {
      return false;
    }

    const own = await this.prisma.task
      .findFirst({
        where: { id: taskId, ...agentOwnTaskWhere(agent.id) },
        select: { id: true },
      })
      .catch(() => null);

    return own === null;
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
