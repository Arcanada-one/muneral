import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { MigrationController } from './migration.controller.js';
import { MigrationService } from './migration.service.js';

@Module({
  imports: [AuthModule, ActivityModule],
  controllers: [MigrationController],
  providers: [MigrationService],
  exports: [MigrationService],
})
export class MigrationModule {}
