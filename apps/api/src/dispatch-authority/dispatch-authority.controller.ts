import {
  Body,
  Controller,
  ForbiddenException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AgentScope } from '../auth/agent-scope.decorator.js';
import { AgentTaskScopeGuard } from '../auth/guards/agent-task-scope.guard.js';
import { JwtOrApiKeyGuard } from '../auth/guards/jwt-or-api-key.guard.js';
import { DispatchPrincipalGuard } from './dispatch-principal.guard.js';
import { DispatchAuthorityService } from './dispatch-authority.service.js';
import { BindTerminalDispatchDto, IssueDispatchDto } from './dispatch-authority.dto.js';
import type { DispatchPrincipal } from './dispatch-authority.types.js';

type DispatchRequest = Request & { dispatchPrincipal?: DispatchPrincipal };

/** Authenticated native Tasks API for Muneral-owned dispatch authority.
 * Start consumes the one-use Muneral binding; it does not launch an agent.
 */
@Controller('tasks/:taskId/dispatches')
@UseGuards(JwtOrApiKeyGuard, AgentTaskScopeGuard, DispatchPrincipalGuard)
export class DispatchAuthorityController {
  constructor(private readonly dispatches: DispatchAuthorityService) {}

  @Post()
  @AgentScope('task-status')
  issue(
    @Param('taskId') taskId: string,
    @Body() dto: IssueDispatchDto,
    @Req() req: DispatchRequest,
  ) {
    return this.dispatches.issue(taskId, this.requirePrincipal(req), dto);
  }

  @Post(':launchAttemptId/:dispatchId/terminal-binding')
  @AgentScope('task-status')
  bindTerminal(
    @Param('taskId') taskId: string,
    @Param('launchAttemptId') launchAttemptId: string,
    @Param('dispatchId') dispatchId: string,
    @Body() dto: BindTerminalDispatchDto,
    @Req() req: DispatchRequest,
  ) {
    return this.dispatches.bindTerminal(
      taskId,
      launchAttemptId,
      dispatchId,
      this.requirePrincipal(req),
      dto.terminalDeclarationId,
    );
  }

  @Post(':launchAttemptId/:dispatchId/start')
  @AgentScope('task-status')
  consumeForStart(
    @Param('taskId') taskId: string,
    @Param('launchAttemptId') launchAttemptId: string,
    @Param('dispatchId') dispatchId: string,
    @Req() req: DispatchRequest,
  ) {
    return this.dispatches.consumeForStart(
      taskId,
      launchAttemptId,
      dispatchId,
      this.requirePrincipal(req),
    );
  }

  @Post(':launchAttemptId/:dispatchId/revoke')
  @AgentScope('task-status')
  revoke(
    @Param('taskId') taskId: string,
    @Param('launchAttemptId') launchAttemptId: string,
    @Param('dispatchId') dispatchId: string,
    @Req() req: DispatchRequest,
  ) {
    return this.dispatches.revoke(
      taskId,
      launchAttemptId,
      dispatchId,
      this.requirePrincipal(req),
    );
  }

  private requirePrincipal(req: DispatchRequest): DispatchPrincipal {
    if (!req.dispatchPrincipal) {
      throw new ForbiddenException('Task dispatch is not authorized.');
    }
    return req.dispatchPrincipal;
  }
}
