import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from '../auth.service';

/**
 * ApiKeyGuard — validates mun_sk_ prefixed Bearer tokens against api_keys table.
 * Sets req.apiKeyAgent with the resolved agent on success.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const authHeader = req.headers['authorization'];

    if (!authHeader?.startsWith('Bearer mun_sk_')) {
      throw new UnauthorizedException('API key required');
    }

    const rawKey = authHeader.slice('Bearer '.length);
    const apiKey = await this.authService.validateApiKey(rawKey);

    if (!apiKey) {
      throw new UnauthorizedException('Invalid or expired API key');
    }

    // Attach agent to request for downstream use
    (req as Request & { apiKeyAgent: typeof apiKey.agent }).apiKeyAgent = apiKey.agent;
    return true;
  }
}
