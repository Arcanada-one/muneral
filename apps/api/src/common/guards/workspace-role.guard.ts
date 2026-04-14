import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  SetMetadata,
  mixin,
} from '@nestjs/common';
import { Request } from 'express';
import { WorkspaceMember } from '../../workspaces/entities/workspace-member.entity';
import { WorkspaceMemberRole, hasRole } from '@muneral/types';

/**
 * WorkspaceRoleGuard factory — creates a guard that verifies the caller
 * has at least the required role in the workspace.
 *
 * Usage: @UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard('developer'))
 */
export function WorkspaceRoleGuard(requiredRole: WorkspaceMemberRole) {
  @Injectable()
  class RoleGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const req = context.switchToHttp().getRequest<
        Request & { workspaceMember?: WorkspaceMember }
      >();

      const member = req.workspaceMember;
      if (!member) {
        throw new ForbiddenException('Workspace membership not resolved');
      }

      if (!hasRole(member.role, requiredRole)) {
        throw new ForbiddenException(
          `Requires at least '${requiredRole}' role`,
        );
      }

      return true;
    }
  }

  return mixin(RoleGuard);
}
