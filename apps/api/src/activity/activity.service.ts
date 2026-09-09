import { Prisma } from '@prisma/client';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Actor } from '@muneral/types';

/**
 * Either the root Prisma client or an interactive-transaction client. Callers
 * that must write the audit entry atomically with the mutation it describes
 * pass their `tx` here — an entry committed separately from its mutation can
 * go missing on a crash, leaving a state change with no record of who made it.
 */
export type ActivityWriter = Pick<PrismaService, 'activityLog'>;

export interface LogOptions {
  workspaceId: string;
  taskId?: string;
  actor: Actor;
  action: string;
  payload?: Record<string, unknown>;
}

/**
 * ActivityService — central audit log for all state changes.
 * Injected across modules to record mutations.
 */
@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async log(opts: LogOptions, client: ActivityWriter = this.prisma) {
    return client.activityLog.create({
      data: {
        workspaceId: opts.workspaceId,
        taskId: opts.taskId ?? null,
        actorType: opts.actor.type,
        actorId: opts.actor.id,
        action: opts.action,
        payload: opts.payload !== undefined ? (opts.payload as Prisma.InputJsonValue) : Prisma.DbNull,
      },
    });
  }

  async findForTask(
    taskId: string,
    page = 1,
    limit = 20,
  ): Promise<{ data: object[]; total: number; page: number; limit: number }> {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.activityLog.findMany({
        where: { taskId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.activityLog.count({ where: { taskId } }),
    ]);
    return { data, total, page, limit };
  }

  async findForWorkspace(
    workspaceId: string,
    page = 1,
    limit = 20,
  ): Promise<{ data: object[]; total: number; page: number; limit: number }> {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.activityLog.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.activityLog.count({ where: { workspaceId } }),
    ]);
    return { data, total, page, limit };
  }
}
