import { IsIn } from 'class-validator';
import { TASK_STATUSES, TaskStatus } from '@muneral/types';

export class UpdateTaskStatusDto {
  @IsIn(TASK_STATUSES)
  status: TaskStatus;
}
