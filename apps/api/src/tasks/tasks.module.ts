import { Module } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { FieldChangesController } from './field-state/field-changes.controller';
import { ActivityModule } from '../activity/activity.module';
import { WsModule } from '../ws/ws.module';
import { TaskFieldStateService } from './field-state/task-field-state.service';
import { FieldChangesService } from './field-state/field-changes.service';
import { AuthModule } from '../auth/auth.module';
import { ExecutionAuthorityModule } from '../execution-authority/execution-authority.module';
import { TaskExecutionRecorderService } from '../execution-authority/task-execution-recorder.service';
import { TaskStalenessService } from '../execution-authority/task-staleness.service';

@Module({
  imports: [ActivityModule, WsModule, AuthModule, ExecutionAuthorityModule],
  controllers: [TasksController, FieldChangesController],
  providers: [
    TasksService,
    TaskFieldStateService,
    FieldChangesService,
    TaskExecutionRecorderService,
    TaskStalenessService,
  ],
  exports: [TasksService, TaskFieldStateService, FieldChangesService],
})
export class TasksModule {}
