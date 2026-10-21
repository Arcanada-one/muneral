import { Prisma } from '@prisma/client';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Actor } from '@muneral/types';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateAgentDto } from './dto/create-agent.dto.js';
import { AssignAgentDto } from './dto/assign-agent.dto.js';
import { AuthService } from '../auth/auth.service.js';
import { ActivityService } from '../activity/activity.service.js';
import type { AssignBasis } from '../auth/guards/agent-task-scope.guard.js';
import type { CreateAgentKeyDto } from './dto/create-agent-key.dto.js';

const MAX_AGENT_KEY_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const EXPLICIT_EXPIRY_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

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

  async createApiKey(agentId: string, dto: CreateAgentKeyDto, ownerUserId: string) {
    const agent = await this.prisma.agent.findUnique({
      where: { id: agentId },
      select: { id: true, workspace: { select: { ownerId: true } } },
    });
    if (!agent) throw new NotFoundException('Agent not found');
    this.assertWorkspaceOwner(ownerUserId, agent.workspace.ownerId);

    const expiresAt = this.parseExplicitExpiry(dto?.expiresAt);
    return this.authService.createApiKey(agentId, dto.label, expiresAt);
  }

  async rotateApiKey(keyId: string, ownerUserId: string) {
    await this.assertApiKeyWorkspaceOwner(keyId, ownerUserId);
    return this.authService.rotateApiKey(keyId);
  }

  async revokeOwnApiKey(keyId: string, agent: { id: string; workspaceId: string }) {
    return this.authService.revokeOwnApiKey(keyId, agent);
  }

  async revokeApiKey(keyId: string, ownerUserId: string) {
    await this.assertApiKeyWorkspaceOwner(keyId, ownerUserId);
    return this.authService.revokeApiKey(keyId);
  }

  private assertWorkspaceOwner(ownerUserId: string, workspaceOwnerId: string): void {
    if (!ownerUserId || ownerUserId !== workspaceOwnerId) {
      throw new ForbiddenException('Workspace owner required');
    }
  }

  private async assertApiKeyWorkspaceOwner(keyId: string, ownerUserId: string): Promise<void> {
    const key = await this.prisma.apiKey.findUnique({
      where: { id: keyId },
      select: { id: true, agent: { select: { workspace: { select: { ownerId: true } } } } },
    });
    if (!key) throw new NotFoundException('API key not found');
    this.assertWorkspaceOwner(ownerUserId, key.agent.workspace.ownerId);
  }

  private parseExplicitExpiry(value: unknown): Date {
    if (typeof value !== 'string' || !EXPLICIT_EXPIRY_WITH_ZONE.test(value)) {
      throw new BadRequestException('expiresAt must be an ISO-8601 timestamp with a timezone');
    }
    const expiryMs = Date.parse(value);
    const nowMs = Date.now();
    if (
      !Number.isFinite(expiryMs) ||
      expiryMs <= nowMs ||
      expiryMs > nowMs + MAX_AGENT_KEY_LIFETIME_MS
    ) {
      throw new BadRequestException('expiresAt must be in the future and no more than 7 days away');
    }
    return new Date(expiryMs);
  }
}
