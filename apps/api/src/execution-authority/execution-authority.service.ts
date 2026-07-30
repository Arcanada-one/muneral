// MUN-0020: Transactional execution-authority service.
// Public entry point owns the transaction boundary with explicit timeout,
// maxWait, and isolation. Pre-mutation validations that return typed errors
// are safe (no writes yet). Post-mutation database exceptions throw to roll
// back the transaction; the public method catches them, re-reads task-scoped
// idempotency, and returns a typed conflict.
// Unexpected infrastructure errors (connection drops, P2034 serialization
// failures after retries) propagate to the caller as thrown Errors.

import { commandDigest } from './canonical-json';
import { reduce } from './execution-authority.reducer';
import { replayJournal } from './execution-authority.replay';
import {
  IdempotencyCollisionError,
  InvalidTransitionError,
  RetryBackoffError,
  RetryBudgetExhaustedError,
  StaleVersionError,
  UnissuedAttemptError,
} from './execution-authority.errors';
import type { ExecutionAuthorityError } from './execution-authority.errors';
import { validateEvidenceRefs } from './evidence-ref.validator';
import { EvidenceRefValidationError } from './evidence-ref.validator';
import type {
  Clock,
  ExecutionAuthorityCommand,
  IdSource,
  IssueRetryAttemptCommand,
  TaskExecutionAttempt,
  TaskExecutionState,
  TaskExecutionTransition,
  TransitionAttemptCommand,
} from './execution-authority.types';
import { EVENT_TO_ATTEMPT_STATUS } from './execution-authority.types';
import { deriveOutboxEventType } from '../outbox/outbox.types';
import type { OutboxEvent } from '../outbox/outbox.types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExecutionResult {
  committedResult: Record<string, unknown>;
  transition: TaskExecutionTransition;
  state: TaskExecutionState;
  /** Populated when the transition produced a terminal outcome (succeeded,
   *  failed, or cancelled) and an outbox event was atomically committed. */
  outboxEvent?: OutboxEvent;
}

/**
 * Every typed outcome the public method can return.
 * Unexpected infrastructure failures (DB connection loss, serialization
 * conflicts after retry exhaustion) throw to the caller.
 */
export type ExecutionOutcome =
  | ExecutionResult
  | ExecutionAuthorityError
  | EvidenceRefValidationError;

const TX_OPTS = {
  maxWait: 10_000,
  timeout: 30_000,
  isolationLevel: 'ReadCommitted' as const,
};

export interface TransactionalClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction<T>(
    fn: (tx: any) => Promise<T>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: Record<string, any>,
  ): Promise<T>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrismaTx = any;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ExecutionAuthorityService {
  constructor(
    private readonly clock: Clock,
    private readonly idSource: IdSource,
  ) {}

  // -- public entry point (owns the transaction) ----------------------------

  /**
   * Execute a command inside a bounded PostgreSQL transaction.
   *
   * Pre-mutation validations return typed errors safely (no writes yet).
   * Post-mutation DB exceptions (P2002, serialization failures) throw,
   * rolling back the transaction. This method catches those, reconciles
   * idempotency, and returns the appropriate typed error.
   */
  async executeCommand(
    prisma: TransactionalClient,
    command: ExecutionAuthorityCommand,
  ): Promise<ExecutionOutcome> {
    try {
      return await prisma.$transaction(
        (tx) => this.executeInTransaction(tx, command),
        TX_OPTS,
      );
    } catch (err) {
      // Post-mutation exception: transaction was rolled back.
      // Reconcile: StaleVersionError (thrown explicitly on zero-row update),
      // P2002 (unique constraint race), P2034 (serialization conflict).
      if (
        err instanceof StaleVersionError ||
        isPrismaUniqueViolation(err) ||
        isPrismaSerializationConflict(err)
      ) {
        return this.reconcileAfterRollback(prisma, command);
      }
      throw err;
    }
  }

  /**
   * After a rolled-back transaction caused by a unique-constraint violation,
   * re-read task-scoped idempotency in a fresh transaction to determine the
   * correct typed response.
   */
  private async reconcileAfterRollback(
    prisma: TransactionalClient,
    command: ExecutionAuthorityCommand,
  ): Promise<ExecutionOutcome> {
    const digest = commandDigest(command);

    return prisma.$transaction(async (tx) => {
      const existing = await tx.taskExecutionTransition.findFirst({
        where: {
          taskId: command.taskId,
          idempotencyKey: command.idempotencyKey,
        },
        orderBy: { aggregateVersion: 'asc' },
      });

      if (existing !== null) {
        // Read from both camelCase (Prisma) and snake_case (raw queries)
        const storedDigest: string =
          (existing as Record<string, unknown>).commandDigest as string ??
          (existing as Record<string, unknown>).command_digest as string ??
          '';
        const storedResult: Record<string, unknown> =
          ((existing as Record<string, unknown>).committedResult as Record<string, unknown>) ??
          ((existing as Record<string, unknown>).committed_result as Record<string, unknown>) ??
          {};
        if (storedDigest === digest) {
          return this.reconstructHistoricalResult(
            tx,
            command.taskId,
            Number((existing as Record<string, unknown>).aggregateVersion ?? (existing as Record<string, unknown>).aggregate_version),
            storedResult,
            existing,
          );
        }
        return new IdempotencyCollisionError(
          command.taskId,
          command.idempotencyKey,
          storedDigest,
          digest,
        );
      }

      // Not an idempotency race — must be a version race
      const freshState = await this.readState(tx, command.taskId);
      return new StaleVersionError(
        command.taskId,
        command.expectedVersion,
        freshState?.aggregateVersion ?? 0,
      );
    }, TX_OPTS);
  }

  /**
   * Reconstruct the ExecutionResult exactly as originally returned, using
   * journal facts up to the stored aggregateVersion. The caller must pass the
   * stored committed result and the raw transition row from the DB.
   */
  private async reconstructHistoricalResult(
    tx: PrismaTx,
    taskId: string,
    storedVersion: number,
    storedResult: Record<string, unknown>,
    transitionRow: unknown,
  ): Promise<ExecutionResult> {
    const transitions = await tx.taskExecutionTransition.findMany({
      where: { taskId },
      orderBy: { aggregateVersion: 'asc' },
    });

    const typed = (transitions as any[]).map((t: any) => ({
      id: t.id, taskId: t.taskId, attemptId: t.attemptId,
      aggregateVersion: Number(t.aggregateVersion), eventType: t.eventType,
      idempotencyKey: t.idempotencyKey, commandDigest: t.commandDigest ?? t.command_digest,
      transitionPayload: t.transitionPayload ?? t.transition_payload ?? {},
      committedResult: t.committedResult ?? t.committed_result ?? {},
      evidenceRefs: t.evidenceRefs ?? t.evidence_refs ?? [],
      causationId: t.causationId ?? t.causation_id,
      correlationId: t.correlationId ?? t.correlation_id,
      recordedAt: new Date(t.recordedAt ?? t.recorded_at),
    }));

    // Replay up to (and including) the stored version
    const upToVersion = typed.filter(
      (t) => t.aggregateVersion <= storedVersion,
    );

    const { state } = replayJournal(upToVersion);

    if (state === null) {
      throw new Error(
        `Journal invariant violation: cannot reconstruct state at version ${storedVersion} for task ${taskId}`,
      );
    }

    return {
      committedResult: storedResult,
      transition: this.unmarshalTransition(transitionRow),
      state,
    };
  }

  // -- private in-transaction logic -----------------------------------------

  /**
   * Runs inside an already-open transaction. Pre-mutation errors are returned
   * safely (no writes occurred). Post-mutation errors MUST throw so the
   * transaction rolls back.
   */
  private async executeInTransaction(
    tx: PrismaTx,
    command: ExecutionAuthorityCommand,
  ): Promise<ExecutionOutcome> {
    // ---- 0. Validate evidence references (pre-mutation, safe) ----
    const evidenceErr = validateEvidenceRefs(command.evidenceRefs ?? []);
    if (evidenceErr) return evidenceErr;

    const now = this.clock.now();
    const digest = commandDigest(command);

    // ---- 1. Idempotency check (pre-mutation, safe) ----
    const existingTransition =
      await tx.taskExecutionTransition.findFirst({
        where: {
          taskId: command.taskId,
          idempotencyKey: command.idempotencyKey,
        },
        orderBy: { aggregateVersion: 'asc' },
      });

    if (existingTransition !== null) {
      const storedDigest2: string =
        (existingTransition as Record<string, unknown>).commandDigest as string ??
        (existingTransition as Record<string, unknown>).command_digest as string ??
        '';
      const storedResult: Record<string, unknown> =
        ((existingTransition as Record<string, unknown>).committedResult as Record<string, unknown>) ??
        ((existingTransition as Record<string, unknown>).committed_result as Record<string, unknown>) ??
        {};
      if (storedDigest2 === digest) {
        return this.reconstructHistoricalResult(
          tx,
          command.taskId,
          Number((existingTransition as Record<string, unknown>).aggregateVersion ?? (existingTransition as Record<string, unknown>).aggregate_version),
          storedResult,
          existingTransition,
        );
      }
      return new IdempotencyCollisionError(
        command.taskId,
        command.idempotencyKey,
        storedDigest2,
        digest,
      );
    }

    // ---- 2. Read current aggregate and attempt (pre-mutation, safe) ----
    const currentState = await this.readState(tx, command.taskId);

    // ---- 3. Fetch current attempt snapshot for reducer ----
    let currentAttempt: TaskExecutionAttempt | null = null;
    if (
      command.kind === 'transition_attempt' ||
      command.kind === 'issue_retry_attempt'
    ) {
      if (currentState?.currentAttemptId) {
        const row = await tx.taskExecutionAttempt.findUnique({
          where: { attemptId: currentState.currentAttemptId },
        });
        if (row) {
          currentAttempt = this.unmarshalAttempt(row);
        }
      }
    }

    // ---- 4. Pure reducer (pre-mutation, safe — validates all invariants) ----
    const attemptId =
      command.kind === 'issue_initial_attempt' ||
      command.kind === 'issue_retry_attempt'
        ? this.idSource.generate()
        : command.attemptId;

    const transitionId = this.idSource.generate();

    const result = reduce(currentState, currentAttempt, command, {
      attemptId,
      transitionId,
      now,
    });

    if (result instanceof Error) return result;

    result.transition.commandDigest = digest;

    // ---- 5. Atomic writes (POST-MUTATION: throw on error) ----
    if (currentState === null) {
      if (command.kind === 'issue_initial_attempt') {
        await tx.taskExecutionState.create({
          data: this.marshalState(result.nextState),
        });
      }
    } else {
      const updateResult = await tx.taskExecutionState.updateMany({
        where: {
          taskId: command.taskId,
          aggregateVersion: command.expectedVersion,
        },
        data: this.marshalState(result.nextState),
      });

      if (updateResult.count === 0) {
        // Version race — throw so transaction rolls back
        throw new StaleVersionError(
          command.taskId,
          command.expectedVersion,
          currentState.aggregateVersion,
        );
      }
    }

    if (result.attempt) {
      await tx.taskExecutionAttempt.create({
        data: this.marshalAttempt(result.attempt),
      });
    }

    if (command.kind === 'transition_attempt') {
      await this.updateAttemptOnTransition(tx, command, now);
    }

    const createdTransition =
      await tx.taskExecutionTransition.create({
        data: this.marshalTransition(
          transitionId,
          result.transition,
          now,
        ),
      });

    // ---- MUN-0021: Derive and atomically insert outbox event ----
    let outboxEvent: OutboxEvent | undefined;

    if (command.kind === 'transition_attempt') {
      const derivedType = deriveOutboxEventType(
        command.eventType,
        result.nextState.retryCount,
        result.nextState.retryBudget,
      );

      if (derivedType !== null) {
        const outboxId = this.idSource.generate();
        const outboxPayload = {
          schema: 'muneral-outbox-v1' as const,
          transitionEventType: command.eventType,
          committedResult: result.transition.committedResult,
          idempotencyKey: command.idempotencyKey,
          aggregateVersion: result.nextState.aggregateVersion,
          attemptId: command.attemptId,
          attemptOrdinal: (
            currentAttempt?.ordinal ??
            (result.attempt?.ordinal ?? 1)
          ),
          retryCount: result.nextState.retryCount,
          retryBudget: result.nextState.retryBudget,
        };

        await tx.taskOutboxEvent.create({
          data: {
            id: outboxId,
            taskId: command.taskId,
            aggregateVersion: BigInt(result.nextState.aggregateVersion),
            attemptId: command.attemptId,
            transitionId,
            eventType: derivedType,
            eventPayload: outboxPayload,
            recordedAt: now,
          },
        });

        await tx.outboxLease.create({
          data: {
            outboxEventId: outboxId,
            leaseHolder: null,
            leaseAcquiredAt: null,
            leaseExpiresAt: null,
            deliveryStatus: 'pending',
            deliveryOrdinal: 0,
            failureCount: 0,
            lastErrorCode: null,
          },
        });

        outboxEvent = {
          id: outboxId,
          taskId: command.taskId,
          aggregateVersion: result.nextState.aggregateVersion,
          attemptId: command.attemptId,
          transitionId,
          eventType: derivedType,
          eventPayload: outboxPayload,
          recordedAt: now,
        };
      }
    }

    return {
      committedResult: result.transition.committedResult,
      transition: this.unmarshalTransition(createdTransition),
      state: result.nextState,
      outboxEvent,
    };
  }

  // -----------------------------------------------------------------------
  // Pre-validation helpers
  // -----------------------------------------------------------------------

  private async readState(
    tx: PrismaTx,
    taskId: string,
  ): Promise<TaskExecutionState | null> {
    const row = await tx.taskExecutionState.findUnique({
      where: { taskId },
    });
    if (!row) return null;
    return this.unmarshalState(row);
  }

  // -----------------------------------------------------------------------
  // Attempt lifecycle mutation on transition (POST-MUTATION: throw on error)
  // -----------------------------------------------------------------------

  private async updateAttemptOnTransition(
    tx: PrismaTx,
    command: TransitionAttemptCommand,
    now: Date,
  ): Promise<void> {
    const targetStatus = EVENT_TO_ATTEMPT_STATUS[command.eventType];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: Record<string, any> = { status: targetStatus };

    if (targetStatus === 'running') {
      data.startedAt = now;
    }

    if (
      targetStatus === 'succeeded' ||
      targetStatus === 'failed' ||
      targetStatus === 'cancelled'
    ) {
      data.completedAt = now;
    }

    await tx.taskExecutionAttempt.update({
      where: { attemptId: command.attemptId },
      data,
    });
  }

  // -----------------------------------------------------------------------
  // Marshalling
  // -----------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private marshalState(state: TaskExecutionState): Record<string, any> {
    return {
      taskId: state.taskId,
      aggregateVersion: BigInt(state.aggregateVersion),
      currentAttemptId: state.currentAttemptId,
      retryBudget: state.retryBudget,
      retryCount: state.retryCount,
      retryBackoffMs: BigInt(state.retryBackoffMs),
      retryEligibleAt: state.retryEligibleAt,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private unmarshalState(row: any): TaskExecutionState {
    return {
      taskId: row.taskId ?? row.task_id,
      aggregateVersion: Number(row.aggregateVersion ?? row.aggregate_version),
      currentAttemptId: row.currentAttemptId ?? row.current_attempt_id ?? null,
      retryBudget: Number(row.retryBudget ?? row.retry_budget),
      retryCount: Number(row.retryCount ?? row.retry_count),
      retryBackoffMs: Number(row.retryBackoffMs ?? row.retry_backoff_ms),
      retryEligibleAt: row.retryEligibleAt ?? row.retry_eligible_at ?? null,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private marshalAttempt(attempt: TaskExecutionAttempt): Record<string, any> {
    return {
      attemptId: attempt.attemptId,
      taskId: attempt.taskId,
      ordinal: attempt.ordinal,
      status: attempt.status,
      issuedAt: attempt.issuedAt,
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private unmarshalAttempt(row: any): TaskExecutionAttempt {
    return {
      attemptId: row.attemptId ?? row.attempt_id,
      taskId: row.taskId ?? row.task_id,
      ordinal: Number(row.ordinal),
      status: row.status,
      issuedAt: new Date(row.issuedAt ?? row.issued_at),
      startedAt:
        row.startedAt ?? row.started_at
          ? new Date(row.startedAt ?? row.started_at)
          : null,
      completedAt:
        row.completedAt ?? row.completed_at
          ? new Date(row.completedAt ?? row.completed_at)
          : null,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private marshalTransition(
    id: string,
    t: Omit<TaskExecutionTransition, 'id' | 'recordedAt'> & {
      commandDigest: string;
    },
    now: Date,
  ): Record<string, any> {
    return {
      id,
      taskId: t.taskId,
      attemptId: t.attemptId,
      aggregateVersion: BigInt(t.aggregateVersion),
      eventType: t.eventType,
      idempotencyKey: t.idempotencyKey,
      commandDigest: t.commandDigest,
      transitionPayload: t.transitionPayload ?? {},
      committedResult: t.committedResult ?? {},
      evidenceRefs: t.evidenceRefs ?? [],
      causationId: t.causationId,
      correlationId: t.correlationId,
      recordedAt: now,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private unmarshalTransition(row: any): TaskExecutionTransition {
    return {
      id: row.id,
      taskId: row.taskId ?? row.task_id,
      attemptId: row.attemptId ?? row.attempt_id,
      aggregateVersion: Number(row.aggregateVersion ?? row.aggregate_version),
      eventType: row.eventType ?? row.event_type,
      idempotencyKey: row.idempotencyKey ?? row.idempotency_key,
      commandDigest: row.commandDigest ?? row.command_digest,
      transitionPayload: row.transitionPayload ?? row.transition_payload ?? {},
      committedResult: row.committedResult ?? row.committed_result ?? {},
      evidenceRefs: row.evidenceRefs ?? row.evidence_refs ?? [],
      causationId: row.causationId ?? row.causation_id,
      correlationId: row.correlationId ?? row.correlation_id,
      recordedAt: new Date(row.recordedAt ?? row.recorded_at),
    };
  }
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

function isPrismaUniqueViolation(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  if (typeof err !== 'object') return false;
  const e = err as { code?: string };
  return e.code === 'P2002';
}

function isPrismaSerializationConflict(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  if (typeof err !== 'object') return false;
  const e = err as { code?: string };
  return e.code === 'P2034';
}
