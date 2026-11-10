import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { HumanTaskReadGuard } from '../auth/guards/human-task-read.guard.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { CommandAssociationService } from './command-association.service.js';
import { PlanGraphController } from './plan-graph.controller.js';
import { PlanGraphService } from './plan-graph.service.js';
import { ProjectMembershipService } from './project-membership.service.js';

@Module({
  imports: [AuthModule, TasksModule],
  controllers: [PlanGraphController],
  providers: [
    HumanTaskReadGuard,
    CommandAssociationService,
    PlanGraphService,
    ProjectMembershipService,
  ],
  exports: [
    CommandAssociationService,
    PlanGraphService,
    ProjectMembershipService,
  ],
})
export class PlanGraphModule {}
