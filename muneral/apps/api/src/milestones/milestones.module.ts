import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Milestone } from './entities/milestone.entity';
import { Sprint } from './entities/sprint.entity';
import { MilestonesService } from './milestones.service';
import { MilestonesController } from './milestones.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Milestone, Sprint])],
  controllers: [MilestonesController],
  providers: [MilestonesService],
  exports: [MilestonesService, TypeOrmModule],
})
export class MilestonesModule {}
