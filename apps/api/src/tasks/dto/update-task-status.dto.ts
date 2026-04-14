import { IsIn } from 'class-validator';
import { TaskStatus } from '@muneral/types';

export class UpdateTaskStatusDto {
  @IsIn(['todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled'])
  status: TaskStatus;
}
