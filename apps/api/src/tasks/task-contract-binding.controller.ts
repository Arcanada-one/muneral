import { Body, Controller, ForbiddenException, Param, Patch, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Request } from 'express';
import type { Actor } from '@muneral/types';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard.js';
import { AgentTaskScopeGuard } from '../auth/guards/agent-task-scope.guard.js';
import type { AgentScopeContext } from '../auth/guards/agent-task-scope.guard.js';
import { AgentScope } from '../auth/agent-scope.decorator.js';
import { ActorInterceptor } from '../common/interceptors/actor.interceptor.js';
import { UpdateTaskContractDto } from './dto/update-task-contract.dto.js';
import { TaskContractBindingService } from './task-contract-binding.service.js';

type ScopedRequest = Request & { actor: Actor; agentScope?: AgentScopeContext };

@Controller('tasks')
@UseGuards(JwtOrApiKeyGuard, AgentTaskScopeGuard)
@UseInterceptors(ActorInterceptor)
export class TaskContractBindingController {
  constructor(private readonly binding: TaskContractBindingService) {}

  @Patch(':taskId/contract')
  // Reuse the existing creator/executor custody predicate, not a new scope
  // enum or grant. The binding service separately enforces pointer CAS.
  @AgentScope('task-status')
  bind(@Param('taskId') taskId: string, @Req() req: ScopedRequest, @Body() dto: UpdateTaskContractDto) {
    // Keep metadata consumption at the guarded HTTP boundary. Passing the
    // whole context into a service lets every future scope kind escape the
    // exhaustive guard; the service needs only the checked status authority.
    const scope = req.agentScope;
    if (!scope || scope.kind !== 'task-status') {
      throw new ForbiddenException({ code: 'AGENT_CONTRACT_SCOPE_REQUIRED' });
    }
    return this.binding.bind(taskId, req.actor, true, scope.agentId, scope.workspaceId, dto);
  }
}
