import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { AddDependencyDto } from './dto/add-dependency.dto';
import { CreateChecklistItemDto } from './dto/create-checklist-item.dto';
import { ActivityService } from '../activity/activity.service';
import { KanbanService } from '../ws/kanban.service';
import { Actor, isValidTransition, TaskStatus } from '@muneral/types';

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityService: ActivityService,
    private readonly kanbanService: KanbanService,
  ) {}

  async create(actor: Actor, dto: CreateTaskDto) {
    const project = await this.prisma.project.findUnique({
      where: { id: dto.projectId },
    });
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const task = await this.prisma.task.create({
      data: {
        projectId: dto.projectId,
        sprintId: dto.sprintId ?? null,
        parentId: dto.parentId ?? null,
        title: dto.title,
        description: dto.description ?? null,
        status: dto.status ?? 'todo',
        priority: dto.priority ?? 'medium',
        dueDate: dto.dueDate ?? null,
        estimateHours: dto.estimateHours != null ? new Prisma.Decimal(dto.estimateHours) : null,
        createdById: actor.id,
        actorType: actor.type,
      },
    });

    // Save tags
    if (dto.tags?.length) {
      await this.prisma.taskTag.createMany({
        data: dto.tags.map((tag) => ({ taskId: task.id, tag })),
      });
    }

    await this.activityService.log({
      workspaceId: project.workspaceId,
      taskId: task.id,
      actor,
      action: 'task:created',
      payload: { title: task.title, status: task.status },
    });

    this.kanbanService.notify(project.id, 'task:created', task);

    return task;
  }

  async findOne(taskId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException('Task not found');
    }
    return task;
  }

  async findByProject(projectId: string) {
    return this.prisma.task.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateStatus(
    taskId: string,
    actor: Actor,
    dto: UpdateTaskStatusDto,
  ) {
    const task = await this.findOne(taskId);
    const project = await this.prisma.project.findUnique({
      where: { id: task.projectId },
    });
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    if (!isValidTransition(task.status as TaskStatus, dto.status)) {
      throw new BadRequestException(
        `Invalid status transition: ${task.status} → ${dto.status}`,
      );
    }

    const previousStatus = task.status;
    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data: { status: dto.status },
    });

    await this.activityService.log({
      workspaceId: project.workspaceId,
      taskId: task.id,
      actor,
      action: 'task:status_changed',
      payload: { from: previousStatus, to: dto.status },
    });

    this.kanbanService.notify(project.id, 'task:moved', {
      taskId: task.id,
      from: previousStatus,
      to: dto.status,
    });

    return updated;
  }

  async update(
    taskId: string,
    actor: Actor,
    updates: Partial<{
      title: string;
      description: string | null;
      priority: string;
      dueDate: string | null;
      estimateHours: number | null;
      sprintId: string | null;
    }>,
  ) {
    const task = await this.findOne(taskId);
    const project = await this.prisma.project.findUnique({
      where: { id: task.projectId },
    });

    const data: Prisma.TaskUncheckedUpdateInput = {};
    if (updates.title !== undefined) data.title = updates.title;
    if (updates.description !== undefined) data.description = updates.description;
    if (updates.priority !== undefined) data.priority = updates.priority;
    if (updates.dueDate !== undefined) data.dueDate = updates.dueDate;
    if (updates.estimateHours !== undefined) {
      data.estimateHours = updates.estimateHours != null
        ? new Prisma.Decimal(updates.estimateHours)
        : null;
    }
    if (updates.sprintId !== undefined) data.sprintId = updates.sprintId;

    const updated = await this.prisma.task.update({
      where: { id: taskId },
      data,
    });

    if (project) {
      await this.activityService.log({
        workspaceId: project.workspaceId,
        taskId: task.id,
        actor,
        action: 'task:updated',
        payload: updates as Record<string, unknown>,
      });
      this.kanbanService.notify(project.id, 'task:updated', updated);
    }

    return updated;
  }

  async delete(taskId: string, actor: Actor): Promise<void> {
    const task = await this.findOne(taskId);
    const project = await this.prisma.project.findUnique({
      where: { id: task.projectId },
    });

    await this.prisma.task.delete({ where: { id: taskId } });

    if (project) {
      await this.activityService.log({
        workspaceId: project.workspaceId,
        taskId,
        actor,
        action: 'task:deleted',
        payload: { title: task.title },
      });
      this.kanbanService.notify(project.id, 'task:deleted', { taskId });
    }
  }

  // --- Checklist ---

  async addChecklistItem(taskId: string, dto: CreateChecklistItemDto) {
    await this.findOne(taskId); // verify task exists
    return this.prisma.taskChecklist.create({
      data: {
        taskId,
        text: dto.text,
        position: dto.position ?? null,
      },
    });
  }

  async toggleChecklistItem(taskId: string, itemId: string, checked: boolean) {
    const item = await this.prisma.taskChecklist.findFirst({
      where: { id: itemId, taskId },
    });
    if (!item) {
      throw new NotFoundException('Checklist item not found');
    }
    return this.prisma.taskChecklist.update({
      where: { id: itemId },
      data: { checked },
    });
  }

  async deleteChecklistItem(taskId: string, itemId: string): Promise<void> {
    const item = await this.prisma.taskChecklist.findFirst({
      where: { id: itemId, taskId },
    });
    if (!item) {
      throw new NotFoundException('Checklist item not found');
    }
    await this.prisma.taskChecklist.delete({ where: { id: itemId } });
  }

  async getChecklist(taskId: string) {
    // NULLS LAST: Prisma orderBy supports nulls: 'last' for nullables
    return this.prisma.taskChecklist.findMany({
      where: { taskId },
      orderBy: { position: { sort: 'asc', nulls: 'last' } },
    });
  }

  // --- Dependencies ---

  async addDependency(fromTaskId: string, dto: AddDependencyDto) {
    await this.findOne(fromTaskId);
    await this.findOne(dto.toTaskId);

    return this.prisma.taskDependency.create({
      data: {
        fromTaskId,
        toTaskId: dto.toTaskId,
        type: dto.type,
      },
    });
  }

  async removeDependency(depId: string): Promise<void> {
    const dep = await this.prisma.taskDependency.findUnique({ where: { id: depId } });
    if (!dep) {
      throw new NotFoundException('Dependency not found');
    }
    await this.prisma.taskDependency.delete({ where: { id: depId } });
  }

  async getDependencies(taskId: string) {
    return this.prisma.taskDependency.findMany({
      where: { fromTaskId: taskId },
    });
  }

  // --- Comments (via ActivityLog) ---

  async addComment(taskId: string, actor: Actor, body: string): Promise<void> {
    const task = await this.findOne(taskId);
    const project = await this.prisma.project.findUnique({
      where: { id: task.projectId },
    });
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    await this.activityService.log({
      workspaceId: project.workspaceId,
      taskId,
      actor,
      action: 'comment',
      payload: { body },
    });
  }

  async getActivity(taskId: string, page: number, limit: number) {
    return this.activityService.findForTask(taskId, page, limit);
  }
}
