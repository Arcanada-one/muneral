import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ActivityLog } from './entities/activity-log.entity';
import { Actor } from '@muneral/types';

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
  constructor(
    @InjectRepository(ActivityLog)
    private readonly logRepo: Repository<ActivityLog>,
  ) {}

  async log(opts: LogOptions): Promise<ActivityLog> {
    const entry = this.logRepo.create({
      workspaceId: opts.workspaceId,
      taskId: opts.taskId ?? null,
      actorType: opts.actor.type,
      actorId: opts.actor.id,
      action: opts.action,
      payload: opts.payload ?? null,
    });
    return this.logRepo.save(entry);
  }

  async findForTask(
    taskId: string,
    page = 1,
    limit = 20,
  ): Promise<{ data: ActivityLog[]; total: number; page: number; limit: number }> {
    const [data, total] = await this.logRepo
      .createQueryBuilder('al')
      .where('al.task_id = :taskId', { taskId })
      .orderBy('al.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { data, total, page, limit };
  }

  async findForWorkspace(
    workspaceId: string,
    page = 1,
    limit = 20,
  ): Promise<{ data: ActivityLog[]; total: number; page: number; limit: number }> {
    const [data, total] = await this.logRepo
      .createQueryBuilder('al')
      .where('al.workspace_id = :workspaceId', { workspaceId })
      .orderBy('al.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { data, total, page, limit };
  }
}
