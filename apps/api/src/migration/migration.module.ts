import { TaskFieldStateService } from '../tasks/field-state/task-field-state.service.js';
import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { MigrationController } from './migration.controller.js';
import { MigrationService } from './migration.service.js';

@Module({
  imports: [AuthModule, ActivityModule],
  controllers: [MigrationController],
  providers: [MigrationService, TaskFieldStateService],
  exports: [MigrationService],
})
export class MigrationModule {}
