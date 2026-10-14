import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { User } from '@prisma/client';

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
        workspaceMember?: object;
        params: { workspaceId?: string };
      }
    >();

    // Guards run before interceptors. ActorInterceptor populates req.actor,
    // so this guard must use the authenticated user that JwtOrApiKeyGuard
    // already placed on req.user rather than relying on req.actor here.
    const user = req.user;
    if (!user) {
      throw new ForbiddenException('Human authentication required');
    }

    const workspaceId = req.params['workspaceId'];
    if (!workspaceId) {
      throw new NotFoundException('Workspace ID required in route params');
    }

    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
    });

    if (!member) {
      throw new ForbiddenException('Not a member of this workspace');
    }

    req.workspaceMember = member;
    return true;
  }
}
