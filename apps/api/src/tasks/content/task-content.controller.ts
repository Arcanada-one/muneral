import { Body, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, Req, UseGuards, UseInterceptors, DefaultValuePipe } from '@nestjs/common';
import type { Request } from 'express';
import type { Actor } from '@muneral/types';
import { JwtOrApiKeyGuard } from '../../auth/guards/jwt-or-api-key.guard.js';
import { AgentTaskScopeGuard } from '../../auth/guards/agent-task-scope.guard.js';
import { HumanTaskReadGuard } from '../../auth/guards/human-task-read.guard.js';
import { AgentScope } from '../../auth/agent-scope.decorator.js';
import { ActorInterceptor } from '../../common/interceptors/actor.interceptor.js';
import { TaskContentService } from './task-content.service.js';
import { UploadArtifactDto } from './task-content.dto.js';

type AuthRequest = Request & { actor: Actor };

@Controller('tasks')
@UseGuards(JwtOrApiKeyGuard, AgentTaskScopeGuard, HumanTaskReadGuard)
@UseInterceptors(ActorInterceptor)
export class TaskContentController {
  constructor(private readonly content: TaskContentService) {}

  @Post(':taskId/artifacts')
  @AgentScope('task-evidence')
  upload(@Param('taskId', ParseUUIDPipe) taskId: string, @Req() req: AuthRequest, @Body() dto: UploadArtifactDto) {
    return this.content.uploadArtifact(taskId, req.actor, dto);
  }

  @Get(':taskId/artifacts')
  @AgentScope('task-evidence')
  list(@Param('taskId', ParseUUIDPipe) taskId: string, @Req() req: AuthRequest,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number) {
    return this.content.list(taskId, req.actor, 'artifact', page);
  }

  @Get(':taskId/artifacts/by-sha/:sha256')
  @AgentScope('task-evidence')
  bySha(@Param('taskId', ParseUUIDPipe) taskId: string, @Param('sha256') sha256: string, @Req() req: AuthRequest) {
    return this.content.get(taskId, req.actor, 'artifact', sha256, true);
  }

  @Get(':taskId/artifacts/:artifactId')
  @AgentScope('task-evidence')
  get(@Param('taskId', ParseUUIDPipe) taskId: string, @Param('artifactId', ParseUUIDPipe) artifactId: string, @Req() req: AuthRequest) {
    return this.content.get(taskId, req.actor, 'artifact', artifactId);
  }

}
