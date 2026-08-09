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
  it('locks the executor assignment against role-only updates', async () => {
    const taskId = '11111111-1111-4111-8111-111111111111';
    const attemptId = '22222222-2222-4222-8222-222222222222';
    const principalId = '33333333-3333-4333-8333-333333333333';
    const queries: string[] = [];
    const tx = {
      task: { findUnique: jest.fn().mockResolvedValue({ id: taskId }) },
      taskExecutionAttempt: {
        findUnique: jest.fn().mockResolvedValue({ status: 'running' }),
      },
      solutionLogHeadReceipt: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      $queryRawUnsafe: jest.fn().mockImplementation(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM public.task_agents')) {
          return [{ role: 'executor' }];
        }
        if (sql.includes('FROM public.muneral_kb_task_changes')) {
          return [{ revision: 1n, deleted: false }];
        }
        if (sql.includes('FROM public.task_execution_state')) {
          return [{ aggregate_version: 2n, current_attempt_id: attemptId }];
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    };
    const prisma = {
      $transaction: jest.fn(
        async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
      ),
    };
    const service = new SolutionLogHeadService(prisma as never);

    await service.commitHead(taskId, attemptId, principalId, proposal());

    const assignmentQuery = queries.find((sql) =>
      sql.includes('FROM public.task_agents'),
    );
    expect(assignmentQuery).toMatch(/FOR SHARE\s*$/);
    expect(assignmentQuery).not.toContain('FOR KEY SHARE');
    expect(assignmentQuery).not.toContain('FOR NO KEY UPDATE');
  });

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
