import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '@muneral/types';

/**
 * WorkspaceMemberGuard — verifies the caller is a member of the workspace
 * referenced in the route params (:workspaceId or :workspaceSlug via lookup).
 * Attaches `req.workspaceMember` for downstream use.
 */
@Injectable()
export class WorkspaceMemberGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<
      Request & {
        actor?: Actor;
        workspaceMember?: object;
        params: { workspaceId?: string };
      }
    >();

    const actor = req.actor;
    if (!actor || actor.type !== 'human') {
      throw new ForbiddenException('Human authentication required');
    }

    const workspaceId = req.params['workspaceId'];
    if (!workspaceId) {
      throw new NotFoundException('Workspace ID required in route params');
    }

    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: actor.id } },
    });

    if (!member) {
      throw new ForbiddenException('Not a member of this workspace');
    }

    req.workspaceMember = member;
    return true;
  }
}
