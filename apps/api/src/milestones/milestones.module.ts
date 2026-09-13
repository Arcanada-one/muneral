import { Module } from '@nestjs/common';
import { MilestonesService } from './milestones.service.js';
import { MilestonesController } from './milestones.controller.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [AuthModule],
  controllers: [MilestonesController],
  providers: [MilestonesService],
  exports: [MilestonesService],
})
export class MilestonesModule {}
