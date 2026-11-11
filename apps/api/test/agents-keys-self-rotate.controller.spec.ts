import { AgentsController } from '../src/agents/agents.controller.js';
import { jest as _jestRuntime } from '@jest/globals';

const jest = _jestRuntime as unknown as typeof globalThis.jest;

describe('AgentsController POST /agents/keys/self/rotate (MUN-0074)', () => {
  const agentsService = {
    rotateOwnApiKey: jest.fn(),
    rotateApiKey: jest.fn(),
  };

  beforeEach(() => {
    agentsService.rotateOwnApiKey.mockReset();
    agentsService.rotateApiKey.mockReset();
  });

  it('rotates only the presenting apiKeyId and never forwards a body key id', async () => {
    agentsService.rotateOwnApiKey.mockResolvedValue({
      key: 'mun_sk_new',
      keyId: 'key-new',
    });
    const controller = new AgentsController(agentsService as never);
    const req = {
      apiKeyId: 'key-old',
      apiKeyAgent: { id: 'agent-1', workspaceId: 'ws-1' },
    } as never;

    const result = await controller.rotateOwnApiKey(req);

    expect(agentsService.rotateOwnApiKey).toHaveBeenCalledWith('key-old', {
      id: 'agent-1',
      workspaceId: 'ws-1',
    });
    expect(result).toEqual({ key: 'mun_sk_new', keyId: 'key-new' });
    expect(JSON.stringify(result)).not.toMatch(/keyHash|lookupHash/);
  });

  it('declares static keys/self/rotate before parametric keys/:keyId/rotate', () => {
    // Nest registers methods in class order; self-rotate must precede :keyId
    // or mun_sk_ callers keep hitting JWT rotate with keyId=self (HTTP 401).
    const proto = Object.getOwnPropertyNames(AgentsController.prototype);
    expect(proto.indexOf('rotateOwnApiKey')).toBeGreaterThan(-1);
    expect(proto.indexOf('rotateApiKey')).toBeGreaterThan(-1);
    expect(proto.indexOf('rotateOwnApiKey')).toBeLessThan(proto.indexOf('rotateApiKey'));
  });
});
