import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Actor } from '@muneral/types';
import { PrismaService } from '../prisma/prisma.service.js';
import { ActivityService } from '../activity/activity.service.js';
import type { AgentScopeContext } from '../auth/guards/agent-task-scope.guard.js';
import { agentStatusAuthorityWhere } from '../auth/agent-task-visibility.js';
import { UpdateTaskContractDto } from './dto/update-task-contract.dto.js';

export const CONTRACT_BINDING_ACTION = 'task:contract_binding_set';

/** Changes the pointer only, not KC2 admission or an in-flight effect lease. */
@Injectable()
export class TaskContractBindingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  async bind(taskId: string, actor: Actor, scope: AgentScopeContext | undefined, dto: UpdateTaskContractDto) {
    // JWT requests carry no agent scope. Do not turn this new mutation into an
    // unscoped human door or borrow the intake service's agent identity.
    if (actor?.type !== 'agent' || scope?.kind !== 'task-status' ||
        scope.agentId !== actor.id || !scope.workspaceId) {
      throw new ForbiddenException({ code: 'AGENT_CONTRACT_SCOPE_REQUIRED' });
    }
    const workspaceId = scope.workspaceId;
    const authority = {
      id: taskId,
      project: { workspaceId },
      ...agentStatusAuthorityWhere(actor.id),
    };
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.task.findFirst({ where: authority });
      if (!task) throw new ForbiddenException({ code: 'TASK_CONTRACT_FORBIDDEN' });
      // One database UPDATE includes both current ownership and expected digest.
      // Under READ COMMITTED PostgreSQL rechecks the predicate after a row-lock
      // wait. Two concurrent requests with one expected value cannot both win.
      const changed = await tx.task.updateMany({
        where: {
          ...authority,
          contractDigest: dto.expectedContractDigest,
          ...(dto.expectedProjectId ? { projectId: dto.expectedProjectId } : {}),
        },
        data: { contractDigest: dto.contractDigest },
      });
      if (changed.count !== 1) {
        const stillOwn = await tx.task.findFirst({ where: authority, select: { id: true } });
        if (!stillOwn) throw new ForbiddenException({ code: 'TASK_CONTRACT_FORBIDDEN' });
        throw new ConflictException({ code: 'BINDING_CONFLICT' });
      }
      const updated = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
      await this.activity.log({
        workspaceId,
        taskId,
        actor,
        action: CONTRACT_BINDING_ACTION,
        payload: {
          expectedProjectId: dto.expectedProjectId ?? null,
          expectedContractDigest: dto.expectedContractDigest,
          contractDigest: dto.contractDigest,
        },
      }, tx);
      return updated;
    }, { isolationLevel: 'ReadCommitted', timeout: 10_000 });
  }
}
