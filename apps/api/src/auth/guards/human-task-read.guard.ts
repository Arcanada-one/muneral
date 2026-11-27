import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Agent, User } from '@prisma/client';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service.js';
import { HUMAN_ROUTE_ACCESS, type ResourceKind, type RouteAccess } from './human-route-access.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const refuse = () => new ForbiddenException('Workspace access forbidden');

function accessFor(context: ExecutionContext): RouteAccess | undefined {
  return HUMAN_ROUTE_ACCESS[`${context.getClass().name}.${context.getHandler().name}`];
}

/** Every value at a dot path; `name[]` walks an array. */
function valuesAt(source: unknown, path: string): unknown[] {
  let found: unknown[] = [source];
  for (const segment of path.split('.')) {
    const walk = segment.endsWith('[]');
    const key = walk ? segment.slice(0, -2) : segment;
    found = found.flatMap((value) => {
      if (value === null || typeof value !== 'object') return [];
      const next = (value as Record<string, unknown>)[key];
      if (!walk) return [next];
      return Array.isArray(next) ? next : [];
    });
  }
  return found.filter((value) => value !== undefined && value !== null);
}

/**
 * Workspace membership for human callers, on every method. What each route needs
 * is listed in human-route-access.ts; anything that cannot be resolved to a
 * workspace of the caller is refused.
 *
 * Agent API keys keep the rules of AgentTaskScopeGuard. In addition, an object
 * named in the request body must not belong to another workspace than the key's.
 */
@Injectable()
export class HumanTaskReadGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: User; apiKeyAgent?: Agent }>();
    if (req.apiKeyAgent) {
      await this.assertBodyStaysInWorkspace(context, req.body, req.apiKeyAgent.workspaceId);
      return true;
    }
    if (!req.user?.id) throw refuse();
    const userId = req.user.id;

    const access = accessFor(context);
    if (!access) throw refuse();

    const wanted: Array<[ResourceKind, string]> = [];
    const collect = (kind: ResourceKind, value: unknown) => {
      if (typeof value !== 'string' || !UUID.test(value)) throw refuse();
      wanted.push([kind, value]);
    };
    const params = (req.params ?? {}) as Record<string, unknown>;
    for (const [name, value] of Object.entries(params)) {
      const kind = access.params?.[name];
      if (!kind) throw refuse();
      if (kind === 'text') continue;
      if (kind === 'id') {
        if (typeof value !== 'string' || !UUID.test(value)) throw refuse();
        continue;
      }
      collect(kind, value);
    }
    for (const [path, kind] of Object.entries(access.body ?? {})) {
      for (const value of valuesAt(req.body, path)) collect(kind, value);
    }
    for (const [path, kind] of Object.entries(access.query ?? {})) {
      for (const value of valuesAt(req.query, path)) collect(kind, value);
    }
    if (wanted.length === 0 && !access.unbound) throw refuse();

    for (const [kind, id] of wanted) {
      if (!(await this.belongs(kind, id, userId, params))) throw refuse();
    }

    const taskId = params['taskId'];
    if ((req.method === 'GET' || req.method === 'HEAD') && typeof taskId === 'string' &&
        /\/(dependencies|dependency-graph|readiness)\/?$/.test(req.path)) {
      // A readable root does not authorize the other end of a dependency.
      // Refuse the whole graph: filtering would falsely claim an empty/ready graph.
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
      if (foreign) throw refuse();
    }
    return true;
  }

  /** Only narrows. An id that names nothing is left to the route's own answer. */
  private async assertBodyStaysInWorkspace(
    context: ExecutionContext,
    body: unknown,
    workspaceId: string,
  ): Promise<void> {
    for (const [path, kind] of Object.entries(accessFor(context)?.body ?? {})) {
      for (const value of valuesAt(body, path)) {
        // Anything that is not a UUID string is rejected by the route's validation.
        if (typeof value !== 'string' || !UUID.test(value)) continue;
        const owner = await this.workspaceOf(kind, value);
        if (owner !== null && owner !== workspaceId) throw refuse();
      }
    }
  }

  private async workspaceOf(kind: ResourceKind, id: string): Promise<string | null> {
    const where = { id };
    const viaProject = { select: { project: { select: { workspaceId: true } } } };
    switch (kind) {
      case 'workspace':
        return (await this.prisma.workspace.findUnique({ where, select: { id: true } }))?.id ?? null;
      case 'project':
        return (await this.prisma.project.findUnique({ where, select: { workspaceId: true } }))?.workspaceId ?? null;
      case 'agent':
        return (await this.prisma.agent.findUnique({ where, select: { workspaceId: true } }))?.workspaceId ?? null;
      case 'task':
        return (await this.prisma.task.findUnique({ where, ...viaProject }))?.project.workspaceId ?? null;
      case 'sprint':
        return (await this.prisma.sprint.findUnique({ where, ...viaProject }))?.project.workspaceId ?? null;
      case 'milestone':
        return (await this.prisma.milestone.findUnique({ where, ...viaProject }))?.project.workspaceId ?? null;
      case 'apiKey':
      case 'webhook':
      case 'gitRef':
      case 'taskDependency':
        // No route takes one of these in its body.
        throw refuse();
      default: {
        const unhandled: never = kind;
        return unhandled;
      }
    }
  }

  private async belongs(
    kind: ResourceKind,
    id: string,
    userId: string,
    params: Record<string, unknown>,
  ): Promise<boolean> {
    const workspace = { members: { some: { userId } } };
    const inProject = { project: { workspace } };
    const select = { id: true } as const;
    switch (kind) {
      case 'workspace':
        return !!(await this.prisma.workspace.findFirst({ where: { id, ...workspace }, select }));
      case 'project':
        return !!(await this.prisma.project.findFirst({ where: { id, workspace }, select }));
      case 'task':
        return !!(await this.prisma.task.findFirst({ where: { id, ...inProject }, select }));
      case 'sprint':
        return !!(await this.prisma.sprint.findFirst({ where: { id, ...inProject }, select }));
      case 'milestone':
        return !!(await this.prisma.milestone.findFirst({ where: { id, ...inProject }, select }));
      case 'agent':
        return !!(await this.prisma.agent.findFirst({ where: { id, workspace }, select }));
      case 'apiKey':
        return !!(await this.prisma.apiKey.findFirst({ where: { id, agent: { workspace } }, select }));
      case 'webhook':
        return !!(await this.prisma.webhookConfig.findFirst({ where: { id, workspace }, select }));
      case 'gitRef':
        return !!(await this.prisma.taskGitRef.findFirst({ where: { id, task: inProject }, select }));
      case 'taskDependency': {
        // Only an edge that starts at the task named in the path.
        const taskId = params['taskId'];
        if (typeof taskId !== 'string') return false;
        return !!(await this.prisma.taskDependency.findFirst({
          where: { id, fromTaskId: taskId, fromTask: inProject, toTask: inProject }, select,
        }));
      }
      default: {
        const unhandled: never = kind;
        return unhandled;
      }
    }
  }
}
