import { IsIn } from 'class-validator';
import { TASK_STATUSES } from '@muneral/types';
import type { TaskStatus } from '@muneral/types';

export class UpdateTaskStatusDto {
  @IsIn(TASK_STATUSES)
  status: TaskStatus;
}
