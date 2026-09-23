import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiKeyGuard } from '../../auth/guards/api-key.guard.js';
import { AgentTaskScopeGuard } from '../../auth/guards/agent-task-scope.guard.js';
import type { AgentScopeContext } from '../../auth/guards/agent-task-scope.guard.js';
import { AgentScope } from '../../auth/agent-scope.decorator.js';
import { FieldChangesService } from './field-changes.service.js';
import type { AckBody } from './field-changes.service.js';
import { Agent } from '@prisma/client';

type ApiKeyRequest = Request & { apiKeyAgent: Agent; agentScope?: AgentScopeContext };

/**
 * FieldChangesController — per-agent field-change tracking endpoints.
 * Authenticated by API key (agent identity), NOT JWT.
 *
 * MUN-0043: both routes now also pass `AgentTaskScopeGuard` under
 * `@AgentScope('task-workspace')`. Before, neither checked ownership at all, so
 * a valid key from any workspace could read another workspace's task field
 * VALUES through `field-changes`. The workspace boundary is now enforced; the
 * weaker 'task-workspace' scope rather than 'task' is deliberate and explained
 * on the guard.
 */
@Controller('tasks')
@UseGuards(ApiKeyGuard, AgentTaskScopeGuard)
export class FieldChangesController {
  constructor(private readonly fieldChangesService: FieldChangesService) {}

  /**
   * GET /tasks/:taskId/field-changes?agentId=X
   * Returns per-field change status for the requesting agent.
   * changed=true when version > agent's lastSeenVersion.
   * agentId query param is ignored — always uses authenticated agent's ID.
   */
  @Get(':taskId/field-changes')
  @AgentScope('task-workspace')
  getFieldChanges(
    @Param('taskId') taskId: string,
    @Req() req: ApiKeyRequest,
  ) {
    return this.fieldChangesService.getFieldChanges({
      taskId,
      agentId: req.apiKeyAgent.id,
      // MUN-0055 (DEC-AUP-0033 R4): the guard decided this, not the handler —
      // the same place every other scope decision is made.
      withholdFreeTextValues: req.agentScope?.withholdFreeTextValues === true,
    });
  }

  /**
   * POST /tasks/:taskId/field-ack
   * Upsert agent watermarks for listed fields.
   * IDOR guard: body.agentId must equal req.apiKeyAgent.id.
   * 204 on success.
   */
  @Post(':taskId/field-ack')
  @AgentScope('task-workspace')
  @HttpCode(HttpStatus.NO_CONTENT)
  ackFieldChanges(
    @Param('taskId') taskId: string,
    @Body() body: AckBody,
    @Req() req: ApiKeyRequest,
  ) {
    return this.fieldChangesService.ackFields(taskId, req.apiKeyAgent.id, body);
  }
}
