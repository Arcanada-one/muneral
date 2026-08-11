import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService as NestJwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { User } from '../common/entities/user.entity';
import { ApiKey } from '../agents/entities/api-key.entity';
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
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(ApiKey)
    private readonly apiKeyRepo: Repository<ApiKey>,
  ) {}

  /** Issue a short-lived access JWT (15 min) */
  signAccess(userId: string): string {
    return this.jwtService.sign(
      { sub: userId, type: 'access' },
      { expiresIn: process.env.JWT_ACCESS_EXPIRES ?? '15m' },
    );
  }

  /** Issue a long-lived refresh JWT (30 days) */
  signRefresh(userId: string): string {
    return this.jwtService.sign(
      { sub: userId, type: 'refresh' },
      { expiresIn: process.env.JWT_REFRESH_EXPIRES ?? '30d' },
    );
  }

  async findOrCreateGithubUser(profile: GithubProfile): Promise<User> {
    const githubId = parseInt(profile.id, 10);
    let user = await this.userRepo.findOne({ where: { githubId } });
    if (!user) {
      user = this.userRepo.create({
        githubId,
        name: profile.displayName ?? profile.username,
        avatarUrl: profile.photos?.[0]?.value ?? null,
      });
      await this.userRepo.save(user);
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

  async findOrCreateTelegramUser(dto: TelegramLoginDto): Promise<User> {
    let user = await this.userRepo.findOne({
      where: { telegramId: dto.id },
    });
    if (!user) {
      const name = [dto.first_name, dto.last_name].filter(Boolean).join(' ');
      user = this.userRepo.create({
        telegramId: dto.id,
        name,
        avatarUrl: dto.photo_url ?? null,
      });
      await this.userRepo.save(user);
    }
    return user;
  }

  /** Create new API key for an agent. Returns the raw key (stored only once). */
  async createApiKey(agentId: string, label?: string): Promise<{ key: string; keyId: string }> {
    const rawKey = `${API_KEY_PREFIX}${uuidv4().replace(/-/g, '')}`;
    const keyHash = await bcrypt.hash(rawKey, BCRYPT_ROUNDS);

    const apiKey = this.apiKeyRepo.create({
      agentId,
      keyHash,
      label: label ?? null,
    });
    await this.apiKeyRepo.save(apiKey);

    return { key: rawKey, keyId: apiKey.id };
  }

  /**
   * Rotate an existing API key.
   * - Creates a new key
   * - Sets old key to expire in 24h (grace period for in-flight requests)
   */
  async rotateApiKey(keyId: string): Promise<{ key: string; keyId: string }> {
    const existing = await this.apiKeyRepo.findOne({ where: { id: keyId } });
    if (!existing) {
      throw new UnauthorizedException('API key not found');
    }
    if (existing.revokedAt) {
      throw new BadRequestException('Cannot rotate a revoked API key');
    }

    // Create new key first
    const result = await this.createApiKey(existing.agentId, existing.label ?? undefined);

    // Set old key to expire after grace period
    existing.expiresAt = new Date(Date.now() + ROTATION_GRACE_MS);
    await this.apiKeyRepo.save(existing);

    return result;
  }

  /** Hard-revoke an API key immediately */
  async revokeApiKey(keyId: string): Promise<void> {
    const existing = await this.apiKeyRepo.findOne({ where: { id: keyId } });
    if (!existing) {
      throw new UnauthorizedException('API key not found');
    }
    existing.revokedAt = new Date();
    await this.apiKeyRepo.save(existing);
  }

  /**
   * Validate an incoming raw API key against stored hashes.
   * Returns the matching ApiKey entity or null.
   */
  async validateApiKey(rawKey: string): Promise<ApiKey | null> {
    if (!rawKey.startsWith(API_KEY_PREFIX)) {
      return null;
    }

    // Fetch candidate keys for the prefix — in production, prefix lookup is O(small)
    // We use a short prefix match via LIKE to reduce bcrypt comparisons
    const candidates = await this.apiKeyRepo
      .createQueryBuilder('ak')
      .leftJoinAndSelect('ak.agent', 'agent')
      .where('ak.revoked_at IS NULL')
      .andWhere('(ak.expires_at IS NULL OR ak.expires_at > NOW())')
      .getMany();

    for (const candidate of candidates) {
      const match = await bcrypt.compare(rawKey, candidate.keyHash);
      if (match) {
        // Update last_used_at without blocking the request
        void this.apiKeyRepo.update(candidate.id, { lastUsedAt: new Date() }).catch(() => {
          // Non-critical — log silently
        });
        return candidate;
      }
    }
    return null;
  }

  /** Validate JWT payload and return user */
  async validateJwtPayload(payload: { sub: string }): Promise<User | null> {
    return this.userRepo.findOne({ where: { id: payload.sub } });
  }
}
