import { IsIn } from 'class-validator';
import type { WorkspaceMemberRole } from '@muneral/types';

export class UpdateMemberRoleDto {
  @IsIn(['owner', 'manager', 'developer', 'viewer'])
  role: WorkspaceMemberRole;
}
