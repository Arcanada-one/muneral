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
import { Request } from 'express';
import { ApiKeyGuard } from '../../auth/guards/api-key.guard';
import { FieldChangesService, AckBody } from './field-changes.service';
import { Agent } from '@prisma/client';

type ApiKeyRequest = Request & { apiKeyAgent: Agent };

/**
 * FieldChangesController — per-agent field-change tracking endpoints.
 * Authenticated by API key (agent identity), NOT JWT.
 */
@Controller('tasks')
@UseGuards(ApiKeyGuard)
export class FieldChangesController {
  constructor(private readonly fieldChangesService: FieldChangesService) {}

  /**
   * GET /tasks/:taskId/field-changes?agentId=X
   * Returns per-field change status for the requesting agent.
   * changed=true when version > agent's lastSeenVersion.
   * agentId query param is ignored — always uses authenticated agent's ID.
   */
  @Get(':taskId/field-changes')
  getFieldChanges(
    @Param('taskId') taskId: string,
    @Req() req: ApiKeyRequest,
  ) {
    return this.fieldChangesService.getFieldChanges({
      taskId,
      agentId: req.apiKeyAgent.id,
    });
  }

  /**
   * POST /tasks/:taskId/field-ack
   * Upsert agent watermarks for listed fields.
   * IDOR guard: body.agentId must equal req.apiKeyAgent.id.
   * 204 on success.
   */
  @Post(':taskId/field-ack')
  @HttpCode(HttpStatus.NO_CONTENT)
  ackFieldChanges(
    @Param('taskId') taskId: string,
    @Body() body: AckBody,
    @Req() req: ApiKeyRequest,
  ) {
    return this.fieldChangesService.ackFields(taskId, req.apiKeyAgent.id, body);
  }
}
