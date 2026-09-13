import { Module } from '@nestjs/common';
import { ActivityService } from './activity.service.js';

@Module({
  providers: [ActivityService],
  exports: [ActivityService],
})
export class ActivityModule {}
