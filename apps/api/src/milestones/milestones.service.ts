import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMilestoneDto } from './dto/create-milestone.dto';
import { CreateSprintDto } from './dto/create-sprint.dto';

@Injectable()
export class MilestonesService {
  constructor(private readonly prisma: PrismaService) {}

  async createMilestone(dto: CreateMilestoneDto) {
    return this.prisma.milestone.create({
      data: {
        projectId: dto.projectId,
        title: dto.title,
        dueDate: dto.dueDate ?? null,
      },
    });
  }

  async getMilestones(projectId: string) {
    // NULLS LAST: position nullable — Prisma supports nulls: 'last'
    return this.prisma.milestone.findMany({
      where: { projectId },
      orderBy: { dueDate: { sort: 'asc', nulls: 'last' } },
    });
  }

  async deleteMilestone(milestoneId: string): Promise<void> {
    const milestone = await this.prisma.milestone.findUnique({
      where: { id: milestoneId },
    });
    if (!milestone) throw new NotFoundException('Milestone not found');
    await this.prisma.milestone.delete({ where: { id: milestoneId } });
  }

  async createSprint(dto: CreateSprintDto) {
    return this.prisma.sprint.create({
      data: {
        projectId: dto.projectId,
        milestoneId: dto.milestoneId ?? null,
        name: dto.name,
        startDate: dto.startDate,
        endDate: dto.endDate,
      },
    });
  }

  async getSprints(projectId: string) {
    return this.prisma.sprint.findMany({
      where: { projectId },
      orderBy: { startDate: 'desc' },
    });
  }

  async deleteSprint(sprintId: string): Promise<void> {
    const sprint = await this.prisma.sprint.findUnique({ where: { id: sprintId } });
    if (!sprint) throw new NotFoundException('Sprint not found');
    await this.prisma.sprint.delete({ where: { id: sprintId } });
  }
}
