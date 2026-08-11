import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityLog } from './entities/activity-log.entity';
import { ActivityService } from './activity.service';

@Module({
  imports: [TypeOrmModule.forFeature([ActivityLog])],
  providers: [ActivityService],
  exports: [ActivityService],
})
export class ActivityModule {}
