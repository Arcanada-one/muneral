import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Agent } from '@prisma/client';
import type { Request } from 'express';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { SolutionLogHeadService } from './solution-log-head.service';

type ApiKeyRequest = Request & { apiKeyAgent: Agent };

@Controller('tasks')
@UseGuards(ApiKeyGuard)
export class SolutionLogHeadController {
  constructor(private readonly service: SolutionLogHeadService) {}

  @Post(':taskId/attempts/:attemptId/solution-log-heads')
  commitHead(
    @Param('taskId') taskId: string,
    @Param('attemptId') attemptId: string,
    @Body() body: unknown,
    @Req() req: ApiKeyRequest,
  ) {
    return this.service.commitHead(
      taskId,
      attemptId,
      req.apiKeyAgent.id,
      body,
    );
  }

  @Get(':taskId/attempts/:attemptId/solution-log-head')
  getCurrentHead(
    @Param('taskId') taskId: string,
    @Param('attemptId') attemptId: string,
    @Req() req: ApiKeyRequest,
  ) {
    return this.service.getCurrentHead(taskId, attemptId, req.apiKeyAgent.id);
  }
}
