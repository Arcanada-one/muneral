import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SolutionLogHeadController } from './solution-log-head.controller';
import { SolutionLogHeadService } from './solution-log-head.service';

@Module({
  imports: [AuthModule],
  controllers: [SolutionLogHeadController],
  providers: [SolutionLogHeadService],
  exports: [SolutionLogHeadService],
})
export class SolutionLogHeadModule {}
