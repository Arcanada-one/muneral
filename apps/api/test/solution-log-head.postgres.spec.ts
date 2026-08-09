import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ExecutionAuthorityService } from '../src/execution-authority/execution-authority.service';
import type { Clock, IdSource } from '../src/execution-authority/execution-authority.types';
import {
  computeSolutionLogHeadReceiptId,
  SolutionLogHeadService,
  validateSolutionLogHeadReceiptV0,
} from '../src/solution-log-head';
import { createDisposablePostgres } from './support/disposable-postgres';

const pg = createDisposablePostgres('solution-log-head');
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);
const SHA_E = 'e'.repeat(64);

beforeAll(async () => pg.start(), 120_000);
afterAll(async () => pg.stop(), 30_000);

describe('SolutionLog head authority — PostgreSQL proofs', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let service: SolutionLogHeadService;
  let authority: ExecutionAuthorityService;
  let projectId: string;
  let primaryAgentId: string;
  let alternateAgentId: string;
  let unassignedAgentId: string;

  const clock: Clock = { now: () => new Date() };
  const idSource: IdSource = { generate: () => randomUUID() };

  beforeAll(async () => {
    const { PrismaClient } = require('@prisma/client');
    const { PrismaPg } = require('@prisma/adapter-pg');
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: pg.url() }) });
    service = new SolutionLogHeadService(prisma);
    authority = new ExecutionAuthorityService(clock, idSource);

    const ownerId = randomUUID();
    const workspaceId = randomUUID();
    projectId = randomUUID();
    primaryAgentId = randomUUID();
    alternateAgentId = randomUUID();
    unassignedAgentId = randomUUID();
    await prisma.user.create({ data: { id: ownerId, name: 'solution-log-owner' } });
    await prisma.workspace.create({
      data: { id: workspaceId, slug: `slh-${randomUUID()}`, name: 'solution-log-ws', ownerId },
    });
    await prisma.project.create({
      data: { id: projectId, workspaceId, slug: `slh-${randomUUID()}`, name: 'solution-log-project' },
    });
    for (const [id, name] of [
      [primaryAgentId, 'primary'],
      [alternateAgentId, 'alternate'],
      [unassignedAgentId, 'unassigned'],
    ]) {
      await prisma.agent.create({ data: { id, workspaceId, name } });
    }
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  async function runningTask(): Promise<{ taskId: string; attemptId: string; taskRevision: number }> {
    const taskId = randomUUID();
    await prisma.task.create({
      data: { id: taskId, projectId, title: 'solution-log task', status: 'in_progress' },
    });
    await prisma.taskAgent.createMany({
      data: [
        { taskId, agentId: primaryAgentId, role: 'executor' },
        { taskId, agentId: alternateAgentId, role: 'reviewer' },
      ],
    });
    const issued = await authority.executeCommand(prisma, {
      kind: 'issue_initial_attempt', taskId, expectedVersion: 0,
      idempotencyKey: `issue-${randomUUID()}`, causationId: 'cause',
      correlationId: 'correlation', retryBudget: 2, retryBackoffMs: 1000,
      evidenceRefs: [],
    });
    if (issued instanceof Error) throw issued;
    const attemptId = issued.state.currentAttemptId;
    if (!attemptId) throw new Error('missing issued attempt');
    const started = await authority.executeCommand(prisma, {
      kind: 'transition_attempt', taskId, attemptId, expectedVersion: 1,
      eventType: 'attempt:started', idempotencyKey: `start-${randomUUID()}`,
      causationId: 'cause', correlationId: 'correlation', evidenceRefs: [],
      payload: {}, committedResult: {},
    });
    if (started instanceof Error) throw started;
    const revision = await prisma.muneralKbTaskChange.findUnique({ where: { taskId } });
    return { taskId, attemptId, taskRevision: Number(revision.revision) };
  }

  function proposal(
    taskRevision: number,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      schemaVersion: 'v0', kind: 'solution-log-head-proposal', taskRevision,
      projectionDigestSha256: SHA_A, logRevision: 1,
      previousHeadDigestSha256: null, headDigestSha256: SHA_B,
      solutionLogDigestSha256: SHA_C, expectedProducerVersion: 0,
      ...overrides,
    };
  }

  it('commits and reads a content-addressed provenance-only receipt from current execution state', async () => {
    const { taskId, attemptId, taskRevision } = await runningTask();
    const completionsBefore = await prisma.taskCommittedResultRef.count({ where: { taskId } });
    const receipt = await service.commitHead(
      taskId, attemptId, primaryAgentId, proposal(taskRevision),
    );
    expect(receipt).toMatchObject({
      taskId, attemptId, principalId: primaryAgentId, taskRevision,
      executionAggregateVersion: 2, producerVersion: 1,
      provenanceScope: 'PRODUCER_AUTHENTICATED_ONLY',
      modelUseStatus: 'NOT_AUTHORIZED',
    });
    expect(validateSolutionLogHeadReceiptV0(receipt)).toEqual(receipt);
    const { receiptId, ...withoutId } = receipt;
    expect(computeSolutionLogHeadReceiptId(withoutId)).toBe(receiptId);
    await expect(service.getCurrentHead(taskId, attemptId, primaryAgentId)).resolves.toEqual(receipt);
    expect(await prisma.taskCommittedResultRef.count({ where: { taskId } })).toBe(completionsBefore);
  });

  it.each([
    ['task revision', (r: number) => ({ taskRevision: r + 1 })],
    ['prior head', () => ({ previousHeadDigestSha256: SHA_D, expectedProducerVersion: 1 })],
    ['log revision', () => ({ logRevision: 2 })],
  ])('rejects a wrong %s with zero writes', async (_name, change) => {
    const { taskId, attemptId, taskRevision } = await runningTask();
    const before = await prisma.solutionLogHeadReceipt.count({ where: { taskId } });
    await expect(
      service.commitHead(taskId, attemptId, primaryAgentId, proposal(taskRevision, change(taskRevision))),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await prisma.solutionLogHeadReceipt.count({ where: { taskId } })).toBe(before);
  });

  it('binds the established chain to its API-key principal and projection', async () => {
    const { taskId, attemptId, taskRevision } = await runningTask();
    await expect(
      service.commitHead(
        taskId,
        attemptId,
        alternateAgentId,
        proposal(taskRevision),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      await prisma.solutionLogHeadReceipt.count({ where: { taskId } }),
    ).toBe(0);
    const first = await service.commitHead(taskId, attemptId, primaryAgentId, proposal(taskRevision));
    const next = proposal(taskRevision, {
      logRevision: 2, previousHeadDigestSha256: first.headDigestSha256,
      headDigestSha256: SHA_D, solutionLogDigestSha256: SHA_E,
      expectedProducerVersion: 1,
    });
    await expect(
      service.commitHead(taskId, attemptId, alternateAgentId, next),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.commitHead(taskId, attemptId, primaryAgentId, {
        ...next, projectionDigestSha256: 'f'.repeat(64),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.commitHead(taskId, attemptId, primaryAgentId, {
        ...next, expectedProducerVersion: 2,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await prisma.solutionLogHeadReceipt.count({ where: { taskId } })).toBe(1);
  });

  it('refuses an unassigned principal, a non-current attempt, and a non-running attempt', async () => {
    const running = await runningTask();
    await expect(
      service.commitHead(running.taskId, running.attemptId, unassignedAgentId, proposal(running.taskRevision)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.commitHead(running.taskId, randomUUID(), primaryAgentId, proposal(running.taskRevision)),
    ).rejects.toBeInstanceOf(ConflictException);

    const taskId = randomUUID();
    await prisma.task.create({ data: { id: taskId, projectId, title: 'issued task' } });
    await prisma.taskAgent.create({ data: { taskId, agentId: primaryAgentId, role: 'executor' } });
    const issued = await authority.executeCommand(prisma, {
      kind: 'issue_initial_attempt', taskId, expectedVersion: 0,
      idempotencyKey: `issue-${randomUUID()}`, causationId: 'cause',
      correlationId: 'correlation', retryBudget: 1, retryBackoffMs: 1000,
      evidenceRefs: [],
    });
    if (issued instanceof Error || !issued.state.currentAttemptId) throw new Error('seed failed');
    const revision = await prisma.muneralKbTaskChange.findUnique({ where: { taskId } });
    await expect(
      service.commitHead(taskId, issued.state.currentAttemptId, primaryAgentId, proposal(Number(revision.revision))),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('keeps executor authorization stable until the receipt transaction commits', async () => {
    const { taskId, attemptId, taskRevision } = await runningTask();
    const { PrismaClient } = require('@prisma/client');
    const { PrismaPg } = require('@prisma/adapter-pg');
    const holder = new PrismaClient({
      adapter: new PrismaPg({ connectionString: pg.url() }),
    });
    const updater = new PrismaClient({
      adapter: new PrismaPg({ connectionString: pg.url() }),
    });
    let releaseStateLock!: () => void;
    let signalStateLock!: () => void;
    const stateLockHeld = new Promise<void>((resolve) => {
      releaseStateLock = resolve;
    });
    const stateLockTaken = new Promise<void>((resolve) => {
      signalStateLock = resolve;
    });
    const holderTx = holder.$transaction(
      async (tx: any) => {
        await tx.$queryRawUnsafe(
          `SELECT aggregate_version FROM public.task_execution_state
            WHERE task_id = $1::uuid
            FOR UPDATE`,
          taskId,
        );
        signalStateLock();
        await stateLockHeld;
      },
      { maxWait: 20_000, timeout: 60_000 },
    );

    let pendingReceipt: Promise<unknown> | undefined;
    let roleUpdateError: unknown;
    try {
      await stateLockTaken;
      pendingReceipt = service.commitHead(
        taskId,
        attemptId,
        primaryAgentId,
        proposal(taskRevision),
      );
      await waitUntilBlockedOnLock(prisma);
      try {
        await updater.$transaction(async (tx: any) => {
          await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '250ms'");
          await tx.$executeRawUnsafe(
            `UPDATE public.task_agents
                SET role = 'reviewer'
              WHERE task_id = $1::uuid AND agent_id = $2::uuid`,
            taskId,
            primaryAgentId,
          );
        });
      } catch (error) {
        roleUpdateError = error;
      }
    } finally {
      releaseStateLock();
      try {
        await holderTx;
      } finally {
        await Promise.allSettled([
          holder.$disconnect(),
          updater.$disconnect(),
        ]);
      }
    }

    if (!pendingReceipt) throw new Error('receipt writer did not start');
    await expect(pendingReceipt).resolves.toMatchObject({
      taskId,
      attemptId,
      principalId: primaryAgentId,
    });
    expect(roleUpdateError).toBeDefined();
    expect(String(roleUpdateError)).toMatch(
      /lock timeout|canceling statement due to lock timeout|55P03/i,
    );
    await expect(
      prisma.taskAgent.findUnique({
        where: { taskId_agentId: { taskId, agentId: primaryAgentId } },
      }),
    ).resolves.toMatchObject({ role: 'executor' });
  });

  it('rejects malformed route identities before database access', async () => {
    await expect(
      service.commitHead('not-a-uuid', randomUUID(), primaryAgentId, proposal(1)),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.getCurrentHead(randomUUID(), 'not-a-uuid', primaryAgentId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('serializes same-prior writers so exactly one receipt wins', async () => {
    const { taskId, attemptId, taskRevision } = await runningTask();
    const writes = await Promise.allSettled([
      service.commitHead(taskId, attemptId, primaryAgentId, proposal(taskRevision)),
      service.commitHead(taskId, attemptId, primaryAgentId, proposal(taskRevision, {
        headDigestSha256: SHA_D, solutionLogDigestSha256: SHA_E,
      })),
    ]);
    expect(writes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter((item) => item.status === 'rejected')).toHaveLength(1);
    expect(await prisma.solutionLogHeadReceipt.count({ where: { taskId } })).toBe(1);
  });

  it('rejects UPDATE, DELETE, and TRUNCATE at the database', async () => {
    const { taskId, attemptId, taskRevision } = await runningTask();
    const receipt = await service.commitHead(taskId, attemptId, primaryAgentId, proposal(taskRevision));
    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE public.solution_log_head_receipts SET model_use_status = $2 WHERE receipt_id = $1',
        receipt.receiptId, 'AUTHORIZED',
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRawUnsafe(
        'DELETE FROM public.solution_log_head_receipts WHERE receipt_id = $1',
        receipt.receiptId,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRawUnsafe('TRUNCATE public.solution_log_head_receipts'),
    ).rejects.toThrow(/non-destructible/);
  });
});

async function waitUntilBlockedOnLock(client: any): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await client.$queryRawUnsafe(
      'SELECT count(*)::int AS count FROM pg_locks WHERE NOT granted',
    ) as Array<{ count: number }>;
    if (Array.isArray(rows) && Number(rows[0]?.count) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    'timed out waiting for the receipt writer to block on execution state',
  );
}
