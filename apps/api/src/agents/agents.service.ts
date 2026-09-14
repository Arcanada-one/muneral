import { Prisma } from '@prisma/client';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Actor } from '@muneral/types';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateAgentDto } from './dto/create-agent.dto.js';
import { AssignAgentDto } from './dto/assign-agent.dto.js';
import { AuthService } from '../auth/auth.service.js';
import { ActivityService } from '../activity/activity.service.js';
import type { AssignBasis } from '../auth/guards/agent-task-scope.guard.js';

/** MUN-0051: the activity row every assignment writes. */
export const AGENT_ASSIGNED_ACTION = 'task:agent_assigned';

@Injectable()
export class AgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly activityService: ActivityService,
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

  /**
   * MUN-0051: the row and its activity entry are written in one transaction,
   * attributed to `actor` (resolved from the credential, never the body), with
   * the basis the scope guard admitted a key on (`'jwt'` for a human). Before,
   * the route wrote no activity at all, so nobody could count who assigned
   * whom. An unknown task answers 404 and an existing (task, agent) pair 409,
   * where both used to surface as a database error.
   */
  async assignToTask(
    taskId: string,
    dto: AssignAgentDto,
    actor: Actor,
    basis?: AssignBasis,
  ) {
    const task = await this.prisma.task
      .findUnique({
        where: { id: taskId },
        select: { id: true, project: { select: { workspaceId: true } } },
      })
      .catch(() => null);
    if (!task) throw new NotFoundException('Task not found');

    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.taskAgent.create({
          data: {
            taskId,
            agentId: dto.agentId,
            role: dto.role,
          },
        });
        await this.activityService.log(
          {
            workspaceId: task.project.workspaceId,
            taskId,
            actor,
            action: AGENT_ASSIGNED_ACTION,
            payload: {
              agentId: dto.agentId,
              role: dto.role,
              basis: actor.type === 'agent' ? (basis ?? null) : 'jwt',
            },
          },
          tx,
        );
        return row;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`Agent ${dto.agentId} is already assigned to task ${taskId}.`);
      }
      throw err;
    }
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

  async revokeOwnApiKey(keyId: string, agent: { id: string; workspaceId: string }) {
    return this.authService.revokeOwnApiKey(keyId, agent);
  }

  async revokeApiKey(keyId: string) {
    return this.authService.revokeApiKey(keyId);
  }
}
