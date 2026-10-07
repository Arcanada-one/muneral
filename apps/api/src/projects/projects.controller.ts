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
import { ProjectsService } from './projects.service.js';
import { CreateProjectDto } from './dto/create-project.dto.js';
import { AddGitRefDto } from './dto/add-git-ref.dto.js';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard.js';
import { AgentTaskScopeGuard } from '../auth/guards/agent-task-scope.guard.js';
import type { Request } from 'express';
import type { User } from '@prisma/client';
import { HumanTaskReadGuard } from '../auth/guards/human-task-read.guard.js';
import type { AgentScopedRequest } from '../auth/guards/agent-task-scope.guard.js';
import { AgentScope } from '../auth/agent-scope.decorator.js';
import { ActorInterceptor } from '../common/interceptors/actor.interceptor.js';

/**
 * Projects and git-refs management.
 */
@Controller('projects')
@UseGuards(JwtOrApiKeyGuard, AgentTaskScopeGuard)
@UseInterceptors(ActorInterceptor)
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  @AgentScope('project-create')
  create(@Body() dto: CreateProjectDto, @Req() req: AgentScopedRequest) {
    return this.projectsService.create(dto, !!req.agentScope);
  }

  @Get('workspace/:workspaceId')
  @AgentScope('workspace-metadata')
  findByWorkspace(@Param('workspaceId') workspaceId: string, @Req() req: AgentScopedRequest) {
    return this.projectsService.findByWorkspace(workspaceId, !!req.agentScope);
  }

  @Get(':projectId')
  @AgentScope('project-metadata')
  findOne(@Param('projectId') projectId: string, @Req() req: AgentScopedRequest) {
    return this.projectsService.findOne(projectId, req.agentScope?.workspaceId);
  }

  @Delete(':projectId')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param('projectId') projectId: string) {
    return this.projectsService.delete(projectId);
  }

  // --- Git refs ---

  @Post('git-refs')
  addGitRef(@Body() dto: AddGitRefDto) {
    return this.projectsService.addGitRef(dto);
  }

  @Get('tasks/:taskId/git-refs')
  @UseGuards(HumanTaskReadGuard)
  getGitRefs(@Param('taskId') taskId: string, @Req() req: Request & { user?: User }) {
    return this.projectsService.getGitRefs(taskId, req.user?.id);
  }

  @Delete('git-refs/:refId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeGitRef(@Param('refId') refId: string) {
    return this.projectsService.removeGitRef(refId);
  }
}
