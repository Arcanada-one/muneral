import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ApiKeyGuard } from '../src/auth/guards/api-key.guard.js';
import { SolutionLogHeadController } from '../src/solution-log-head/solution-log-head.controller.js';
// vitest exposes describe/it/expect as globals (vitest.config.ts `globals: true`);
// `vi` is the one name that must be imported, exactly as `jest` had to be.
import { vi } from 'vitest';

describe('SolutionLogHeadController', () => {
  const service = {
    commitHead: vi.fn(),
    getCurrentHead: vi.fn(),
  };
  const controller = new SolutionLogHeadController(service as never);
  const req = { apiKeyAgent: { id: 'agent-from-api-key' } } as never;

  beforeEach(() => vi.clearAllMocks());

  it('is guarded by API-key authentication', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, SolutionLogHeadController)).toContain(
      ApiKeyGuard,
    );
  });

  it('derives the write principal only from req.apiKeyAgent', async () => {
    const body = { expectedProducerVersion: 0 };
    service.commitHead.mockResolvedValue({ receiptId: 'receipt' });
    await expect(
      controller.commitHead('task-1', 'attempt-1', body, req),
    ).resolves.toEqual({ receiptId: 'receipt' });
    expect(service.commitHead).toHaveBeenCalledWith(
      'task-1',
      'attempt-1',
      'agent-from-api-key',
      body,
    );
  });

  it('derives the read principal only from req.apiKeyAgent', async () => {
    service.getCurrentHead.mockResolvedValue({ receiptId: 'receipt' });
    await controller.getCurrentHead('task-1', 'attempt-1', req);
    expect(service.getCurrentHead).toHaveBeenCalledWith(
      'task-1',
      'attempt-1',
      'agent-from-api-key',
    );
  });
});
