import { Body, Controller, Param, Patch, Req, UseGuards, UseInterceptors } from '@nestjs/common';
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
  @AgentScope('task-contract')
  bind(@Param('taskId') taskId: string, @Req() req: ScopedRequest, @Body() dto: UpdateTaskContractDto) {
    return this.binding.bind(taskId, req.actor, req.agentScope, dto);
  }
}
