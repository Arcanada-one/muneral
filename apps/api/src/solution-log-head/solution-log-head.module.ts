import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SolutionLogHeadController } from './solution-log-head.controller.js';
import { SolutionLogHeadService } from './solution-log-head.service.js';

@Module({
  imports: [AuthModule],
  controllers: [SolutionLogHeadController],
  providers: [SolutionLogHeadService],
  exports: [SolutionLogHeadService],
})
export class SolutionLogHeadModule {}
