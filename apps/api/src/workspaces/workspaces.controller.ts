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
import { Request } from 'express';
import { WorkspacesService } from './workspaces.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkspaceMemberGuard } from '../common/guards/workspace-member.guard';
import { WorkspaceRoleGuard } from '../common/guards/workspace-role.guard';
import { ActorInterceptor } from '../common/interceptors/actor.interceptor';
import { UseInterceptors } from '@nestjs/common';
import { Actor } from '@muneral/types';
import { User } from '../common/entities/user.entity';

type AuthRequest = Request & { user: User; actor?: Actor };

/**
 * Workspaces CRUD and member management.
 */
@Controller('workspaces')
@UseGuards(JwtAuthGuard)
@UseInterceptors(ActorInterceptor)
export class WorkspacesController {
  constructor(private readonly workspacesService: WorkspacesService) {}

  @Post()
  create(@Req() req: AuthRequest, @Body() dto: CreateWorkspaceDto) {
    return this.workspacesService.create(req.user.id, dto);
  }

  @Get()
  findAll(@Req() req: AuthRequest) {
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
