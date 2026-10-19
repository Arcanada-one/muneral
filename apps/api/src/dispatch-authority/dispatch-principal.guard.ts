import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Agent, User } from '@prisma/client';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AgentScopeContext } from '../auth/guards/agent-task-scope.guard.js';
import type { DispatchPrincipal } from './dispatch-authority.types.js';

type DispatchRequest = Request & {
  user?: User;
  apiKeyAgent?: Agent;
  agentScope?: AgentScopeContext;
  dispatchPrincipal?: DispatchPrincipal;
};

/** Human membership rule for the new write surface. Agent task authorization
 * remains the existing `task-status` allowlist, evaluated immediately before
 * this guard by AgentTaskScopeGuard.
 */
@Injectable()
export class DispatchPrincipalGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<DispatchRequest>();
    const taskId = req.params['taskId'];

    if (req.apiKeyAgent) {
      if (typeof taskId !== 'string' || req.agentScope?.kind !== 'task-status' ||
          req.agentScope.agentId !== req.apiKeyAgent.id) {
        throw new ForbiddenException('Task dispatch is not authorized.');
      }
      req.dispatchPrincipal = {
        type: 'agent',
        id: req.apiKeyAgent.id,
        workspaceId: req.apiKeyAgent.workspaceId,
      };
      return true;
    }

    const userId = req.user?.id;
    if (typeof taskId !== 'string' || !userId) {
      throw new ForbiddenException('Task dispatch is not authorized.');
    }

    const task = await this.prisma.task.findFirst({
      where: {
        id: taskId,
        project: {
          workspace: {
            members: {
              some: {
                userId,
                role: { in: ['owner', 'manager', 'developer'] },
              },
            },
          },
        },
      },
      select: { id: true },
    });
    if (!task) throw new ForbiddenException('Task dispatch is not authorized.');

    req.dispatchPrincipal = { type: 'human', id: userId };
    return true;
  }
}
