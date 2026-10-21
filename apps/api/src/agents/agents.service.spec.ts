import 'reflect-metadata';
import { jest } from '@jest/globals';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { Request } from 'express';
import type { User } from '@prisma/client';
import { AgentsController } from './agents.controller.js';
import { AgentsService } from './agents.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuthService } from '../auth/auth.service.js';
import type { ActivityService } from '../activity/activity.service.js';

describe('AgentsService API key ownership and requested expiry', () => {
  const ownerId = 'workspace-owner';
  const futureExpiry = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
  let service: AgentsService;
  let prisma: {
    agent: { findUnique: jest.Mock };
    apiKey: { findUnique: jest.Mock };
  };
  let auth: {
    createApiKey: jest.Mock;
    rotateApiKey: jest.Mock;
    revokeApiKey: jest.Mock;
    revokeOwnApiKey: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      agent: { findUnique: jest.fn() },
      apiKey: { findUnique: jest.fn() },
    };
    auth = {
      createApiKey: jest.fn().mockResolvedValue({ keyId: 'key-1', key: 'one-time-secret' }),
      rotateApiKey: jest.fn(),
      revokeApiKey: jest.fn(),
      revokeOwnApiKey: jest.fn(),
    };
    service = new AgentsService(
      prisma as unknown as PrismaService,
      auth as unknown as AuthService,
      {} as ActivityService,
    );
  });

  it('issues only for the server-resolved workspace owner and passes the explicit finite expiry', async () => {
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-1',
      workspace: { ownerId },
    });
    const expiresAt = futureExpiry();

    await service.createApiKey('agent-1', { label: 'test', expiresAt }, ownerId);

    expect(auth.createApiKey).toHaveBeenCalledWith('agent-1', 'test', new Date(expiresAt));
  });

  it('refuses another workspace member before issuing a key', async () => {
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-1',
      workspace: { ownerId },
    });

    await expect(
      service.createApiKey('agent-1', { expiresAt: futureExpiry() }, 'workspace-member'),
    ).rejects.toThrow(ForbiddenException);
    expect(auth.createApiKey).not.toHaveBeenCalled();
  });

  it('refuses a different workspace owner and an absent JWT identity', async () => {
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-1',
      workspace: { ownerId },
    });

    await expect(
      service.createApiKey('agent-1', { expiresAt: futureExpiry() }, 'other-workspace-owner'),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.createApiKey('agent-1', { expiresAt: futureExpiry() }, ''),
    ).rejects.toThrow(ForbiddenException);
    expect(auth.createApiKey).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['invalid', 'not-a-date'],
    ['past', new Date(Date.now() - 1000).toISOString()],
    ['over seven days', new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString()],
  ])('refuses %s expiry before issuing a key', async (_label, expiresAt) => {
    prisma.agent.findUnique.mockResolvedValue({
      id: 'agent-1',
      workspace: { ownerId },
    });

    await expect(
      service.createApiKey('agent-1', { expiresAt } as never, ownerId),
    ).rejects.toThrow(BadRequestException);
    expect(auth.createApiKey).not.toHaveBeenCalled();
  });

  it('requires the owning workspace identity for rotation and administrative revocation', async () => {
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 'key-1',
      agent: { workspace: { ownerId } },
    });

    await expect(service.rotateApiKey('key-1', 'other-user')).rejects.toThrow(
      ForbiddenException,
    );
    await expect(service.revokeApiKey('key-1', 'other-user')).rejects.toThrow(
      ForbiddenException,
    );
    expect(auth.rotateApiKey).not.toHaveBeenCalled();
    expect(auth.revokeApiKey).not.toHaveBeenCalled();
  });

  it('allows the owning workspace identity to rotate and administratively revoke', async () => {
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 'key-1',
      agent: { workspace: { ownerId } },
    });

    await service.rotateApiKey('key-1', ownerId);
    await service.revokeApiKey('key-1', ownerId);

    expect(auth.rotateApiKey).toHaveBeenCalledWith('key-1');
    expect(auth.revokeApiKey).toHaveBeenCalledWith('key-1');
  });

  it('keeps agent self-revocation bound to the authenticated agent context', async () => {
    const agent = { id: 'agent-1', workspaceId: 'workspace-1' };
    await service.revokeOwnApiKey('key-self', agent);
    expect(auth.revokeOwnApiKey).toHaveBeenCalledWith('key-self', agent);
  });

  it('keeps create, rotate, and administrative revoke on the JWT-only routes', () => {
    const methods = [
      AgentsController.prototype.createApiKey,
      AgentsController.prototype.rotateApiKey,
      AgentsController.prototype.revokeApiKey,
    ];
    for (const method of methods) {
      expect(Reflect.getMetadata(GUARDS_METADATA, method)).toContain(JwtAuthGuard);
    }
  });

  it('passes only the authenticated JWT user id as the owner identity', async () => {
    const createApiKey = jest.fn();
    const controller = new AgentsController({ createApiKey } as unknown as AgentsService);
    const dto = { label: 'test', expiresAt: futureExpiry() };

    await controller.createApiKey(
      'agent-1',
      dto,
      { user: { id: ownerId } } as unknown as Request & { user: User },
    );

    expect(createApiKey).toHaveBeenCalledWith('agent-1', dto, ownerId);
  });
});
