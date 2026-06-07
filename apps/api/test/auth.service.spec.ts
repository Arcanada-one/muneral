import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import * as bcrypt from 'bcrypt';

// Mock bcrypt to speed up tests (no real hashing)
jest.mock('bcrypt', () => ({
  hash: jest.fn((value: string) => Promise.resolve(`hashed:${value}`)),
  compare: jest.fn((plain: string, hash: string) =>
    Promise.resolve(hash === `hashed:${plain}`),
  ),
}));

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
    it('returns null for keys without mun_sk_ prefix', async () => {
      const result = await service.validateApiKey('sk-wrong-prefix');
      expect(result).toBeNull();
      expect(prisma.apiKey.findMany).not.toHaveBeenCalled();
    });

    it('returns null when no candidates match', async () => {
      const result = await service.validateApiKey('mun_sk_test');
      expect(result).toBeNull();
    });

    it('returns matched key on valid comparison', async () => {
      const candidate = {
        id: 'key-1',
        keyHash: 'hashed:mun_sk_validkey',
        agent: { id: 'agent-1', name: 'TestAgent' },
      };
      prisma.apiKey.findMany.mockResolvedValue([candidate]);

      const result = await service.validateApiKey('mun_sk_validkey');
      expect(result).toBe(candidate);
    });
  });
});
