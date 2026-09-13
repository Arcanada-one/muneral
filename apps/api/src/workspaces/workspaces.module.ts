import { Module } from '@nestjs/common';
import { WorkspacesService } from './workspaces.service.js';
import { WorkspacesController } from './workspaces.controller.js';
import { WorkspaceMemberGuard } from '../common/guards/workspace-member.guard.js';

@Module({
  controllers: [WorkspacesController],
  providers: [WorkspacesService, WorkspaceMemberGuard],
  exports: [WorkspacesService, WorkspaceMemberGuard],
})
export class WorkspacesModule {}
