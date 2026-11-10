import { humanTaskWhere } from '../auth/human-task-visibility.js';
import { Prisma } from '@prisma/client';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Actor } from '@muneral/types';
import { commentBodyFromPayload } from './comment-body.js';

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
    humanUserId?: string,
  ): Promise<{ data: object[]; total: number; page: number; limit: number }> {
    const skip = (page - 1) * limit;
    const where = { taskId, ...(humanUserId ? { task: humanTaskWhere(humanUserId) } : {}) };
    const [data, total] = await Promise.all([
      this.prisma.activityLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.activityLog.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  /**
   * MUN-0078 — bodyless agent-readable comment projection for one task.
   *
   * Filters `activity_log` to `action=comment` and returns only the fields an
   * agent needs to list prior comments without scraping the mixed activity
   * stream: id, createdAt, actorType, actorId, body. Workspace id, raw
   * payload JSON, and other activity actions never leave this surface.
   */
  async findCommentsForTask(
    taskId: string,
    page = 1,
    limit = 20,
    humanUserId?: string,
  ): Promise<{
    data: Array<{
      id: string;
      createdAt: Date;
      actorType: string;
      actorId: string;
      body: string;
    }>;
    total: number;
    page: number;
    limit: number;
  }> {
    const skip = (page - 1) * limit;
    const where = {
      taskId,
      action: 'comment',
      ...(humanUserId ? { task: humanTaskWhere(humanUserId) } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.activityLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          createdAt: true,
          actorType: true,
          actorId: true,
          payload: true,
        },
      }),
      this.prisma.activityLog.count({ where }),
    ]);
    return {
      data: rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        actorType: row.actorType,
        actorId: row.actorId,
        body: commentBodyFromPayload(row.payload),
      })),
      total,
      page,
      limit,
    };
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
