import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Actor } from '@muneral/types';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard.js';
import { AgentTaskScopeGuard } from '../auth/guards/agent-task-scope.guard.js';
import { HumanTaskReadGuard } from '../auth/guards/human-task-read.guard.js';
import { AgentScope } from '../auth/agent-scope.decorator.js';
import { ActorInterceptor } from '../common/interceptors/actor.interceptor.js';
import { CommandAssociationService } from './command-association.service.js';
import { PlanGraphService } from './plan-graph.service.js';
import { AssociateCommandDto } from './dto/associate-command.dto.js';
import {
  BindPlanLeaseDto,
  PlanReadinessDto,
  PutPlanRevisionDto,
} from './dto/put-plan-revision.dto.js';
import { TasksService } from '../tasks/tasks.service.js';

type AuthRequest = Request & { actor: Actor };

/**
 * KCLIVE-10 surfaces:
 * - durable command association (create/run)
 * - owner-managed plan revision CAS + lease + readiness + exact readback
 */
@Controller()
@UseGuards(JwtOrApiKeyGuard, AgentTaskScopeGuard, HumanTaskReadGuard)
@UseInterceptors(ActorInterceptor)
export class PlanGraphController {
  constructor(
    private readonly commands: CommandAssociationService,
    private readonly plans: PlanGraphService,
    private readonly tasks: TasksService,
  ) {}

  /**
   * Associate (and optionally create) under a durable idempotency key.
   * Same key+normalized content → same root; different content → 409.
   */
  @Post('tasks/commands')
  @AgentScope('project-write')
  @HttpCode(HttpStatus.OK)
  async associateCommand(
    @Req() req: AuthRequest,
    @Body() dto: AssociateCommandDto,
  ) {
    const claimed = await this.commands.claim(req.actor, {
      operation: dto.operation,
      projectId: dto.projectId,
      idempotencyKey: dto.idempotencyKey,
      command: {
        title: dto.command.title,
        description: dto.command.description ?? null,
        parentId: dto.command.parentId ?? null,
        sprintId: dto.command.sprintId ?? null,
        status: dto.command.status ?? null,
        priority: dto.command.priority ?? null,
        contractDigest: dto.command.contractDigest ?? null,
        tags: dto.command.tags ?? [],
      },
      rootTaskId: dto.rootTaskId ?? null,
      runId: dto.runId ?? null,
    });

    if (claimed.replayed) {
      return {
        replayed: true,
        commandDigest: claimed.commandDigest,
        rootTaskId: claimed.rootTaskId,
        runId: claimed.runId,
        response: claimed.response,
      };
    }

    if (dto.operation === 'task.create' || dto.operation === 'task.create_child') {
      const task = await this.tasks.create(req.actor, {
        projectId: dto.projectId,
        parentId: dto.command.parentId,
        sprintId: dto.command.sprintId,
        title: dto.command.title,
        description: dto.command.description,
        status: dto.command.status as never,
        priority: dto.command.priority as never,
        contractDigest: dto.command.contractDigest as never,
        tags: dto.command.tags,
      });

      const response = {
        id: task.id,
        projectId: task.projectId,
        parentId: task.parentId,
        title: task.title,
        status: task.status,
      };
      await this.commands.complete(req.actor, {
        operation: dto.operation,
        projectId: dto.projectId,
        idempotencyKey: dto.idempotencyKey,
        rootTaskId: task.id,
        runId: dto.runId ?? null,
        response,
      });
      return {
        replayed: false,
        commandDigest: claimed.commandDigest,
        rootTaskId: task.id,
        runId: dto.runId ?? null,
        response,
      };
    }

    // run.associate — bind an existing root without creating
    if (!dto.rootTaskId) {
      return {
        replayed: false,
        commandDigest: claimed.commandDigest,
        rootTaskId: null,
        runId: dto.runId ?? null,
        response: {},
        status: 'claimed_pending_root',
      };
    }
    await this.commands.complete(req.actor, {
      operation: dto.operation,
      projectId: dto.projectId,
      idempotencyKey: dto.idempotencyKey,
      rootTaskId: dto.rootTaskId,
      runId: dto.runId ?? null,
      response: { rootTaskId: dto.rootTaskId, runId: dto.runId ?? null },
    });
    return {
      replayed: false,
      commandDigest: claimed.commandDigest,
      rootTaskId: dto.rootTaskId,
      runId: dto.runId ?? null,
      response: { rootTaskId: dto.rootTaskId, runId: dto.runId ?? null },
    };
  }

  @Get('tasks/:taskId/plan')
  @AgentScope('task')
  getPlan(@Param('taskId') taskId: string) {
    return this.plans.getAuthoritativeSnapshot(taskId);
  }

  @Put('tasks/:taskId/plan')
  @AgentScope('task')
  putPlan(
    @Req() req: AuthRequest,
    @Param('taskId') taskId: string,
    @Body() dto: PutPlanRevisionDto,
  ) {
    return this.plans.putRevision(req.actor, {
      rootTaskId: taskId,
      expectedRevision: dto.expectedRevision,
      nodes: dto.nodes,
      edges: dto.edges,
      cursor: dto.cursor,
      sourceBindings: dto.sourceBindings,
      leaseHolder: dto.leaseHolder,
    });
  }

  @Post('tasks/:taskId/plan/lease')
  @AgentScope('task')
  @HttpCode(HttpStatus.OK)
  bindLease(@Param('taskId') taskId: string, @Body() dto: BindPlanLeaseDto) {
    return this.plans.bindLease(taskId, {
      expectedRevision: dto.expectedRevision,
      expectedPlanDigest: dto.expectedPlanDigest,
      leaseHolder: dto.leaseHolder,
      leaseExpiresAt: new Date(dto.leaseExpiresAt),
    });
  }

  @Post('tasks/:taskId/plan/readiness')
  @AgentScope('task')
  @HttpCode(HttpStatus.OK)
  planReadiness(
    @Param('taskId') taskId: string,
    @Body() dto: PlanReadinessDto,
  ) {
    return this.plans.planReadiness(taskId, dto.nodeId, dto.states);
  }
}
