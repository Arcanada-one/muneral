import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ApiKeyGuard } from '../src/auth/guards/api-key.guard.js';
import { SolutionLogHeadController } from '../src/solution-log-head/solution-log-head.controller.js';
// ESM has no injected globals, so `jest` must be imported for the RUNTIME.
// Its type, though, comes from @types/jest (already in tsconfig `types`),
// which is what the 339 existing jest.fn() call sites are written against —
// @jest/globals ships a stricter generic whose bare jest.fn() infers `never`
// and would red 416 lines that are not otherwise wrong. Value from one,
// type from the other.
import { jest as _jestRuntime } from '@jest/globals';
const jest = _jestRuntime as unknown as typeof globalThis.jest;

describe('SolutionLogHeadController', () => {
  const service = {
    commitHead: jest.fn(),
    getCurrentHead: jest.fn(),
  };
  const controller = new SolutionLogHeadController(service as never);
  const req = { apiKeyAgent: { id: 'agent-from-api-key' } } as never;

  beforeEach(() => jest.clearAllMocks());

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
