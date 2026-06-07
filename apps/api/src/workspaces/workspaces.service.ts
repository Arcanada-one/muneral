import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { WorkspaceMemberRole } from '@muneral/types';

@Injectable()
export class WorkspacesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(ownerId: string, dto: CreateWorkspaceDto) {
    const existing = await this.prisma.workspace.findUnique({
      where: { slug: dto.slug },
    });
    if (existing) {
      throw new ConflictException(`Workspace slug '${dto.slug}' is taken`);
    }

    const workspace = await this.prisma.workspace.create({
      data: { ...dto, ownerId },
    });

    // Auto-add owner as member
    await this.prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: ownerId, role: 'owner' },
    });

    return workspace;
  }

  async findAllForUser(userId: string) {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId },
      include: { workspace: true },
    });
    return memberships.map((m) => m.workspace);
  }

  async findOne(workspaceId: string) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
    });
    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }
    return workspace;
  }

  async addMember(workspaceId: string, userId: string, role: WorkspaceMemberRole = 'developer') {
    const existing = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (existing) {
      throw new ConflictException('User is already a member');
    }
    return this.prisma.workspaceMember.create({
      data: { workspaceId, userId, role },
    });
  }

  async updateMemberRole(
    workspaceId: string,
    userId: string,
    role: WorkspaceMemberRole,
    requesterId: string,
  ) {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!member) {
      throw new NotFoundException('Member not found');
    }
    // Prevent demoting the last owner
    if (member.role === 'owner' && role !== 'owner') {
      const ownerCount = await this.prisma.workspaceMember.count({
        where: { workspaceId, role: 'owner' },
      });
      if (ownerCount <= 1 && userId !== requesterId) {
        throw new ForbiddenException('Cannot remove the last owner');
      }
    }
    return this.prisma.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId, userId } },
      data: { role },
    });
  }

  async removeMember(workspaceId: string, userId: string): Promise<void> {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
    if (!member) {
      throw new NotFoundException('Member not found');
    }
    if (member.role === 'owner') {
      const ownerCount = await this.prisma.workspaceMember.count({
        where: { workspaceId, role: 'owner' },
      });
      if (ownerCount <= 1) {
        throw new ForbiddenException('Cannot remove the last owner');
      }
    }
    await this.prisma.workspaceMember.delete({
      where: { workspaceId_userId: { workspaceId, userId } },
    });
  }

  async listMembers(workspaceId: string) {
    return this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      include: { user: true },
    });
  }
}
