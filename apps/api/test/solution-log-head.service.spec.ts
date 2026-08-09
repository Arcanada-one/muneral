import { ConflictException } from '@nestjs/common';
import { SolutionLogHeadService } from '../src/solution-log-head/solution-log-head.service';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

function proposal() {
  return {
    schemaVersion: 'v0',
    kind: 'solution-log-head-proposal',
    taskRevision: 1,
    projectionDigestSha256: SHA_A,
    logRevision: 1,
    previousHeadDigestSha256: null,
    headDigestSha256: SHA_B,
    solutionLogDigestSha256: SHA_C,
    expectedProducerVersion: 0,
  };
}

describe('SolutionLogHeadService integrity failures', () => {
  it.each([
    { code: 'P2002', meta: { target: ['receipt_id'] } },
    { code: '23505', constraint: 'solution_log_head_receipts_head_unique' },
  ])('does not relabel $code uniqueness failures as a normal race', async (error) => {
    const prisma = { $transaction: jest.fn().mockRejectedValue(error) };
    const service = new SolutionLogHeadService(prisma as never);

    try {
      await service.commitHead(
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
        proposal(),
      );
      throw new Error('expected uniqueness failure');
    } catch (caught) {
      expect(caught).toBe(error);
      expect(caught).not.toBeInstanceOf(ConflictException);
    }
  });
});
