import { GUARDS_METADATA } from '@nestjs/common/constants';
import { UnauthorizedException } from '@nestjs/common';
import { ApiKeyGuard } from '../src/auth/guards/api-key.guard.js';
import { AgentsController } from '../src/agents/agents.controller.js';
import { jest as _jestRuntime } from '@jest/globals';
const jest = _jestRuntime as unknown as typeof globalThis.jest;

describe('AgentsController GET /agents/keys/self (MUN-0072)', () => {
  const service = {
    ownApiKeyProjection: jest.fn(),
    getAgentTasks: jest.fn(),
    revokeOwnApiKey: jest.fn(),
  };
  const controller = new AgentsController(service as never);
  const agent = {
    id: 'agent-from-api-key',
    workspaceId: 'ws-1',
    name: 'JANITOR-dev-mun-0072',
  };
  const req = { apiKeyAgent: agent, apiKeyId: 'key-1' } as never;

  beforeEach(() => jest.clearAllMocks());

  it('guards ownApiKey with ApiKeyGuard', () => {
    const method = AgentsController.prototype.ownApiKey;
    expect(Reflect.getMetadata(GUARDS_METADATA, method)).toEqual([ApiKeyGuard]);
  });

  it('projects the calling key via (apiKeyId, agentId) from the request', async () => {
    const projection = {
      id: 'key-1',
      agentId: agent.id,
      label: 'runtime',
      lastUsedAt: new Date('2026-11-10T13:00:00.000Z'),
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date('2026-11-01T00:00:00.000Z'),
    };
    service.ownApiKeyProjection.mockResolvedValue(projection);
    await expect(controller.ownApiKey(req)).resolves.toEqual(projection);
    expect(service.ownApiKeyProjection).toHaveBeenCalledWith('key-1', agent.id);
  });

  it('does not call getAgentTasks or revoke for /keys/self', async () => {
    service.ownApiKeyProjection.mockResolvedValue({ id: 'key-1' });
    await controller.ownApiKey(req);
    expect(service.getAgentTasks).not.toHaveBeenCalled();
    expect(service.revokeOwnApiKey).not.toHaveBeenCalled();
  });
});

describe('AgentsService.ownApiKeyProjection (MUN-0072)', () => {
  it('returns only the allowlisted non-secret columns for the calling key', async () => {
    const { AgentsService } = await import('../src/agents/agents.service.js');
    const row = {
      id: 'key-1',
      agentId: 'a1',
      label: 'lane',
      lastUsedAt: new Date('2026-11-10T12:00:00.000Z'),
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date('2026-11-01T00:00:00.000Z'),
    };
    const prisma = {
      apiKey: {
        findFirst: jest.fn().mockResolvedValue(row),
      },
    };
    const service = new AgentsService(prisma as never, {} as never, {} as never);
    const out = await service.ownApiKeyProjection('key-1', 'a1');
    expect(prisma.apiKey.findFirst).toHaveBeenCalledWith({
      where: { id: 'key-1', agentId: 'a1' },
      select: {
        id: true,
        agentId: true,
        label: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
        createdAt: true,
      },
    });
    expect(out).toEqual(row);
    expect(out).not.toHaveProperty('keyHash');
    expect(out).not.toHaveProperty('lookupHash');
    expect(out).not.toHaveProperty('key');
  });

  it('refuses when the key is missing for the calling agent', async () => {
    const { AgentsService } = await import('../src/agents/agents.service.js');
    const prisma = {
      apiKey: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const service = new AgentsService(prisma as never, {} as never, {} as never);
    await expect(service.ownApiKeyProjection('key-missing', 'a1')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
