import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service.js';
// ESM has no injected globals, so `jest` must be imported for the RUNTIME.
// Its type, though, comes from @types/jest (already in tsconfig `types`),
// which is what the 339 existing jest.fn() call sites are written against —
// @jest/globals ships a stricter generic whose bare jest.fn() infers `never`
// and would red 416 lines that are not otherwise wrong. Value from one,
// type from the other.
import { jest as _jestRuntime } from '@jest/globals';
// Intersection, not a plain cast to globalThis.jest: `unstable_mockModule` exists
// only on the @jest/globals object, while the 339 existing `jest.fn()` call sites
// are written against @types/jest (whose bare fn() infers a usable type where the
// @jest/globals generic infers `never`). Value from one, each half of the type
// from the one that declares it.
const jest = _jestRuntime as unknown as typeof globalThis.jest &
  Pick<typeof _jestRuntime, 'unstable_mockModule'>;

// Mock bcrypt to speed up tests (no real hashing).
//
// ESM has no hoisting for module mocks: `jest.mock` runs where it is written,
// which is AFTER the static imports have already resolved, so the real bcrypt
// would be the one AuthService holds. `unstable_mockModule` registers the mock
// against the module registry first, and the subject is then pulled in with a
// dynamic import so it resolves to the mocked copy. Both are awaited at module
// top level, which the ESM runner permits.
const bcrypt = {
  hash: jest.fn((value: string) => Promise.resolve(`hashed:${value}`)),
  compare: jest.fn((plain: string, hash: string) =>
    Promise.resolve(hash === `hashed:${plain}`),
  ),
};
jest.unstable_mockModule('bcrypt', () => bcrypt);

const { AuthService } = await import('../src/auth/auth.service.js');
type AuthService = InstanceType<typeof AuthService>;

const makePrisma = () => ({
  user: {
    findUnique: jest.fn(),
    create: jest.fn((args) => Promise.resolve({ id: 'user-1', ...args.data })),
  },
  apiKey: {
    findUnique: jest.fn(),
    create: jest.fn((args) => Promise.resolve({ id: 'key-1', ...args.data })),
    update: jest.fn((args) => Promise.resolve({ id: args.where.id, ...args.data })),
    findMany: jest.fn().mockResolvedValue([]),
  },
});

const makeJwtService = () => ({
  sign: jest.fn((payload, opts) => `jwt.${JSON.stringify(payload)}.${JSON.stringify(opts)}`),
  verify: jest.fn(),
});

describe('AuthService', () => {
  let service: AuthService;
  let prisma: ReturnType<typeof makePrisma>;
  let jwtService: ReturnType<typeof makeJwtService>;

  beforeEach(async () => {
    prisma = makePrisma();
    jwtService = makeJwtService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: JwtService, useValue: jwtService },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('signAccess', () => {
    it('signs an access token with sub and type:access', () => {
      const token = service.signAccess('user-123');
      expect(jwtService.sign).toHaveBeenCalledWith(
        { sub: 'user-123', type: 'access' },
        expect.objectContaining({ expiresIn: expect.any(String) }),
      );
      expect(token).toContain('jwt.');
    });
  });

  describe('signRefresh', () => {
    it('signs a refresh token with sub and type:refresh', () => {
      service.signRefresh('user-123');
      expect(jwtService.sign).toHaveBeenCalledWith(
        { sub: 'user-123', type: 'refresh' },
        expect.objectContaining({ expiresIn: expect.any(String) }),
      );
    });
  });

  describe('verifyTelegramLogin', () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
      process.env = { ...OLD_ENV, TELEGRAM_BOT_TOKEN: 'test-bot-token' };
    });

    afterEach(() => {
      process.env = OLD_ENV;
    });

    it('returns false for tampered hash', () => {
      const dto = {
        id: 12345,
        first_name: 'Pavel',
        auth_date: Math.floor(Date.now() / 1000),
        hash: 'invalidhash1234567890abcdef1234567890abcdef1234567890abcdef12345678',
      };
      const result = service.verifyTelegramLogin(dto);
      expect(result).toBe(false);
    });

    it('throws BadRequestException when bot token not configured', () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      const dto = {
        id: 1,
        first_name: 'T',
        auth_date: 1,
        hash: 'abc',
      };
      expect(() => service.verifyTelegramLogin(dto)).toThrow(BadRequestException);
    });
  });

  describe('createApiKey', () => {
    it('returns a raw key with mun_sk_ prefix', async () => {
      const { key, keyId } = await service.createApiKey('agent-1', 'test');
      expect(key).toMatch(/^mun_sk_/);
      expect(keyId).toBe('key-1');
      expect(prisma.apiKey.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ agentId: 'agent-1', label: 'test' }),
        }),
      );
    });

    it('stores a bcrypt hash of the key', async () => {
      await service.createApiKey('agent-1');
      expect(bcrypt.hash).toHaveBeenCalled();
      const createCall = (prisma.apiKey.create as jest.Mock).mock.calls[0][0];
      expect(createCall.data.keyHash).toMatch(/^hashed:/);
    });

    it('MUN-0051: stores the sha256 lookup id of the raw key, never the key itself', async () => {
      const { key } = await service.createApiKey('agent-1');
      const createCall = (prisma.apiKey.create as jest.Mock).mock.calls[0][0];
      expect(createCall.data.lookupHash).toBe(createHash('sha256').update(key).digest('hex'));
      expect(createCall.data.lookupHash).not.toContain(key.slice('mun_sk_'.length));
    });
  });

  describe('rotateApiKey', () => {
    it('throws UnauthorizedException when key not found', async () => {
      prisma.apiKey.findUnique.mockResolvedValue(null);
      await expect(service.rotateApiKey('missing-key')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws BadRequestException when key is already revoked', async () => {
      prisma.apiKey.findUnique.mockResolvedValue({
        id: 'key-1',
        agentId: 'agent-1',
        revokedAt: new Date(),
        label: null,
      });
      await expect(service.rotateApiKey('key-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('sets old key expires_at to 24h from now (grace period)', async () => {
      const existingKey = {
        id: 'key-1',
        agentId: 'agent-1',
        revokedAt: null,
        expiresAt: null,
        label: 'my-key',
      };
      prisma.apiKey.findUnique.mockResolvedValue(existingKey);
      prisma.apiKey.create.mockResolvedValue({ id: 'key-2', agentId: 'agent-1' });

      const before = Date.now();
      await service.rotateApiKey('key-1');
      const after = Date.now();

      // Find the update call for the old key
      const updateCalls = (prisma.apiKey.update as jest.Mock).mock.calls;
      const oldKeyUpdate = updateCalls.find(
        (call) => call[0].where?.id === 'key-1',
      );
      expect(oldKeyUpdate).toBeDefined();
      const expiresAt = oldKeyUpdate![0].data.expiresAt as Date;
      const gracePeriodMs = expiresAt.getTime() - before;
      // Grace period should be ~24h (86400000ms) with some tolerance
      expect(gracePeriodMs).toBeGreaterThan(86_390_000);
      expect(gracePeriodMs).toBeLessThanOrEqual(86_400_000 + (after - before));
    });
  });

  describe('revokeApiKey', () => {
    it('sets revoked_at on the key', async () => {
      prisma.apiKey.findUnique.mockResolvedValue({ id: 'key-1', revokedAt: null });

      await service.revokeApiKey('key-1');

      const updateCall = (prisma.apiKey.update as jest.Mock).mock.calls[0][0];
      expect(updateCall.data.revokedAt).toBeInstanceOf(Date);
    });

    it('throws UnauthorizedException when key not found', async () => {
      prisma.apiKey.findUnique.mockResolvedValue(null);
      await expect(service.revokeApiKey('missing')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('validateApiKey', () => {
    const RAW = 'mun_sk_validkey';
    const LOOKUP = createHash('sha256').update(RAW).digest('hex');
    const row = (over: Record<string, unknown> = {}) => ({
      id: 'key-1',
      keyHash: `hashed:${RAW}`,
      lookupHash: LOOKUP,
      revokedAt: null,
      expiresAt: null,
      agent: { id: 'agent-1', name: 'TestAgent' },
      ...over,
    });

    beforeEach(() => {
      bcrypt.compare.mockClear();
    });

    it('returns null for keys without mun_sk_ prefix', async () => {
      const result = await service.validateApiKey('sk-wrong-prefix');
      expect(result).toBeNull();
      expect(prisma.apiKey.findMany).not.toHaveBeenCalled();
      expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
    });

    it('returns null when no candidates match', async () => {
      const result = await service.validateApiKey('mun_sk_test');
      expect(result).toBeNull();
    });

    it('MUN-0051: finds the key by its lookup id and runs exactly ONE bcrypt comparison', async () => {
      const candidate = row();
      prisma.apiKey.findUnique.mockResolvedValue(candidate);

      const result = await service.validateApiKey(RAW);

      expect(result).toBe(candidate);
      expect(prisma.apiKey.findUnique).toHaveBeenCalledWith({
        where: { lookupHash: LOOKUP },
        include: { agent: true },
      });
      expect(bcrypt.compare).toHaveBeenCalledTimes(1);
      expect(bcrypt.compare).toHaveBeenCalledWith(RAW, candidate.keyHash);
      // The indexed hit never loads the other keys.
      expect(prisma.apiKey.findMany).not.toHaveBeenCalled();
    });

    it('MUN-0051: refuses a revoked or expired key found by lookup id, after the same one comparison', async () => {
      for (const over of [{ revokedAt: new Date() }, { expiresAt: new Date(Date.now() - 1000) }]) {
        bcrypt.compare.mockClear();
        prisma.apiKey.findUnique.mockResolvedValue(row(over));
        await expect(service.validateApiKey(RAW)).resolves.toBeNull();
        expect(bcrypt.compare).toHaveBeenCalledTimes(1);
        expect(prisma.apiKey.findMany).not.toHaveBeenCalled();
      }
    });

    it('MUN-0051: an unknown key still pays one bcrypt comparison (dummy hash) and scans only legacy rows', async () => {
      prisma.apiKey.findUnique.mockResolvedValue(null);

      await expect(service.validateApiKey('mun_sk_unknown')).resolves.toBeNull();

      expect(bcrypt.compare).toHaveBeenCalledTimes(1);
      const where = (prisma.apiKey.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where).toEqual(expect.objectContaining({ lookupHash: null, revokedAt: null }));
    });

    it('MUN-0051: a legacy key (no lookup id) still validates and back-fills its lookup id', async () => {
      prisma.apiKey.findUnique.mockResolvedValue(null);
      const legacy = row({ lookupHash: null });
      prisma.apiKey.findMany.mockResolvedValue([legacy]);

      const result = await service.validateApiKey(RAW);

      expect(result).toBe(legacy);
      expect(prisma.apiKey.update).toHaveBeenCalledWith({
        where: { id: 'key-1' },
        data: expect.objectContaining({ lookupHash: LOOKUP, lastUsedAt: expect.any(Date) }),
      });
    });
  });
});
