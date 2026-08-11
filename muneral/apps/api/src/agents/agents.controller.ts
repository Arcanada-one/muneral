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
import { Request } from 'express';
import { AgentsService } from './agents.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { AssignAgentDto } from './dto/assign-agent.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { ActorInterceptor } from '../common/interceptors/actor.interceptor';
import { Agent } from './entities/agent.entity';

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

  @Post('tasks/:taskId/assign')
  @UseGuards(JwtAuthGuard)
  assignToTask(@Param('taskId') taskId: string, @Body() dto: AssignAgentDto) {
    return this.agentsService.assignToTask(taskId, dto);
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

  @Delete('keys/:keyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  revokeApiKey(@Param('keyId') keyId: string) {
    return this.agentsService.revokeApiKey(keyId);
  }
}
