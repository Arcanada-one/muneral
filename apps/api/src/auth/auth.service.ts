import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService as NestJwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../prisma/prisma.service.js';
import type { GithubProfile } from './dto/github-profile.dto.js';
import { TelegramLoginDto } from './dto/telegram-login.dto.js';

const API_KEY_PREFIX = 'mun_sk_';
const BCRYPT_ROUNDS = 12;
/** Grace period for rotated keys: 24 hours in milliseconds */
const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * MUN-0051: the indexed, non-secret lookup id of a raw key — sha256 hex of the
 * whole key. It only chooses which stored bcrypt hash to compare against; it
 * never authenticates on its own. The key format carries no id part
 * (`mun_sk_` + 32 hex of a UUIDv4), so the id is derived rather than parsed.
 */
export function apiKeyLookupHash(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

@Injectable()
export class AuthService {
  /** MUN-0051: a bcrypt hash of random bytes at the production cost, created
   *  once. An unknown key is compared against it so that "no such key" costs
   *  the same one bcrypt comparison as "wrong key" and "right key". */
  private dummyHash?: Promise<string>;

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
        lookupHash: apiKeyLookupHash(rawKey),
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
   *
   * MUN-0051: one indexed lookup by `lookup_hash`, then ONE bcrypt comparison.
   * Before, every non-revoked key was loaded and compared in turn — O(keys)
   * bcrypt per request (a test database with leaked keys went from 2 s to 30 s
   * per test). A miss, an expired key and a revoked key all still pay one
   * bcrypt comparison (against a dummy hash when no row was found), so timing
   * does not separate "unknown key" from "wrong key".
   *
   * Keys created before the migration have no lookup_hash. Only those rows are
   * still scanned, and only after the indexed lookup missed; the first
   * successful use writes the key's lookup_hash, after which it takes the
   * indexed path. The legacy scan therefore shrinks to the keys never used
   * since the deploy.
   */
  async validateApiKey(rawKey: string) {
    if (!rawKey.startsWith(API_KEY_PREFIX)) {
      return null;
    }

    const now = new Date();
    const lookupHash = apiKeyLookupHash(rawKey);
    const active = (row: { revokedAt: Date | null; expiresAt: Date | null }) =>
      row.revokedAt === null && (row.expiresAt === null || row.expiresAt > now);

    const keyed = await this.prisma.apiKey.findUnique({
      where: { lookupHash },
      include: { agent: true },
    });

    if (keyed) {
      const match = await bcrypt.compare(rawKey, keyed.keyHash);
      if (!match || !active(keyed)) return null;
      this.touchLastUsed(keyed.id, {});
      return keyed;
    }

    // Always exactly one comparison on the miss path before the legacy scan.
    await bcrypt.compare(rawKey, await this.getDummyHash());

    const legacy = await this.prisma.apiKey.findMany({
      where: {
        lookupHash: null,
        revokedAt: null,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: now } },
        ],
      },
      include: { agent: true },
    });

    for (const candidate of legacy) {
      const match = await bcrypt.compare(rawKey, candidate.keyHash);
      if (match) {
        this.touchLastUsed(candidate.id, { lookupHash });
        return candidate;
      }
    }
    return null;
  }

  /** Update last_used_at (and back-fill lookup_hash for a legacy key) without
   *  blocking the request. Non-critical: a failure leaves the key usable. */
  private touchLastUsed(id: string, extra: { lookupHash?: string }): void {
    void this.prisma.apiKey
      .update({
        where: { id },
        data: { lastUsedAt: new Date(), ...extra },
      })
      .catch(() => {
        // Non-critical
      });
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= bcrypt.hash(crypto.randomBytes(32).toString('hex'), BCRYPT_ROUNDS);
    return this.dummyHash;
  }

  /** Validate JWT payload and return user */
  async validateJwtPayload(payload: { sub: string }) {
    return this.prisma.user.findUnique({ where: { id: payload.sub } });
  }
}
