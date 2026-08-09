import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { computeSolutionLogHeadReceiptId } from './solution-log-head.canonical';
import { validateSolutionLogHeadProposalV0 } from './solution-log-head.guards';
import type {
  SolutionLogHeadProposalV0,
  SolutionLogHeadReceiptV0,
} from './solution-log-head.types';

type Tx = Prisma.TransactionClient;

interface LockedExecutionState {
  aggregate_version: bigint;
  current_attempt_id: string | null;
}

interface LockedTaskRevision {
  revision: bigint;
  deleted: boolean;
}

@Injectable()
export class SolutionLogHeadService {
  constructor(private readonly prisma: PrismaService) {}

  async commitHead(
    taskId: string,
    attemptId: string,
    principalId: string,
    untrustedProposal: unknown,
  ): Promise<SolutionLogHeadReceiptV0> {
    assertUuid(taskId, 'taskId');
    assertUuid(attemptId, 'attemptId');
    const validated = validateSolutionLogHeadProposalV0(untrustedProposal);
    if (validated instanceof Error) {
      throw new BadRequestException(validated.message);
    }
    this.assertSeparatedDigests(validated);

    return this.prisma.$transaction(
        async (tx) => {
          const context = await this.loadAuthorityContext(
            tx,
            taskId,
            attemptId,
            principalId,
            'UPDATE',
          );
          const current = await tx.solutionLogHeadReceipt.findFirst({
            where: { taskId, attemptId },
            orderBy: { producerVersion: 'desc' },
          });
          this.assertCurrentBinding(
            validated,
            current,
            context.taskRevision,
            principalId,
          );

          const recordedAt = new Date().toISOString();
          const withoutId: Omit<SolutionLogHeadReceiptV0, 'receiptId'> = {
            schemaVersion: 'v0',
            kind: 'solution-log-head-receipt',
            taskId,
            attemptId,
            principalId,
            taskRevision: validated.taskRevision,
            projectionDigestSha256: validated.projectionDigestSha256,
            logRevision: validated.logRevision,
            previousHeadDigestSha256: validated.previousHeadDigestSha256,
            headDigestSha256: validated.headDigestSha256,
            solutionLogDigestSha256: validated.solutionLogDigestSha256,
            executionAggregateVersion: context.aggregateVersion,
            producerVersion: validated.expectedProducerVersion + 1,
            recordedAt,
            provenanceScope: 'PRODUCER_AUTHENTICATED_ONLY',
            modelUseStatus: 'NOT_AUTHORIZED',
          };
          const receipt: SolutionLogHeadReceiptV0 = {
            ...withoutId,
            receiptId: computeSolutionLogHeadReceiptId(withoutId),
          };

          await tx.solutionLogHeadReceipt.create({
            data: {
              receiptId: receipt.receiptId,
              taskId,
              attemptId,
              principalId,
              taskRevision: BigInt(receipt.taskRevision),
              projectionDigestSha256: receipt.projectionDigestSha256,
              logRevision: receipt.logRevision,
              previousHeadDigestSha256: receipt.previousHeadDigestSha256,
              headDigestSha256: receipt.headDigestSha256,
              solutionLogDigestSha256: receipt.solutionLogDigestSha256,
              executionAggregateVersion: BigInt(
                receipt.executionAggregateVersion,
              ),
              producerVersion: receipt.producerVersion,
              recordedAt: new Date(receipt.recordedAt),
              provenanceScope: receipt.provenanceScope,
              modelUseStatus: receipt.modelUseStatus,
            },
          });
          return receipt;
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: 10_000,
          timeout: 30_000,
        },
    );
  }

  async getCurrentHead(
    taskId: string,
    attemptId: string,
    principalId: string,
  ): Promise<SolutionLogHeadReceiptV0> {
    assertUuid(taskId, 'taskId');
    assertUuid(attemptId, 'attemptId');
    return this.prisma.$transaction(async (tx) => {
      await this.loadAuthorityContext(
        tx,
        taskId,
        attemptId,
        principalId,
        'SHARE',
      );
      const row = await tx.solutionLogHeadReceipt.findFirst({
        where: { taskId, attemptId },
        orderBy: { producerVersion: 'desc' },
      });
      if (!row) throw new NotFoundException('SolutionLog head not found');
      if (row.principalId !== principalId) {
        throw new ForbiddenException(
          'Current SolutionLog head belongs to a different producer',
        );
      }
      return rowToReceipt(row);
    });
  }

  private async loadAuthorityContext(
    tx: Tx,
    taskId: string,
    attemptId: string,
    principalId: string,
    lock: 'UPDATE' | 'SHARE',
  ): Promise<{ aggregateVersion: number; taskRevision: number }> {
    const task = await tx.task.findUnique({ where: { id: taskId } });
    if (!task) throw new NotFoundException('Task not found');

    const assignments = await tx.$queryRawUnsafe<Array<{ role: string }>>(
      `SELECT role FROM public.task_agents
        WHERE task_id = $1::uuid AND agent_id = $2::uuid
        FOR KEY SHARE`,
      taskId,
      principalId,
    );
    if (assignments.length !== 1 || assignments[0].role !== 'executor') {
      throw new ForbiddenException(
        'Authenticated agent is not assigned as the task executor',
      );
    }

    const revisions = await tx.$queryRawUnsafe<LockedTaskRevision[]>(
      `SELECT revision, deleted FROM public.muneral_kb_task_changes
        WHERE task_id = $1::uuid
        FOR SHARE`,
      taskId,
    );
    const revision = revisions[0];
    if (!revision || revision.deleted) {
      throw new ConflictException('Current task revision is unavailable');
    }

    const states = await tx.$queryRawUnsafe<LockedExecutionState[]>(
      `SELECT aggregate_version, current_attempt_id
         FROM public.task_execution_state
        WHERE task_id = $1::uuid
        FOR ${lock}`,
      taskId,
    );
    const state = states[0];
    if (!state) throw new ConflictException('Task has no execution state');
    if (state.current_attempt_id !== attemptId) {
      throw new ConflictException('Attempt is not the current task attempt');
    }

    const attempt = await tx.taskExecutionAttempt.findUnique({
      where: { attemptId_taskId: { attemptId, taskId } },
    });
    if (!attempt) throw new NotFoundException('Execution attempt not found');
    if (attempt.status !== 'running') {
      throw new ConflictException('Execution attempt is not running');
    }
    return {
      aggregateVersion: safeBigIntNumber(
        state.aggregate_version,
        'execution aggregate version',
      ),
      taskRevision: safeBigIntNumber(revision.revision, 'task revision'),
    };
  }

  private assertCurrentBinding(
    proposal: SolutionLogHeadProposalV0,
    current: {
      principalId: string;
      taskRevision: bigint;
      projectionDigestSha256: string;
      logRevision: number;
      headDigestSha256: string;
      producerVersion: number;
    } | null,
    currentTaskRevision: number,
    principalId: string,
  ): void {
    if (proposal.taskRevision !== currentTaskRevision) {
      throw new ConflictException('Proposal taskRevision is stale');
    }
    const expectedProducerVersion = current?.producerVersion ?? 0;
    if (proposal.expectedProducerVersion !== expectedProducerVersion) {
      throw new ConflictException('Proposal producer version is stale');
    }
    const expectedPreviousHead = current?.headDigestSha256 ?? null;
    if (proposal.previousHeadDigestSha256 !== expectedPreviousHead) {
      throw new ConflictException('Proposal previous head is stale');
    }
    const expectedLogRevision = (current?.logRevision ?? 0) + 1;
    if (proposal.logRevision !== expectedLogRevision) {
      throw new ConflictException('Proposal logRevision is not the next revision');
    }
    if (current) {
      if (current.principalId !== principalId) {
        throw new ForbiddenException(
          'SolutionLog chain belongs to a different producer',
        );
      }
      if (proposal.taskRevision !== Number(current.taskRevision)) {
        throw new ConflictException('SolutionLog chain taskRevision changed');
      }
      if (proposal.projectionDigestSha256 !== current.projectionDigestSha256) {
        throw new ConflictException('SolutionLog chain projection changed');
      }
    }
  }

  private assertSeparatedDigests(proposal: SolutionLogHeadProposalV0): void {
    const values = new Set([
      proposal.projectionDigestSha256,
      proposal.headDigestSha256,
      proposal.solutionLogDigestSha256,
    ]);
    if (values.size !== 3) {
      throw new BadRequestException(
        'Projection, head, and SolutionLog digests must be domain-separated',
      );
    }
  }
}

function safeBigIntNumber(value: bigint, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new ConflictException(`${field} is outside the protocol integer range`);
  }
  return number;
}

function assertUuid(value: string, field: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
}

function rowToReceipt(row: {
  receiptId: string;
  taskId: string;
  attemptId: string;
  principalId: string;
  taskRevision: bigint;
  projectionDigestSha256: string;
  logRevision: number;
  previousHeadDigestSha256: string | null;
  headDigestSha256: string;
  solutionLogDigestSha256: string;
  executionAggregateVersion: bigint;
  producerVersion: number;
  recordedAt: Date;
  provenanceScope: string;
  modelUseStatus: string;
}): SolutionLogHeadReceiptV0 {
  return {
    schemaVersion: 'v0',
    kind: 'solution-log-head-receipt',
    receiptId: row.receiptId,
    taskId: row.taskId,
    attemptId: row.attemptId,
    principalId: row.principalId,
    taskRevision: safeBigIntNumber(row.taskRevision, 'task revision'),
    projectionDigestSha256: row.projectionDigestSha256,
    logRevision: row.logRevision,
    previousHeadDigestSha256: row.previousHeadDigestSha256,
    headDigestSha256: row.headDigestSha256,
    solutionLogDigestSha256: row.solutionLogDigestSha256,
    executionAggregateVersion: safeBigIntNumber(
      row.executionAggregateVersion,
      'execution aggregate version',
    ),
    producerVersion: row.producerVersion,
    recordedAt: row.recordedAt.toISOString(),
    provenanceScope: 'PRODUCER_AUTHENTICATED_ONLY',
    modelUseStatus: 'NOT_AUTHORIZED',
  };
}
