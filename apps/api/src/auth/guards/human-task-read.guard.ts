import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { Agent, User } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';

/** JWT authentication supplies req.user before guards; req.actor arrives later.
 * Agent authorization remains exclusively in AgentTaskScopeGuard.
 * No owner-id fallback: deleting membership must revoke subsequent reads.
 */
@Injectable()
export class HumanTaskReadGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: User; apiKeyAgent?: Agent }>();
    if (req.method !== 'GET' && req.method !== 'HEAD') return true;
    if (req.apiKeyAgent) return true;
    if (!req.user?.id) throw new ForbiddenException('Human task read forbidden');
    const userId = req.user.id;
    const memberProject = { workspace: { members: { some: { userId } } } };
    const taskId = req.params['taskId'];
    const projectId = req.params['projectId'] ?? req.query['projectId'];
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if ((typeof taskId === 'string' && !uuid.test(taskId)) ||
        (typeof projectId === 'string' && !uuid.test(projectId))) {
      throw new ForbiddenException('Human task read forbidden');
    }
    if (typeof taskId === 'string') {
      const task = await this.prisma.task.findFirst({
        where: { id: taskId, project: memberProject }, select: { id: true },
      });
      if (!task) throw new ForbiddenException('Human task read forbidden');
      // A readable root does not authorize the other end of a dependency.
      // Refuse the whole graph: filtering would falsely claim an empty/ready graph.
      if (/\/(dependencies|dependency-graph|readiness)\/?$/.test(req.path)) {
        const foreign = await this.prisma.taskDependency.findFirst({
          where: {
            AND: [
              { OR: [{ fromTaskId: taskId }, { toTaskId: taskId }] },
              { OR: [
                { fromTask: { project: { workspace: { members: { none: { userId } } } } } },
                { toTask: { project: { workspace: { members: { none: { userId } } } } } },
              ] },
            ],
          }, select: { id: true },
        });
        if (foreign) throw new ForbiddenException('Human task read forbidden');
      }
    } else if (typeof projectId === 'string') {
      const project = await this.prisma.project.findFirst({
        where: { id: projectId, ...memberProject }, select: { id: true },
      });
      if (!project) throw new ForbiddenException('Human task read forbidden');
    }
    return true;
  }
}
