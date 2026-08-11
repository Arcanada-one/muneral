import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Milestone } from './entities/milestone.entity';
import { Sprint } from './entities/sprint.entity';
import { CreateMilestoneDto } from './dto/create-milestone.dto';
import { CreateSprintDto } from './dto/create-sprint.dto';

@Injectable()
export class MilestonesService {
  constructor(
    @InjectRepository(Milestone)
    private readonly milestoneRepo: Repository<Milestone>,
    @InjectRepository(Sprint)
    private readonly sprintRepo: Repository<Sprint>,
  ) {}

  async createMilestone(dto: CreateMilestoneDto): Promise<Milestone> {
    const milestone = this.milestoneRepo.create({
      projectId: dto.projectId,
      title: dto.title,
      dueDate: dto.dueDate ?? null,
    });
    return this.milestoneRepo.save(milestone);
  }

  async getMilestones(projectId: string): Promise<Milestone[]> {
    return this.milestoneRepo
      .createQueryBuilder('m')
      .where('m.project_id = :projectId', { projectId })
      .orderBy('m.due_date', 'ASC', 'NULLS LAST')
      .getMany();
  }

  async deleteMilestone(milestoneId: string): Promise<void> {
    const milestone = await this.milestoneRepo.findOne({
      where: { id: milestoneId },
    });
    if (!milestone) throw new NotFoundException('Milestone not found');
    await this.milestoneRepo.remove(milestone);
  }

  async createSprint(dto: CreateSprintDto): Promise<Sprint> {
    const sprint = this.sprintRepo.create({
      projectId: dto.projectId,
      milestoneId: dto.milestoneId ?? null,
      name: dto.name,
      startDate: dto.startDate,
      endDate: dto.endDate,
    });
    return this.sprintRepo.save(sprint);
  }

  async getSprints(projectId: string): Promise<Sprint[]> {
    return this.sprintRepo
      .createQueryBuilder('s')
      .where('s.project_id = :projectId', { projectId })
      .orderBy('s.start_date', 'DESC')
      .getMany();
  }

  async deleteSprint(sprintId: string): Promise<void> {
    const sprint = await this.sprintRepo.findOne({ where: { id: sprintId } });
    if (!sprint) throw new NotFoundException('Sprint not found');
    await this.sprintRepo.remove(sprint);
  }
}
