import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { ApiKeyGuard } from './api-key.guard';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * JwtOrApiKeyGuard — accepts either a human JWT (`Bearer <jwt>`) or a
 * long-lived agent API key (`Bearer mun_sk_...`) on the same route.
 * Routes on the `mun_sk_` prefix so a 15m-expired JWT never falls through
 * to API-key validation (and vice versa) — each request is checked by
 * exactly one guard.
 */
@Injectable()
export class JwtOrApiKeyGuard implements CanActivate {
  constructor(
    private readonly apiKeyGuard: ApiKeyGuard,
    private readonly jwtAuthGuard: JwtAuthGuard,
  ) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const authHeader = req.headers['authorization'];

    if (authHeader?.startsWith('Bearer mun_sk_')) {
      return this.apiKeyGuard.canActivate(context);
    }
    return this.jwtAuthGuard.canActivate(context);
  }
}
