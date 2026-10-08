import { Module } from '@nestjs/common';
import { SyncService } from './sync.service.js';
import { SyncController } from './sync.controller.js';
import { HumanTaskReadGuard } from '../auth/guards/human-task-read.guard.js';
import { AuthModule } from '../auth/auth.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { ActivityModule } from '../activity/activity.module.js';

@Module({
  imports: [AuthModule, ActivityModule, TasksModule],
  controllers: [SyncController],
  providers: [SyncService, HumanTaskReadGuard],
  exports: [SyncService],
})
export class SyncModule {}