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
import { MilestonesService } from './milestones.service';
import { CreateMilestoneDto } from './dto/create-milestone.dto';
import { CreateSprintDto } from './dto/create-sprint.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ActorInterceptor } from '../common/interceptors/actor.interceptor';

/**
 * Milestones and Sprints CRUD.
 */
@Controller()
@UseGuards(JwtAuthGuard)
@UseInterceptors(ActorInterceptor)
export class MilestonesController {
  constructor(private readonly milestonesService: MilestonesService) {}

  @Post('milestones')
  createMilestone(@Body() dto: CreateMilestoneDto) {
    return this.milestonesService.createMilestone(dto);
  }

  @Get('projects/:projectId/milestones')
  getMilestones(@Param('projectId') projectId: string) {
    return this.milestonesService.getMilestones(projectId);
  }

  @Delete('milestones/:milestoneId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteMilestone(@Param('milestoneId') milestoneId: string) {
    return this.milestonesService.deleteMilestone(milestoneId);
  }

  @Post('sprints')
  createSprint(@Body() dto: CreateSprintDto) {
    return this.milestonesService.createSprint(dto);
  }

  @Get('projects/:projectId/sprints')
  getSprints(@Param('projectId') projectId: string) {
    return this.milestonesService.getSprints(projectId);
  }

  @Delete('sprints/:sprintId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteSprint(@Param('sprintId') sprintId: string) {
    return this.milestonesService.deleteSprint(sprintId);
  }
}
