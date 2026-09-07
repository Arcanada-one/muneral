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
} from '@nestjs/common';
import { Request, Response } from 'express';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { AddDependencyDto } from './dto/add-dependency.dto';
import { CreateChecklistItemDto } from './dto/create-checklist-item.dto';
import { AddCommentDto } from './dto/add-comment.dto';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard';
import {
  AgentScopeContext,
  AgentTaskScopeGuard,
} from '../auth/guards/agent-task-scope.guard';
import { AgentScope } from '../auth/agent-scope.decorator';
import { ActorInterceptor } from '../common/interceptors/actor.interceptor';
import { Actor } from '@muneral/types';
import { FieldChangesService } from './field-state/field-changes.service';

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
 * marker — delete, checklists, dependencies, comments — stay exactly as
 * JWT-only as they were; the only visible difference is that a valid key is now
 * told 403 instead of 401.
 *
 * MUN-0045 — `POST /tasks` (`create`) is the one exception: it is now marked
 * `@AgentScope('project-write')`, because task creation with a `mun_sk_` key
 * was blocked entirely (403, unmarked route) and AUP-E30 needs an agent to be
 * able to register its own work. The scope binds the key to projects inside
 * its own workspace — see the decorator's doc comment for what it does and
 * does not grant.
 */
@Controller('tasks')
@UseGuards(JwtOrApiKeyGuard, AgentTaskScopeGuard)
@UseInterceptors(ActorInterceptor)
export class TasksController {
  constructor(
    private readonly tasksService: TasksService,
    private readonly fieldChangesService: FieldChangesService,
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

  /** Transitionable by the assigned agent's API key (MUN-0043) or by a JWT.
   *  The state machine, the activity log and the actor recorded on it are
   *  unchanged — `ActorInterceptor` already resolves an API key to an `agent`
   *  actor, so the move is attributed to the agent, not to a human. */
  @Patch(':taskId/status')
  @AgentScope('task')
  updateStatus(
    @Param('taskId') taskId: string,
    @Req() req: AuthRequest,
    @Body() dto: UpdateTaskStatusDto,
  ) {
    return this.tasksService.updateStatus(taskId, req.actor, dto);
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

  @Post(':taskId/comments')
  addComment(
    @Param('taskId') taskId: string,
    @Req() req: AuthRequest,
    @Body() dto: AddCommentDto,
  ) {
    return this.tasksService.addComment(taskId, req.actor, dto.body);
  }

  @Get(':taskId/activity')
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
