import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Workspace } from './entities/workspace.entity';
import { WorkspaceMember } from './entities/workspace-member.entity';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { WorkspaceMemberRole } from '@muneral/types';

@Injectable()
export class WorkspacesService {
  constructor(
    @InjectRepository(Workspace)
    private readonly workspaceRepo: Repository<Workspace>,
    @InjectRepository(WorkspaceMember)
    private readonly memberRepo: Repository<WorkspaceMember>,
  ) {}

  async create(ownerId: string, dto: CreateWorkspaceDto): Promise<Workspace> {
    const existing = await this.workspaceRepo.findOne({
      where: { slug: dto.slug },
    });
    if (existing) {
      throw new ConflictException(`Workspace slug '${dto.slug}' is taken`);
    }

    const workspace = this.workspaceRepo.create({
      ...dto,
      ownerId,
    });
    await this.workspaceRepo.save(workspace);

    // Auto-add owner as member
    const member = this.memberRepo.create({
      workspaceId: workspace.id,
      userId: ownerId,
      role: 'owner',
    });
    await this.memberRepo.save(member);

    return workspace;
  }

  async findAllForUser(userId: string): Promise<Workspace[]> {
    return this.workspaceRepo
      .createQueryBuilder('ws')
      .innerJoin(
        WorkspaceMember,
        'wm',
        'wm.workspace_id = ws.id AND wm.user_id = :userId',
        { userId },
      )
      .getMany();
  }

  async findOne(workspaceId: string): Promise<Workspace> {
    const workspace = await this.workspaceRepo.findOne({
      where: { id: workspaceId },
    });
    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }
    return workspace;
  }

  async addMember(
    workspaceId: string,
    userId: string,
    role: WorkspaceMemberRole = 'developer',
  ): Promise<WorkspaceMember> {
    const existing = await this.memberRepo.findOne({
      where: { workspaceId, userId },
    });
    if (existing) {
      throw new ConflictException('User is already a member');
    }
    const member = this.memberRepo.create({ workspaceId, userId, role });
    return this.memberRepo.save(member);
  }

  async updateMemberRole(
    workspaceId: string,
    userId: string,
    role: WorkspaceMemberRole,
    requesterId: string,
  ): Promise<WorkspaceMember> {
    const member = await this.memberRepo.findOne({
      where: { workspaceId, userId },
    });
    if (!member) {
      throw new NotFoundException('Member not found');
    }
    // Prevent demoting the last owner
    if (member.role === 'owner' && role !== 'owner') {
      const ownerCount = await this.memberRepo.count({
        where: { workspaceId, role: 'owner' },
      });
      if (ownerCount <= 1 && userId !== requesterId) {
        throw new ForbiddenException('Cannot remove the last owner');
      }
    }
    member.role = role;
    return this.memberRepo.save(member);
  }

  async removeMember(workspaceId: string, userId: string): Promise<void> {
    const member = await this.memberRepo.findOne({
      where: { workspaceId, userId },
    });
    if (!member) {
      throw new NotFoundException('Member not found');
    }
    if (member.role === 'owner') {
      const ownerCount = await this.memberRepo.count({
        where: { workspaceId, role: 'owner' },
      });
      if (ownerCount <= 1) {
        throw new ForbiddenException('Cannot remove the last owner');
      }
    }
    await this.memberRepo.remove(member);
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    return this.memberRepo
      .createQueryBuilder('wm')
      .leftJoinAndSelect('wm.user', 'u')
      .where('wm.workspace_id = :workspaceId', { workspaceId })
      .getMany();
  }
}
