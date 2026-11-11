import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ApiKeyGuard } from '../src/auth/guards/api-key.guard.js';
import { AgentsController } from '../src/agents/agents.controller.js';
import { jest as _jestRuntime } from '@jest/globals';
const jest = _jestRuntime as unknown as typeof globalThis.jest;

describe('AgentsController GET /agents/me (MUN-0071)', () => {
  const service = {
    selfIdentity: jest.fn(),
    getAgentTasks: jest.fn(),
  };
  const controller = new AgentsController(service as never);
  const agent = {
    id: 'agent-from-api-key',
    workspaceId: 'ws-1',
    name: 'JANITOR-dev-mun-0071',
    model: 'auto',
    provider: 'cursor',
    createdAt: new Date('2026-11-10T13:00:00.000Z'),
  };
  const req = { apiKeyAgent: agent, apiKeyId: 'key-1' } as never;

  beforeEach(() => jest.clearAllMocks());

  it('guards me with ApiKeyGuard', () => {
    const method = AgentsController.prototype.me;
    expect(Reflect.getMetadata(GUARDS_METADATA, method)).toEqual([ApiKeyGuard]);
  });

  it('projects only the calling agent and apiKeyId from the request', () => {
    const projection = {
      id: agent.id,
      workspaceId: agent.workspaceId,
      name: agent.name,
      model: agent.model,
      provider: agent.provider,
      createdAt: agent.createdAt,
      apiKeyId: 'key-1',
    };
    service.selfIdentity.mockReturnValue(projection);
    expect(controller.me(req)).toEqual(projection);
    expect(service.selfIdentity).toHaveBeenCalledWith(agent, 'key-1');
  });

  it('does not call getAgentTasks for /me', () => {
    service.selfIdentity.mockReturnValue({ id: agent.id });
    controller.me(req);
    expect(service.getAgentTasks).not.toHaveBeenCalled();
  });
});

describe('AgentsService.selfIdentity (MUN-0071)', () => {
  it('returns the allowlisted self fields and never secret columns', async () => {
    const { AgentsService } = await import('../src/agents/agents.service.js');
    const service = new AgentsService({} as never, {} as never, {} as never);
    const agent = {
      id: 'a1',
      workspaceId: 'w1',
      name: 'runtime',
      model: null,
      provider: null,
      createdAt: new Date('2026-11-10T12:00:00.000Z'),
      capabilities: { secretTooling: true },
      apiKeys: [{ keyHash: 'should-not-leak' }],
    };
    const out = service.selfIdentity(agent, 'key-abc');
    expect(out).toEqual({
      id: 'a1',
      workspaceId: 'w1',
      name: 'runtime',
      model: null,
      provider: null,
      createdAt: agent.createdAt,
      apiKeyId: 'key-abc',
    });
    expect(out).not.toHaveProperty('capabilities');
    expect(out).not.toHaveProperty('apiKeys');
    expect(out).not.toHaveProperty('keyHash');
    expect(out).not.toHaveProperty('lookupHash');
  });
});
