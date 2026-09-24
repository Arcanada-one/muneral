import { Module } from '@nestjs/common';
import { TasksService } from './tasks.service.js';
import { TasksController } from './tasks.controller.js';
import { FieldChangesController } from './field-state/field-changes.controller.js';
import { ActivityModule } from '../activity/activity.module.js';
import { WsModule } from '../ws/ws.module.js';
import { TaskFieldStateService } from './field-state/task-field-state.service.js';
import { FieldChangesService } from './field-state/field-changes.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { ExecutionAuthorityModule } from '../execution-authority/execution-authority.module.js';
import { TaskExecutionRecorderService } from '../execution-authority/task-execution-recorder.service.js';
import { TaskStalenessService } from '../execution-authority/task-staleness.service.js';
import { TaskRedactionService } from './redactions/task-redaction.service.js';
import { TaskEvidenceService } from './evidence/task-evidence.service.js';

@Module({
  imports: [ActivityModule, WsModule, AuthModule, ExecutionAuthorityModule],
  controllers: [TasksController, FieldChangesController],
  providers: [
    TasksService,
    TaskFieldStateService,
    FieldChangesService,
    TaskExecutionRecorderService,
    TaskStalenessService,
    TaskRedactionService,
    TaskEvidenceService,
  ],
  exports: [TasksService, TaskFieldStateService, FieldChangesService],
})
export class TasksModule {}
