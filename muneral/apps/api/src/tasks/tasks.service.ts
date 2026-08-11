import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Task } from './entities/task.entity';
import { TaskTag } from './entities/task-tag.entity';
import { TaskChecklist } from './entities/task-checklist.entity';
import { TaskDependency } from './entities/task-dependency.entity';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto';
import { AddDependencyDto } from './dto/add-dependency.dto';
import { CreateChecklistItemDto } from './dto/create-checklist-item.dto';
import { ActivityService } from '../activity/activity.service';
import { KanbanService } from '../ws/kanban.service';
import { Actor, isValidTransition } from '@muneral/types';
import { Project } from '../projects/entities/project.entity';

@Injectable()
export class TasksService {
  constructor(
    @InjectRepository(Task)
    private readonly taskRepo: Repository<Task>,
    @InjectRepository(TaskTag)
    private readonly tagRepo: Repository<TaskTag>,
    @InjectRepository(TaskChecklist)
    private readonly checklistRepo: Repository<TaskChecklist>,
    @InjectRepository(TaskDependency)
    private readonly depRepo: Repository<TaskDependency>,
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    private readonly activityService: ActivityService,
    private readonly kanbanService: KanbanService,
  ) {}

  async create(actor: Actor, dto: CreateTaskDto): Promise<Task> {
    const project = await this.projectRepo.findOne({
      where: { id: dto.projectId },
    });
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const task = this.taskRepo.create({
      projectId: dto.projectId,
      sprintId: dto.sprintId ?? null,
      parentId: dto.parentId ?? null,
      title: dto.title,
      description: dto.description ?? null,
      status: dto.status ?? 'todo',
      priority: dto.priority ?? 'medium',
      dueDate: dto.dueDate ?? null,
      estimateHours: dto.estimateHours ?? null,
      createdById: actor.id,
      actorType: actor.type,
    });
    await this.taskRepo.save(task);

    // Save tags
    if (dto.tags?.length) {
      const tags = dto.tags.map((tag) =>
        this.tagRepo.create({ taskId: task.id, tag }),
      );
      await this.tagRepo.save(tags);
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

  async findOne(taskId: string): Promise<Task> {
    const task = await this.taskRepo.findOne({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException('Task not found');
    }
    return task;
  }

  async findByProject(projectId: string): Promise<Task[]> {
    return this.taskRepo
      .createQueryBuilder('t')
      .where('t.project_id = :projectId', { projectId })
      .orderBy('t.created_at', 'DESC')
      .getMany();
  }

  async updateStatus(
    taskId: string,
    actor: Actor,
    dto: UpdateTaskStatusDto,
  ): Promise<Task> {
    const task = await this.findOne(taskId);
    const project = await this.projectRepo.findOne({
      where: { id: task.projectId },
    });
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    if (!isValidTransition(task.status, dto.status)) {
      throw new BadRequestException(
        `Invalid status transition: ${task.status} → ${dto.status}`,
      );
    }

    const previousStatus = task.status;
    task.status = dto.status;
    await this.taskRepo.save(task);

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

    return task;
  }

  async update(
    taskId: string,
    actor: Actor,
    updates: Partial<Pick<Task, 'title' | 'description' | 'priority' | 'dueDate' | 'estimateHours' | 'sprintId'>>,
  ): Promise<Task> {
    const task = await this.findOne(taskId);
    const project = await this.projectRepo.findOne({
      where: { id: task.projectId },
    });

    Object.assign(task, updates);
    await this.taskRepo.save(task);

    if (project) {
      await this.activityService.log({
        workspaceId: project.workspaceId,
        taskId: task.id,
        actor,
        action: 'task:updated',
        payload: updates as Record<string, unknown>,
      });
      this.kanbanService.notify(project.id, 'task:updated', task);
    }

    return task;
  }

  async delete(taskId: string, actor: Actor): Promise<void> {
    const task = await this.findOne(taskId);
    const project = await this.projectRepo.findOne({
      where: { id: task.projectId },
    });

    await this.taskRepo.remove(task);

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

  async addChecklistItem(
    taskId: string,
    dto: CreateChecklistItemDto,
  ): Promise<TaskChecklist> {
    await this.findOne(taskId); // verify task exists
    const item = this.checklistRepo.create({
      taskId,
      text: dto.text,
      position: dto.position ?? null,
    });
    return this.checklistRepo.save(item);
  }

  async toggleChecklistItem(
    taskId: string,
    itemId: string,
    checked: boolean,
  ): Promise<TaskChecklist> {
    const item = await this.checklistRepo.findOne({
      where: { id: itemId, taskId },
    });
    if (!item) {
      throw new NotFoundException('Checklist item not found');
    }
    item.checked = checked;
    return this.checklistRepo.save(item);
  }

  async deleteChecklistItem(taskId: string, itemId: string): Promise<void> {
    const item = await this.checklistRepo.findOne({
      where: { id: itemId, taskId },
    });
    if (!item) {
      throw new NotFoundException('Checklist item not found');
    }
    await this.checklistRepo.remove(item);
  }

  async getChecklist(taskId: string): Promise<TaskChecklist[]> {
    return this.checklistRepo
      .createQueryBuilder('ci')
      .where('ci.task_id = :taskId', { taskId })
      .orderBy('ci.position', 'ASC', 'NULLS LAST')
      .getMany();
  }

  // --- Dependencies ---

  async addDependency(
    fromTaskId: string,
    dto: AddDependencyDto,
  ): Promise<TaskDependency> {
    await this.findOne(fromTaskId);
    await this.findOne(dto.toTaskId);

    const dep = this.depRepo.create({
      fromTaskId,
      toTaskId: dto.toTaskId,
      type: dto.type,
    });
    return this.depRepo.save(dep);
  }

  async removeDependency(depId: string): Promise<void> {
    const dep = await this.depRepo.findOne({ where: { id: depId } });
    if (!dep) {
      throw new NotFoundException('Dependency not found');
    }
    await this.depRepo.remove(dep);
  }

  async getDependencies(taskId: string): Promise<TaskDependency[]> {
    return this.depRepo
      .createQueryBuilder('td')
      .where('td.from_task_id = :taskId', { taskId })
      .getMany();
  }

  // --- Comments (via ActivityLog) ---

  async addComment(
    taskId: string,
    actor: Actor,
    body: string,
  ): Promise<void> {
    const task = await this.findOne(taskId);
    const project = await this.projectRepo.findOne({
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
