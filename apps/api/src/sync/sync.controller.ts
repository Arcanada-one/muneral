import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  UseInterceptors,
  Header,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Actor } from '@muneral/types';
import { SyncService } from './sync.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { ApiKeyGuard } from '../auth/guards/api-key.guard.js';
import { AgentTaskScopeGuard } from '../auth/guards/agent-task-scope.guard.js';
import { AgentScope } from '../auth/agent-scope.decorator.js';
import { ActorInterceptor } from '../common/interceptors/actor.interceptor.js';

/**
 * Sync controller — Datarim tasks.md import/export.
 */
@Controller('sync')
@UseInterceptors(ActorInterceptor)
export class SyncController {
  constructor(private readonly syncService: SyncService) {}

  /** Export project tasks in Datarim tasks.md format */
  @Get('datarim/:projectId')
  @UseGuards(JwtAuthGuard)
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  async exportDatarim(@Param('projectId') projectId: string): Promise<string> {
    return this.syncService.exportDatarim(projectId);
  }

  /** Import tasks from Datarim markdown with an agent API key.
   *
   *  A2-379: before this change the route ran behind `ApiKeyGuard` alone, so
   *  any valid key of any workspace could write into any project. It now runs
   *  behind `AgentTaskScopeGuard` like every other agent route: the project
   *  must be in the key's workspace ('project', 404 otherwise), and
   *  SyncService holds each matched task to the 'task-status' rule and to
   *  TASK_TRANSITIONS. Authorship is `req.actor`, resolved from the key. */
  @Post('datarim/:projectId/import')
  @UseGuards(ApiKeyGuard, AgentTaskScopeGuard)
  @AgentScope('project')
  async importDatarim(
    @Param('projectId') projectId: string,
    @Req() req: Request & { actor?: Actor },
    @Body() body: { markdown: string },
  ) {
    return this.syncService.importDatarim(projectId, body?.markdown, req.actor);
  }
}
