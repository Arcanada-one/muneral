import { Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Request } from 'express';
import { AuthService } from '../auth.service.js';
import { getJwtSecret } from '../jwt-secret.js';
import { ArcanaAuthService } from '../arcana/arcana-auth.service.js';
import { LegacyAuthCounter } from '../arcana/legacy-auth.counter.js';
import type { User } from '@prisma/client';

const bearerToken = ExtractJwt.fromAuthHeaderAsBearerToken();

/** The two outcomes passport binds to each per-request copy of a strategy. */
interface PassportOutcome {
  success(user: User): void;
  error(error: unknown): void;
}

/**
 * The `jwt` strategy behind both JwtAuthGuard and the JWT branch of JwtOrApiKeyGuard, so both
 * accept the same tokens. It is the one place that chooses a verifier: an Auth Arcana token
 * (when that path is on) goes to ArcanaAuthService, everything else to the legacy HS256
 * verifier. Neither outcome falls through to the other.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly authService: AuthService,
    @Optional() private readonly arcanaAuth?: ArcanaAuthService,
    @Optional() private readonly legacyAuthCounter?: LegacyAuthCounter,
  ) {
    super({
      jwtFromRequest: bearerToken,
      ignoreExpiration: false,
      secretOrKey: getJwtSecret(),
      algorithms: ['HS256'],
    });
  }

  authenticate(req: Request, options?: unknown): void {
    const token = bearerToken(req);
    const arcanaAuth = this.arcanaAuth;
    if (token && arcanaAuth?.routes(token)) {
      const outcome = this as unknown as PassportOutcome;
      void arcanaAuth.authenticate(token).then(
        ({ user }) => outcome.success(user),
        (error: unknown) => outcome.error(error),
      );
      return;
    }
    super.authenticate(req, options as never);
  }

  async validate(payload: { sub: string; type: string }): Promise<User> {
    if (payload.type !== 'access') {
      throw new UnauthorizedException('Invalid token type');
    }
    const user = await this.authService.validateJwtPayload(payload);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    this.legacyAuthCounter?.record('http');
    return user;
  }
}
