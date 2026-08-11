import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { Request } from 'express';
import { Actor } from '@muneral/types';
import { User } from '../entities/user.entity';
import { Agent } from '../../agents/entities/agent.entity';

/**
 * ActorInterceptor — detects whether the request is authenticated via JWT (human)
 * or API Key (agent) and attaches `req.actor` for downstream handlers and services.
 *
 * Must run AFTER authentication guards have set req.user or req.apiKeyAgent.
 */
@Injectable()
export class ActorInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<
      Request & {
        user?: User;
        apiKeyAgent?: Agent;
        actor?: Actor;
      }
    >();

    if (req.apiKeyAgent) {
      req.actor = {
        type: 'agent',
        id: req.apiKeyAgent.id,
        name: req.apiKeyAgent.name,
      };
    } else if (req.user) {
      req.actor = {
        type: 'human',
        id: req.user.id,
        name: req.user.name,
      };
    }

    return next.handle();
  }
}
