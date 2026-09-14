import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  UseInterceptors,
  HttpCode,
  HttpStatus,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { AgentsService } from './agents.service.js';
import { CreateAgentDto } from './dto/create-agent.dto.js';
import { AssignAgentDto } from './dto/assign-agent.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { ApiKeyGuard } from '../auth/guards/api-key.guard.js';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard.js';
import { AgentTaskScopeGuard } from '../auth/guards/agent-task-scope.guard.js';
import type { AgentScopedRequest } from '../auth/guards/agent-task-scope.guard.js';
import { AgentScope } from '../auth/agent-scope.decorator.js';
import { ActorInterceptor } from '../common/interceptors/actor.interceptor.js';
import { Agent } from '@prisma/client';
import type { Actor } from '@muneral/types';

/**
 * Agents management, task assignment, and API key lifecycle.
 */
@Controller('agents')
@UseInterceptors(ActorInterceptor)
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  register(@Body() dto: CreateAgentDto) {
    return this.agentsService.register(dto);
  }

  @Get('workspace/:workspaceId')
  @UseGuards(JwtAuthGuard)
  findByWorkspace(@Param('workspaceId') workspaceId: string) {
    return this.agentsService.findByWorkspace(workspaceId);
  }

  /** Called by agent itself using API Key */
  @Get('tasks')
  @UseGuards(ApiKeyGuard)
  getMyTasks(@Req() req: Request & { apiKeyAgent: Agent }) {
    return this.agentsService.getAgentTasks(req.apiKeyAgent.id);
  }

  /**
   * Called by the human dashboard (JWT) or by an agent's long-lived API key.
   *
   * MUN-0051: the key is scoped (`'task-assign'`). Before, `JwtOrApiKeyGuard`
   * alone let any valid key assign any agent to any task with any role — and
   * since MUN-0050 an executor row moves status. A key now assigns only on a
   * task it created or executes, never above its own role, and only agents of
   * its own workspace (AgentTaskScopeGuard.assertMayAssign). A JWT is not
   * narrowed. Every assignment writes a `task:agent_assigned` activity row.
   */
  @Post('tasks/:taskId/assign')
  @UseGuards(JwtOrApiKeyGuard, AgentTaskScopeGuard)
  @AgentScope('task-assign')
  assignToTask(
    @Param('taskId') taskId: string,
    @Body() dto: AssignAgentDto,
    @Req() req: AgentScopedRequest & { actor: Actor },
  ) {
    return this.agentsService.assignToTask(taskId, dto, req.actor, req.agentScope?.assignBasis);
  }

  @Delete('tasks/:taskId/assign/:agentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  removeFromTask(
    @Param('taskId') taskId: string,
    @Param('agentId') agentId: string,
  ) {
    return this.agentsService.removeFromTask(taskId, agentId);
  }

  // --- API Key lifecycle ---

  @Post(':agentId/keys')
  @UseGuards(JwtAuthGuard)
  createApiKey(
    @Param('agentId') agentId: string,
    @Body() body: { label?: string },
  ) {
    return this.agentsService.createApiKey(agentId, body.label);
  }

  @Post('keys/:keyId/rotate')
  @UseGuards(JwtAuthGuard)
  rotateApiKey(@Param('keyId') keyId: string) {
    return this.agentsService.rotateApiKey(keyId);
  }

  /**
   * MUN-0053 — the fleet's emergency path: a key revokes itself. Agent key only;
   * no id in the path or body, so it cannot name any other key. After the 200
   * the same key answers 401 everywhere, this route included.
   */
  @Post('keys/self/revoke')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApiKeyGuard)
  revokeOwnApiKey(@Req() req: Request & { apiKeyAgent: Agent; apiKeyId: string }) {
    return this.agentsService.revokeOwnApiKey(req.apiKeyId, req.apiKeyAgent);
  }

  @Delete('keys/:keyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  revokeApiKey(@Param('keyId') keyId: string) {
    return this.agentsService.revokeApiKey(keyId);
  }
}
