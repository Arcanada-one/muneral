import { IsUUID, IsIn } from 'class-validator';
import type { TaskAgentRole } from '@muneral/types';

export class AssignAgentDto {
  @IsUUID()
  agentId: string;

  @IsIn(['lead', 'reviewer', 'executor'])
  role: TaskAgentRole;
}
