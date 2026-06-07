import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService as NestJwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../prisma/prisma.service';
import { GithubProfile } from './dto/github-profile.dto';
import { TelegramLoginDto } from './dto/telegram-login.dto';

const API_KEY_PREFIX = 'mun_sk_';
const BCRYPT_ROUNDS = 12;
/** Grace period for rotated keys: 24 hours in milliseconds */
const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: NestJwtService,
    private readonly prisma: PrismaService,
  ) {}

  /** Issue a short-lived access JWT (15 min) */
  signAccess(userId: string): string {
    return this.jwtService.sign(
      { sub: userId, type: 'access' },
      { expiresIn: (process.env.JWT_ACCESS_EXPIRES ?? '15m') as unknown as number },
    );
  }

  /** Issue a long-lived refresh JWT (30 days) */
  signRefresh(userId: string): string {
    return this.jwtService.sign(
      { sub: userId, type: 'refresh' },
      { expiresIn: (process.env.JWT_REFRESH_EXPIRES ?? '30d') as unknown as number },
    );
  }

  async findOrCreateGithubUser(profile: GithubProfile) {
    const githubId = BigInt(profile.id);
    let user = await this.prisma.user.findUnique({ where: { githubId } });
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          githubId,
          name: profile.displayName ?? profile.username,
          avatarUrl: profile.photos?.[0]?.value ?? null,
        },
      });
    }
    return user;
  }

  /**
   * Verify Telegram Login Widget hash (HMAC-SHA256).
   * See: https://core.telegram.org/widgets/login#checking-authorization
   */
  verifyTelegramLogin(dto: TelegramLoginDto): boolean {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      throw new BadRequestException('Telegram auth not configured');
    }

    // Build data-check-string (all fields except hash, sorted alphabetically)
    const { hash, ...rest } = dto;
    const dataCheckString = Object.keys(rest)
      .sort()
      .map((k) => `${k}=${(rest as Record<string, unknown>)[k]}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();

    const expectedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    // Constant-time comparison to prevent timing attacks
    const hashBuffer = Buffer.from(hash, 'hex');
    const expectedBuffer = Buffer.from(expectedHash, 'hex');
    if (hashBuffer.length !== expectedBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(hashBuffer, expectedBuffer);
  }

  async findOrCreateTelegramUser(dto: TelegramLoginDto) {
    const telegramId = BigInt(dto.id);
    let user = await this.prisma.user.findUnique({ where: { telegramId } });
    if (!user) {
      const name = [dto.first_name, dto.last_name].filter(Boolean).join(' ');
      user = await this.prisma.user.create({
        data: {
          telegramId,
          name,
          avatarUrl: dto.photo_url ?? null,
        },
      });
    }
    return user;
  }

  /** Create new API key for an agent. Returns the raw key (stored only once). */
  async createApiKey(agentId: string, label?: string): Promise<{ key: string; keyId: string }> {
    const rawKey = `${API_KEY_PREFIX}${uuidv4().replace(/-/g, '')}`;
    const keyHash = await bcrypt.hash(rawKey, BCRYPT_ROUNDS);

    const apiKey = await this.prisma.apiKey.create({
      data: {
        agentId,
        keyHash,
        label: label ?? null,
      },
    });

    return { key: rawKey, keyId: apiKey.id };
  }

  /**
   * Rotate an existing API key.
   * - Creates a new key
   * - Sets old key to expire in 24h (grace period for in-flight requests)
   */
  async rotateApiKey(keyId: string): Promise<{ key: string; keyId: string }> {
    const existing = await this.prisma.apiKey.findUnique({ where: { id: keyId } });
    if (!existing) {
      throw new UnauthorizedException('API key not found');
    }
    if (existing.revokedAt) {
      throw new BadRequestException('Cannot rotate a revoked API key');
    }

    // Create new key first
    const result = await this.createApiKey(existing.agentId, existing.label ?? undefined);

    // Set old key to expire after grace period
    await this.prisma.apiKey.update({
      where: { id: keyId },
      data: { expiresAt: new Date(Date.now() + ROTATION_GRACE_MS) },
    });

    return result;
  }

  /** Hard-revoke an API key immediately */
  async revokeApiKey(keyId: string): Promise<void> {
    const existing = await this.prisma.apiKey.findUnique({ where: { id: keyId } });
    if (!existing) {
      throw new UnauthorizedException('API key not found');
    }
    await this.prisma.apiKey.update({
      where: { id: keyId },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Validate an incoming raw API key against stored hashes.
   * Returns the matching ApiKey entity or null.
   */
  async validateApiKey(rawKey: string) {
    if (!rawKey.startsWith(API_KEY_PREFIX)) {
      return null;
    }

    const candidates = await this.prisma.apiKey.findMany({
      where: {
        revokedAt: null,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date() } },
        ],
      },
      include: { agent: true },
    });

    for (const candidate of candidates) {
      const match = await bcrypt.compare(rawKey, candidate.keyHash);
      if (match) {
        // Update last_used_at without blocking the request
        void this.prisma.apiKey.update({
          where: { id: candidate.id },
          data: { lastUsedAt: new Date() },
        }).catch(() => {
          // Non-critical
        });
        return candidate;
      }
    }
    return null;
  }

  /** Validate JWT payload and return user */
  async validateJwtPayload(payload: { sub: string }) {
    return this.prisma.user.findUnique({ where: { id: payload.sub } });
  }
}
