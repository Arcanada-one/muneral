import { BadRequestException } from '@nestjs/common';
import { jest } from '@jest/globals';
import { AuthService } from './auth.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { JwtService } from '@nestjs/jwt';

describe('AuthService finite API key lifecycle', () => {
  let service: AuthService;
  let prisma: {
    apiKey: {
      create: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      apiKey: {
        create: jest.fn(async ({ data }) => ({ id: 'new-key', ...data })),
        findUnique: jest.fn(),
        update: jest.fn(async ({ where, data }) => ({ id: where.id, ...data })),
      },
    };
    service = new AuthService({} as JwtService, prisma as unknown as PrismaService);
  });

  it('stores only hash representations with the requested finite expiry and returns the secret once', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const result = await service.createApiKey('agent-1', 'test', expiresAt);
    const stored = prisma.apiKey.create.mock.calls[0][0].data;

    expect(result.key).toMatch(/^mun_sk_/);
    expect(result.keyId).toBe('new-key');
    expect(stored.expiresAt).toEqual(expiresAt);
    expect(stored.keyHash).toEqual(expect.any(String));
    expect(stored.lookupHash).toEqual(expect.any(String));
    expect(stored).not.toHaveProperty('key');
    expect(JSON.stringify(stored)).not.toContain(result.key);
  });

  it('refuses an invalid requested expiry before generating or storing a key', async () => {
    await expect(
      service.createApiKey('agent-1', 'test', new Date(Date.now() + 8 * 24 * 60 * 60 * 1000)),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.apiKey.create).not.toHaveBeenCalled();
  });

  it('refuses an omitted expiry before generating or storing a key', async () => {
    await expect(service.createApiKey('agent-1', 'test')).rejects.toThrow(BadRequestException);
    expect(prisma.apiKey.create).not.toHaveBeenCalled();
  });

  it('keeps both the replacement and grace period within the original expiry cutoff', async () => {
    const originalExpiry = new Date(Date.now() + 60 * 60 * 1000);
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 'old-key',
      agentId: 'agent-1',
      label: 'test',
      revokedAt: null,
      expiresAt: originalExpiry,
    });

    await service.rotateApiKey('old-key');

    const replacementExpiry = prisma.apiKey.create.mock.calls[0][0].data.expiresAt as Date;
    const oldExpiry = prisma.apiKey.update.mock.calls[0][0].data.expiresAt as Date;
    expect(replacementExpiry.getTime()).toBeLessThanOrEqual(originalExpiry.getTime());
    expect(oldExpiry.getTime()).toBeLessThanOrEqual(originalExpiry.getTime());
  });

  it('refuses an already expired key without creating a replacement', async () => {
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 'old-key',
      agentId: 'agent-1',
      label: 'test',
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(service.rotateApiKey('old-key')).rejects.toThrow(BadRequestException);
    expect(prisma.apiKey.create).not.toHaveBeenCalled();
  });

  it('refuses an expired issued key at validation time', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const issued = await service.createApiKey('agent-1', 'test', expiresAt);
    const stored = prisma.apiKey.create.mock.calls[0][0].data;
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 'new-key',
      keyHash: stored.keyHash,
      lookupHash: stored.lookupHash,
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
      agent: { id: 'agent-1', name: 'test' },
    });

    await expect(service.validateApiKey(issued.key)).resolves.toBeNull();
  });

  it.each([
    ['revoked', { revokedAt: new Date(), expiresAt: null }],
    ['expired', { revokedAt: null, expiresAt: new Date(Date.now() - 1000) }],
  ])('refuses rotation of a %s key without creating a replacement', async (_state, state) => {
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 'old-key',
      agentId: 'agent-1',
      label: null,
      ...state,
    });

    await expect(service.rotateApiKey('old-key')).rejects.toThrow(BadRequestException);
    expect(prisma.apiKey.create).not.toHaveBeenCalled();
  });
});
