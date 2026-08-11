import { IsUUID, IsIn } from 'class-validator';
import { TaskDependencyType } from '@muneral/types';

export class AddDependencyDto {
  @IsUUID()
  toTaskId: string;

  @IsIn(['depends_on', 'blocks', 'related_to', 'duplicates'])
  type: TaskDependencyType;
}
