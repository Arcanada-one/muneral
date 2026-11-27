import {
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import type { JWTVerifyGetKey } from 'jose';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ARCANA_KEY_SOURCE } from './arcana-key-source.js';
import {
  ARCANA_ALGORITHM,
  ArcanaKeysUnavailable,
  ArcanaTokenRejected,
  unverifiedAlgorithm,
  verifyArcanaAccessToken,
  type ArcanaAccessToken,
} from './arcana-token.verifier.js';

/** Error code of a valid Auth Arcana user who has no local Muneral user. */
export const ARCANA_UNLINKED_CODE = 'auth_identity_unlinked';

export interface ArcanaPrincipal {
  /** The LOCAL user: every downstream guard and row keeps working on local ids. */
  user: User;
  /** Token `exp`, in seconds since the epoch. */
  expiresAt: number;
}

/**
 * Authenticates an Auth Arcana access token and maps it to the local user through
 * `auth_identity_links`. It reads only: it never creates a user or a link.
 */
@Injectable()
export class ArcanaAuthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ARCANA_KEY_SOURCE) private readonly keys: JWTVerifyGetKey | null,
  ) {}

  /**
   * Whether this token belongs to the Auth Arcana verifier. When it does, the legacy verifier
   * never sees it; when it does not, this verifier never does. A failure in one is final.
   */
  routes(token: string): boolean {
    return this.keys !== null && unverifiedAlgorithm(token) === ARCANA_ALGORITHM;
  }

  async authenticate(token: string): Promise<ArcanaPrincipal> {
    if (this.keys === null) throw new UnauthorizedException();

    let verified: ArcanaAccessToken;
    try {
      verified = await verifyArcanaAccessToken(token, this.keys);
    } catch (error) {
      if (error instanceof ArcanaTokenRejected) throw new UnauthorizedException();
      if (error instanceof ArcanaKeysUnavailable) {
        throw new ServiceUnavailableException(error.message);
      }
      throw error;
    }

    const link = await this.prisma.authIdentityLink.findUnique({
      where: { authUserId: verified.sub },
      include: { user: true },
    });
    if (!link) {
      throw new ForbiddenException({
        statusCode: 403,
        error: ARCANA_UNLINKED_CODE,
        message: 'This Auth Arcana account is not linked to a Muneral user',
      });
    }
    return { user: link.user, expiresAt: verified.expiresAt };
  }
}
