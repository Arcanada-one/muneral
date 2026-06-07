import { Prisma } from '@prisma/client';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { AssignAgentDto } from './dto/assign-agent.dto';
import { AuthService } from '../auth/auth.service';

@Injectable()
export class AgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  async register(dto: CreateAgentDto) {
    return this.prisma.agent.create({
      data: {
        workspaceId: dto.workspaceId,
        name: dto.name,
        model: dto.model ?? null,
        provider: dto.provider ?? null,
        capabilities: (dto.capabilities ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  async findByWorkspace(workspaceId: string) {
    return this.prisma.agent.findMany({ where: { workspaceId } });
  }

  async findOne(agentId: string) {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new NotFoundException('Agent not found');
    return agent;
  }

  /** Get tasks assigned to a specific agent */
  async getAgentTasks(agentId: string) {
    return this.prisma.taskAgent.findMany({
      where: { agentId },
      include: { task: true },
    });
  }

  async assignToTask(taskId: string, dto: AssignAgentDto) {
    return this.prisma.taskAgent.create({
      data: {
        taskId,
        agentId: dto.agentId,
        role: dto.role,
      },
    });
  }

  async removeFromTask(taskId: string, agentId: string): Promise<void> {
    const ta = await this.prisma.taskAgent.findUnique({
      where: { taskId_agentId: { taskId, agentId } },
    });
    if (!ta) throw new NotFoundException('Agent assignment not found');
    await this.prisma.taskAgent.delete({
      where: { taskId_agentId: { taskId, agentId } },
    });
  }

  // --- API Key lifecycle (delegates to AuthService) ---

  async createApiKey(agentId: string, label?: string) {
    await this.findOne(agentId);
    return this.authService.createApiKey(agentId, label);
  }

  async rotateApiKey(keyId: string) {
    return this.authService.rotateApiKey(keyId);
  }

  async revokeApiKey(keyId: string) {
    return this.authService.revokeApiKey(keyId);
  }
}
