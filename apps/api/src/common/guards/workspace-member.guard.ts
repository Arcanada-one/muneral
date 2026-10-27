import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Agent, User } from '@prisma/client';

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
        user?: User;
        apiKeyAgent?: Agent;
        workspaceMember?: object;
        params: { workspaceId?: string };
      }
    >();

    // Nest runs guards before interceptors, so `req.actor` (set by
    // ActorInterceptor) does not exist yet here. Resolve the caller from the
    // same request fields the interceptor reads, with the same precedence:
    // an API-key agent is never a human, even if `req.user` were also set.
    if (req.apiKeyAgent || !req.user) {
      throw new ForbiddenException('Human authentication required');
    }
    const userId = req.user.id;

    const workspaceId = req.params['workspaceId'];
    if (!workspaceId) {
      throw new NotFoundException('Workspace ID required in route params');
    }

    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });

    if (!member) {
      throw new ForbiddenException('Not a member of this workspace');
    }

    req.workspaceMember = member;
    return true;
  }
}
