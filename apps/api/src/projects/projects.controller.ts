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
} from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { AddGitRefDto } from './dto/add-git-ref.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActorInterceptor } from '../common/interceptors/actor.interceptor';

/**
 * Projects and git-refs management.
 */
@Controller('projects')
@UseGuards(JwtAuthGuard)
@UseInterceptors(ActorInterceptor)
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  create(@Body() dto: CreateProjectDto) {
    return this.projectsService.create(dto);
  }

  @Get('workspace/:workspaceId')
  findByWorkspace(@Param('workspaceId') workspaceId: string) {
    return this.projectsService.findByWorkspace(workspaceId);
  }

  @Get(':projectId')
  findOne(@Param('projectId') projectId: string) {
    return this.projectsService.findOne(projectId);
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
  getGitRefs(@Param('taskId') taskId: string) {
    return this.projectsService.getGitRefs(taskId);
  }

  @Delete('git-refs/:refId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeGitRef(@Param('refId') refId: string) {
    return this.projectsService.removeGitRef(refId);
  }
}
