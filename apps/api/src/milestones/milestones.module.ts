import { Module } from '@nestjs/common';
import { MilestonesService } from './milestones.service.js';
import { MilestonesController } from './milestones.controller.js';

@Module({
  controllers: [MilestonesController],
  providers: [MilestonesService],
  exports: [MilestonesService],
})
export class MilestonesModule {}
