import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { ApiKeyGuard } from './api-key.guard';

/**
 * JwtOrApiKeyGuard — accepts either a long-lived `mun_sk_*` API key or a
 * short-lived (15m) access JWT. Lets agent-facing endpoints stay reachable
 * by an automated client past the JWT TTL without forcing a refresh dance,
 * while human/dashboard callers keep using the existing JWT flow unchanged.
 */
@Injectable()
export class JwtOrApiKeyGuard extends AuthGuard('jwt') {
  constructor(private readonly apiKeyGuard: ApiKeyGuard) {
    super();
  }

  canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const authHeader = req.headers['authorization'];

    if (authHeader?.startsWith('Bearer mun_sk_')) {
      return this.apiKeyGuard.canActivate(context);
    }

    return super.canActivate(context);
  }
}
