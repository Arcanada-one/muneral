import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Request } from 'express';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { AddDependencyDto } from './dto/add-dependency.dto';
import { CreateChecklistItemDto } from './dto/create-checklist-item.dto';
import { AddCommentDto } from './dto/add-comment.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActorInterceptor } from '../common/interceptors/actor.interceptor';
import { Actor } from '@muneral/types';

type AuthRequest = Request & { actor: Actor };

/**
 * Tasks CRUD with status state machine, checklists, dependencies, and comments.
 */
@Controller('tasks')
@UseGuards(JwtAuthGuard)
@UseInterceptors(ActorInterceptor)
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Post()
  create(@Req() req: AuthRequest, @Body() dto: CreateTaskDto) {
    return this.tasksService.create(req.actor, dto);
  }

  @Get(':taskId')
  findOne(@Param('taskId') taskId: string) {
    return this.tasksService.findOne(taskId);
  }

  @Get('project/:projectId')
  findByProject(@Param('projectId') projectId: string) {
    return this.tasksService.findByProject(projectId);
  }

  @Patch(':taskId/status')
  updateStatus(
    @Param('taskId') taskId: string,
    @Req() req: AuthRequest,
    @Body() dto: UpdateTaskStatusDto,
  ) {
    return this.tasksService.updateStatus(taskId, req.actor, dto);
  }

  @Delete(':taskId')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param('taskId') taskId: string, @Req() req: AuthRequest) {
    return this.tasksService.delete(taskId, req.actor);
  }

  // --- Checklist ---

  @Get(':taskId/checklist')
  getChecklist(@Param('taskId') taskId: string) {
    return this.tasksService.getChecklist(taskId);
  }

  @Post(':taskId/checklist')
  addChecklistItem(
    @Param('taskId') taskId: string,
    @Body() dto: CreateChecklistItemDto,
  ) {
    return this.tasksService.addChecklistItem(taskId, dto);
  }

  @Patch(':taskId/checklist/:itemId')
  toggleChecklistItem(
    @Param('taskId') taskId: string,
    @Param('itemId') itemId: string,
    @Body() body: { checked: boolean },
  ) {
    return this.tasksService.toggleChecklistItem(taskId, itemId, body.checked);
  }

  @Delete(':taskId/checklist/:itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteChecklistItem(
    @Param('taskId') taskId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.tasksService.deleteChecklistItem(taskId, itemId);
  }

  // --- Dependencies ---

  @Get(':taskId/dependencies')
  getDependencies(@Param('taskId') taskId: string) {
    return this.tasksService.getDependencies(taskId);
  }

  @Post(':taskId/dependencies')
  addDependency(
    @Param('taskId') taskId: string,
    @Body() dto: AddDependencyDto,
  ) {
    return this.tasksService.addDependency(taskId, dto);
  }

  @Delete(':taskId/dependencies/:depId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeDependency(@Param('depId') depId: string) {
    return this.tasksService.removeDependency(depId);
  }

  // --- Comments (activity log entries) ---

  @Post(':taskId/comments')
  addComment(
    @Param('taskId') taskId: string,
    @Req() req: AuthRequest,
    @Body() dto: AddCommentDto,
  ) {
    return this.tasksService.addComment(taskId, req.actor, dto.body);
  }

  @Get(':taskId/activity')
  getActivity(
    @Param('taskId') taskId: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    return this.tasksService.getActivity(
      taskId,
      parseInt(page, 10),
      parseInt(limit, 10),
    );
  }
}
