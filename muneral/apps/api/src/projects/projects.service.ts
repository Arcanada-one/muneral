import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Project } from './entities/project.entity';
import { TaskGitRef } from './entities/task-git-ref.entity';
import { CreateProjectDto } from './dto/create-project.dto';
import { AddGitRefDto } from './dto/add-git-ref.dto';

@Injectable()
export class ProjectsService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(TaskGitRef)
    private readonly gitRefRepo: Repository<TaskGitRef>,
  ) {}

  async create(dto: CreateProjectDto): Promise<Project> {
    const project = this.projectRepo.create({
      workspaceId: dto.workspaceId,
      slug: dto.slug,
      name: dto.name,
      description: dto.description ?? null,
      repoUrl: dto.repoUrl ?? null,
    });
    return this.projectRepo.save(project);
  }

  async findByWorkspace(workspaceId: string): Promise<Project[]> {
    return this.projectRepo
      .createQueryBuilder('p')
      .where('p.workspace_id = :workspaceId', { workspaceId })
      .orderBy('p.created_at', 'DESC')
      .getMany();
  }

  async findOne(projectId: string): Promise<Project> {
    const project = await this.projectRepo.findOne({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundException('Project not found');
    }
    return project;
  }

  async delete(projectId: string): Promise<void> {
    const project = await this.findOne(projectId);
    await this.projectRepo.remove(project);
  }

  // --- Git refs ---

  async addGitRef(dto: AddGitRefDto): Promise<TaskGitRef> {
    const ref = this.gitRefRepo.create({
      taskId: dto.taskId,
      type: dto.type,
      url: dto.url,
      ref: dto.ref ?? null,
    });
    return this.gitRefRepo.save(ref);
  }

  async removeGitRef(refId: string): Promise<void> {
    const ref = await this.gitRefRepo.findOne({ where: { id: refId } });
    if (!ref) {
      throw new NotFoundException('Git ref not found');
    }
    await this.gitRefRepo.remove(ref);
  }

  async getGitRefs(taskId: string): Promise<TaskGitRef[]> {
    return this.gitRefRepo
      .createQueryBuilder('gr')
      .where('gr.task_id = :taskId', { taskId })
      .orderBy('gr.created_at', 'DESC')
      .getMany();
  }
}
