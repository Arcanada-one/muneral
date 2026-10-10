import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Request } from 'express';
import { WorkspacesService } from './workspaces.service.js';
import { CreateWorkspaceDto } from './dto/create-workspace.dto.js';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto.js';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard.js';
import { AgentTaskScopeGuard } from '../auth/guards/agent-task-scope.guard.js';
import type { AgentScopeContext } from '../auth/guards/agent-task-scope.guard.js';
import { AgentScope } from '../auth/agent-scope.decorator.js';
import { WorkspaceMemberGuard } from '../common/guards/workspace-member.guard.js';
import { WorkspaceRoleGuard } from '../common/guards/workspace-role.guard.js';
import { ActorInterceptor } from '../common/interceptors/actor.interceptor.js';
import { UseInterceptors } from '@nestjs/common';
import type { Actor } from '@muneral/types';
import { User } from '@prisma/client';

type AuthRequest = Request & { user: User; actor?: Actor; agentScope?: AgentScopeContext };

/**
 * Workspaces CRUD and member management.
 */
@Controller('workspaces')
@UseGuards(JwtOrApiKeyGuard, AgentTaskScopeGuard)
@UseInterceptors(ActorInterceptor)
export class WorkspacesController {
  constructor(private readonly workspacesService: WorkspacesService) {}

  @Post()
  create(@Req() req: AuthRequest, @Body() dto: CreateWorkspaceDto) {
    return this.workspacesService.create(req.user.id, dto);
  }

  @Get()
  @AgentScope('workspace-metadata')
  findAll(@Req() req: AuthRequest) {
    if (req.agentScope?.workspaceId) return this.workspacesService.findMetadataForAgent(req.agentScope.workspaceId);
    return this.workspacesService.findAllForUser(req.user.id);
  }

  @Get(':workspaceId')
  @UseGuards(WorkspaceMemberGuard)
  findOne(@Param('workspaceId') workspaceId: string) {
    return this.workspacesService.findOne(workspaceId);
  }

  @Get(':workspaceId/members')
  @UseGuards(WorkspaceMemberGuard)
  listMembers(@Param('workspaceId') workspaceId: string) {
    return this.workspacesService.listMembers(workspaceId);
  }

  @Post(':workspaceId/members/:userId')
  @UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard('manager'))
  addMember(
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
  ) {
    return this.workspacesService.addMember(workspaceId, userId);
  }

  @Patch(':workspaceId/members/:userId/role')
  @UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard('owner'))
  updateMemberRole(
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
    @Body() dto: UpdateMemberRoleDto,
    @Req() req: AuthRequest,
  ) {
    return this.workspacesService.updateMemberRole(
      workspaceId,
      userId,
      dto.role,
      req.user.id,
    );
  }

  @Delete(':workspaceId/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard('manager'))
  removeMember(
    @Param('workspaceId') workspaceId: string,
    @Param('userId') userId: string,
  ) {
    return this.workspacesService.removeMember(workspaceId, userId);
  }
}
