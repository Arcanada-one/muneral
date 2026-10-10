import { humanTaskWhere } from '../auth/human-task-visibility.js';
import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateProjectDto } from './dto/create-project.dto.js';
import { AddGitRefDto } from './dto/add-git-ref.dto.js';

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateProjectDto, agentRequest = false) {
    if (agentRequest) {
      return this.prisma.$transaction(async (tx) => {
        // The current schema has no workspace+slug unique constraint.
        // Serialize create/retry without a read grant or a new identity.
        await tx.$executeRaw`LOCK TABLE projects IN SHARE ROW EXCLUSIVE MODE`;
        const matches = await tx.project.findMany({ where: { workspaceId: dto.workspaceId, slug: dto.slug } });
        if (matches.length > 1) throw new ConflictException('Project slug is ambiguous in this workspace.');
        if (matches.length === 1) {
          const existing = matches[0];
          if (existing.name !== dto.name || existing.description !== (dto.description ?? null)
            || existing.repoUrl !== (dto.repoUrl ?? null)) {
            throw new ConflictException('Project slug already exists with different properties.');
          }
          return existing;
        }
        return tx.project.create({ data: { workspaceId: dto.workspaceId, slug: dto.slug,
          name: dto.name, description: dto.description ?? null, repoUrl: dto.repoUrl ?? null } });
      });
    }
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

  async findByWorkspace(workspaceId: string, metadataOnly = false) {
    return this.prisma.project.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
      ...(metadataOnly ? { select: { id: true, workspaceId: true, slug: true, name: true } } : {}),
    });
  }

  async findOne(projectId: string, workspaceId?: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ...(workspaceId ? { workspaceId } : {}) },
      ...(workspaceId ? { select: { id: true, workspaceId: true, slug: true, name: true } } : {}),
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

  async getGitRefs(taskId: string, humanUserId?: string) {
    return this.prisma.taskGitRef.findMany({
      where: { taskId, ...(humanUserId ? { task: humanTaskWhere(humanUserId) } : {}) },
      orderBy: { createdAt: 'desc' },
    });
  }
}
