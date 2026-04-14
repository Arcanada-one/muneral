import { IsUUID, IsIn } from 'class-validator';
import { TaskAgentRole } from '@muneral/types';

export class AssignAgentDto {
  @IsUUID()
  agentId: string;

  @IsIn(['lead', 'reviewer', 'executor'])
  role: TaskAgentRole;
}
