import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  Req,
  HttpCode,
  HttpStatus,
  Headers,
  Res,
  ForbiddenException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { TasksService } from './tasks.service.js';
import { CreateTaskDto } from './dto/create-task.dto.js';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto.js';
import { QueryTasksDto } from './dto/query-tasks.dto.js';
import { AddDependencyDto } from './dto/add-dependency.dto.js';
import { CreateChecklistItemDto } from './dto/create-checklist-item.dto.js';
import { AddCommentDto } from './dto/add-comment.dto.js';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard.js';
import { AgentTaskScopeGuard } from '../auth/guards/agent-task-scope.guard.js';
import type { AgentScopeContext } from '../auth/guards/agent-task-scope.guard.js';
import { AgentScope } from '../auth/agent-scope.decorator.js';
import { ActorInterceptor } from '../common/interceptors/actor.interceptor.js';
import type { Actor } from '@muneral/types';
import { FieldChangesService } from './field-state/field-changes.service.js';
import { TaskStalenessService } from '../execution-authority/task-staleness.service.js';
import { TaskRedactionService } from './redactions/task-redaction.service.js';
import { RedactFieldDto } from './redactions/redact-field.dto.js';

type AuthRequest = Request & { actor: Actor; agentScope?: AgentScopeContext };

/**
 * Tasks CRUD with status state machine, checklists, dependencies, comments.
 * Field-change tracking endpoints are in FieldChangesController (API-key auth).
 *
 * MUN-0043 — authentication here used to be JWT-only, so an agent holding a
 * perfectly valid `mun_sk_` key was answered 401 on every route, including
 * reading the task it had just been assigned and moving it along. That pushed
 * automated executors onto a human's 15-minute access token, which is both a
 * worse credential to hand an unattended process and one that expires under it.
 *
 * The guard pair below is an ALLOWLIST, not a widening: `JwtOrApiKeyGuard`
 * accepts either credential, and `AgentTaskScopeGuard` then refuses an API key
 * on every route that is not explicitly marked `@AgentScope(...)`, and on every
 * marked route whose task the key's agent is not assigned to. Routes with no
 * marker — delete, checklists, dependencies — stay exactly as JWT-only as they
 * were; the only visible difference is that a valid key is now told 403
 * instead of 401.
 *
 * MUN-0047 — `GET /tasks/:taskId/activity` is scoped the same way (below).
 * Before this, `POST /tasks/:taskId/comments` (MUN-0046) was write-only to an
 * agent key: the comment landed in the ActivityLog but no route an agent key
 * could reach ever read it back — `getActivity` was unmarked (403) and there
 * is no separate `GET .../comments` route at all. A write no writer can read
 * back is not an audit trail. Deliberately reused `'task'`, not a new kind:
 * reading a task's history requires the same assignment `findOne` and
 * `updateStatus` already require, and `ActivityService.findForTask` returns
 * full `ActivityLog` rows including `payload.body` for a `comment` action, so
 * this one route also makes a dedicated `GET .../comments` unnecessary — see
 * `docs/agent-read-loop.md` for the measurement.
 *
 * MUN-0045 — `POST /tasks` (`create`) is one exception: it is marked
 * `@AgentScope('project-write')`, because task creation with a `mun_sk_` key
 * was blocked entirely (403, unmarked route) and AUP-E30 needs an agent to be
 * able to register its own work. The scope binds the key to projects inside
 * its own workspace — see the decorator's doc comment for what it does and
 * does not grant.
 *
 * MUN-0046 — `POST /tasks/:taskId/comments` is the other: it carried the SAME
 * omission MUN-0045 fixed on `POST /tasks` (measured live: 403 "not available
 * to an agent API key", the unmarked-route default-deny, not a permissions
 * decision). Marked `@AgentScope('task')` — the same scope `findOne` and
 * `updateStatus` already use — because a comment, like a status move, is an
 * act on a specific task the agent must already be assigned to; there is no
 * body-carried project id here to invent a wider scope for; `'task'` is the
 * narrowest existing scope that fits. Authorship is unaffected — `AddCommentDto`
 * carries no actor field, and `req.actor` (via `ActorInterceptor`) is resolved
 * from the credential, never the body.
 *
 * MUN-0050 — `PATCH /tasks/:taskId/status` moves from `'task'` to its own
 * scope `'task-status'` (creator or executor assignment): see the handler.
 *
 * MUN-0049 — `POST /tasks/:taskId/redactions` is the third write. It is marked
 * with its OWN scope, `'task-redaction'`, rather than reusing `'task'`: the
 * assignment check is the same, but a route that rewrites a title is a
 * different kind of act from a comment or a status move, and naming it in the
 * allowlist keeps it revocable on its own. The body never carries the secret —
 * see `TaskRedactionService`.
 */
@Controller('tasks')
@UseGuards(JwtOrApiKeyGuard, AgentTaskScopeGuard)
@UseInterceptors(ActorInterceptor)
export class TasksController {
  constructor(
    private readonly tasksService: TasksService,
    private readonly fieldChangesService: FieldChangesService,
    private readonly stalenessService: TaskStalenessService,
    private readonly redactionService: TaskRedactionService,
  ) {}

  /** Creatable by an agent's API key inside its own workspace (MUN-0045) or by
   *  a JWT. `dto.projectId` is what the guard checks: a project outside the
   *  agent's workspace is refused before the handler runs. Authorship comes
   *  from `req.actor`, resolved server-side from the credential — the DTO has
   *  no field a caller could use to claim a different principal. */
  @Post()
  @AgentScope('project-write')
  create(@Req() req: AuthRequest, @Body() dto: CreateTaskDto) {
    return this.tasksService.create(req.actor, dto);
  }

  // Declared BEFORE `@Get(':taskId')`: Nest matches in declaration order, so
  // the parameterised route would otherwise swallow this one and treat the
  // empty path segment as a task id.
  @Get()
  query(@Query() dto: QueryTasksDto) {
    return this.tasksService.query(dto);
  }

  /** Readable by the assigned agent's API key (MUN-0043) or by a JWT. */
  @Get(':taskId')
  @AgentScope('task')
  async findOne(
    @Param('taskId') taskId: string,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const task = await this.tasksService.findOne(taskId);

    // Strong ETag: SHA-256 of sorted field:version pairs
    const etag = await this.fieldChangesService.computeTaskEtag(taskId);
    if (etag) {
      const etagValue = `"${etag}"`;
      res.setHeader('ETag', etagValue);

      if (ifNoneMatch && ifNoneMatch === etagValue) {
        res.status(304).end();
        return;
      }
    }

    return task;
  }

  /**
   * A JWT sees the project's tasks. An agent key sees the tasks in that project
   * it is assigned to — the narrowing happens in the service, from the scope the
   * guard resolved, so a handler that forgets to pass it cannot accidentally
   * return the whole board.
   */
  @Get('project/:projectId')
  @AgentScope('project')
  findByProject(
    @Param('projectId') projectId: string,
    @Req() req: AuthRequest,
  ) {
    return this.tasksService.findByProject(projectId, req.agentScope?.agentId);
  }

  /**
   * MUN-0052 (DEC-AUP-0029) — a project's task index for an agent key named in
   * `project-read-grants.ts`: every task's id, parent, status, priority, actor
   * type, timestamps and title hash, plus `total`, what it counts, and the id of
   * the activity row this read wrote. The guard answers 404 to a key without a
   * live grant, exactly as to a project outside its workspace.
   *
   * A JWT is refused here: a user already has the full list on the route above,
   * and an index that a missing scope would silently serve unnarrowed is the
   * failure mode the allowlist exists to prevent.
   */
  @Get('project/:projectId/index')
  @AgentScope('project-index')
  indexForProject(
    @Param('projectId') projectId: string,
    @Req() req: AuthRequest,
  ) {
    const scope = req.agentScope;
    if (!scope || scope.kind !== 'project-index' || !scope.projectReadGrant) {
      throw new ForbiddenException('The task index is available only to an agent API key holding a read grant (MUN-0052).');
    }
    return this.tasksService.indexForProject(projectId, scope.agentId, scope.projectReadGrant);
  }

  /**
   * MUN-0040: turns "this task has been in_progress too long" into a number.
   * Tri-valued on purpose — `not_measured` for any in_progress task with no
   * MUN-0020 execution-authority recording is never reported as healthy or
   * stalled (see TaskStalenessService header). Same agent-key narrowing as
   * `findByProject` above, for the same cross-tenant reason (MUN-0043).
   */
  @Get('project/:projectId/staleness')
  @AgentScope('project')
  getStalenessReport(
    @Param('projectId') projectId: string,
    @Req() req: AuthRequest,
    @Query('thresholdHours') thresholdHours?: string,
  ) {
    const thresholdMs = thresholdHours
      ? Number(thresholdHours) * 3_600_000
      : undefined;
    return this.stalenessService.reportForProject(
      projectId,
      thresholdMs,
      req.agentScope?.agentId,
    );
  }

  /** Transitionable by an agent's API key or by a JWT.
   *
   *  MUN-0050 — scoped `'task-status'`, no longer `'task'`. Under `'task'`
   *  (MUN-0043) the key needed a `task_agents` row, and a task the agent
   *  itself CREATED through `POST /tasks` (MUN-0045) never gets one: measured
   *  live, every work item the fleet registered on 2026-09-13 answered 403
   *  "not assigned" to the key that created it and stayed `todo` after its
   *  work was merged and deployed. `'task-status'` admits the creator
   *  (`created_by_id` + `actor_type = 'agent'`, both recorded server-side from
   *  the credential) or an `executor` assignment, inside the agent's own
   *  workspace, and nothing else — a lead/reviewer assignment no longer moves
   *  a card. The state machine, the activity log and the actor recorded on it
   *  are unchanged: `ActorInterceptor` resolves the key to an `agent` actor,
   *  the service holds every caller to `TASK_TRANSITIONS` (no `done` without
   *  `review`), and a same-status repeat answers 200 `idempotent: true`
   *  without writing — see `TasksService.updateStatus`. */
  @Patch(':taskId/status')
  @AgentScope('task-status')
  updateStatus(
    @Param('taskId') taskId: string,
    @Req() req: AuthRequest,
    @Body() dto: UpdateTaskStatusDto,
  ) {
    return this.tasksService.updateStatus(taskId, req.actor, dto);
  }

  /** MUN-0049. Removes one secret-shaped span, named by scanner rule and
   *  sha256, from the title or description. 201 with the record on the first
   *  call, 200 `idempotent: true` on a repeat, 409 `SPAN_NOT_FOUND` when the
   *  hash is not in the current value. Reachable by the assigned agent's API
   *  key (`'task-redaction'` scope) or by a JWT; attributed to `req.actor`. */
  @Post(':taskId/redactions')
  @AgentScope('task-redaction')
  async redact(
    @Param('taskId') taskId: string,
    @Req() req: AuthRequest,
    @Body() dto: RedactFieldDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { statusCode, body } = await this.redactionService.redact(taskId, req.actor, dto);
    res.status(statusCode);
    return body;
  }

  @Delete(':taskId')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param('taskId') taskId: string, @Req() req: AuthRequest) {
    return this.tasksService.delete(taskId, req.actor);
  }

  // --- Checklist ---

  @Get(':taskId/checklist')
  getChecklist(@Param('taskId') taskId: string) {
    return this.tasksService.getChecklist(taskId);
  }

  @Post(':taskId/checklist')
  addChecklistItem(
    @Param('taskId') taskId: string,
    @Body() dto: CreateChecklistItemDto,
  ) {
    return this.tasksService.addChecklistItem(taskId, dto);
  }

  @Patch(':taskId/checklist/:itemId')
  toggleChecklistItem(
    @Param('taskId') taskId: string,
    @Param('itemId') itemId: string,
    @Body() body: { checked: boolean },
  ) {
    return this.tasksService.toggleChecklistItem(taskId, itemId, body.checked);
  }

  @Delete(':taskId/checklist/:itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteChecklistItem(
    @Param('taskId') taskId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.tasksService.deleteChecklistItem(taskId, itemId);
  }

  // --- Dependencies ---

  @Get(':taskId/dependencies')
  getDependencies(@Param('taskId') taskId: string) {
    return this.tasksService.getDependencies(taskId);
  }

  @Post(':taskId/dependencies')
  addDependency(
    @Param('taskId') taskId: string,
    @Body() dto: AddDependencyDto,
  ) {
    return this.tasksService.addDependency(taskId, dto);
  }

  @Delete(':taskId/dependencies/:depId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeDependency(@Param('depId') depId: string) {
    return this.tasksService.removeDependency(depId);
  }

  // --- Comments (activity log entries) ---

  /** Postable by the assigned agent's API key (MUN-0046) or by a JWT. Attributed
   *  to `req.actor`, resolved from the credential — the DTO carries no field a
   *  caller could use to claim a different principal. */
  @Post(':taskId/comments')
  @AgentScope('task')
  addComment(
    @Param('taskId') taskId: string,
    @Req() req: AuthRequest,
    @Body() dto: AddCommentDto,
  ) {
    return this.tasksService.addComment(taskId, req.actor, dto.body);
  }

  /** Readable by the assigned agent's API key (MUN-0047) or by a JWT. Returns
   *  the full `ActivityLog` rows for the task, comment bodies included — this
   *  is the only read surface for a comment an agent key posted (MUN-0046),
   *  and there is no separate comments route to keep in sync with this one. */
  @Get(':taskId/activity')
  @AgentScope('task')
  getActivity(
    @Param('taskId') taskId: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    return this.tasksService.getActivity(
      taskId,
      parseInt(page, 10),
      parseInt(limit, 10),
    );
  }
}
