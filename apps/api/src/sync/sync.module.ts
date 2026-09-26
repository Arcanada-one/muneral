import { Module } from '@nestjs/common';
import { SyncService } from './sync.service.js';
import { SyncController } from './sync.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { TasksModule } from '../tasks/tasks.module.js';
import { ActivityModule } from '../activity/activity.module.js';

@Module({
  imports: [AuthModule, ActivityModule, TasksModule],
  controllers: [SyncController],
  providers: [SyncService],
  exports: [SyncService],
})
export class SyncModule {}