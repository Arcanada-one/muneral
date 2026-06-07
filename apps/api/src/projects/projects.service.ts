import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { AddGitRefDto } from './dto/add-git-ref.dto';

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateProjectDto) {
    return this.prisma.project.create({
      data: {
        workspaceId: dto.workspaceId,
        slug: dto.slug,
        name: dto.name,
        description: dto.description ?? null,
        repoUrl: dto.repoUrl ?? null,
      },
    });
  }

  async findByWorkspace(workspaceId: string) {
    return this.prisma.project.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundException('Project not found');
    }
    return project;
  }

  async delete(projectId: string): Promise<void> {
    await this.findOne(projectId);
    await this.prisma.project.delete({ where: { id: projectId } });
  }

  // --- Git refs ---

  async addGitRef(dto: AddGitRefDto) {
    return this.prisma.taskGitRef.create({
      data: {
        taskId: dto.taskId,
        type: dto.type,
        url: dto.url,
        ref: dto.ref ?? null,
      },
    });
  }

  async removeGitRef(refId: string): Promise<void> {
    const ref = await this.prisma.taskGitRef.findUnique({ where: { id: refId } });
    if (!ref) {
      throw new NotFoundException('Git ref not found');
    }
    await this.prisma.taskGitRef.delete({ where: { id: refId } });
  }

  async getGitRefs(taskId: string) {
    return this.prisma.taskGitRef.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
