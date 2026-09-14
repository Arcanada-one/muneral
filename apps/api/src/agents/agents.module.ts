import { Module } from '@nestjs/common';
import { AgentsService } from './agents.service.js';
import { AgentsController } from './agents.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { ActivityModule } from '../activity/activity.module.js';

@Module({
  imports: [AuthModule, ActivityModule],
  controllers: [AgentsController],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
