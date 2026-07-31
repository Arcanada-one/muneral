// MUN-0020: Transactional execution-authority service.
// Public entry point owns the transaction boundary with explicit timeout,
// maxWait, and isolation. Pre-mutation validations that return typed errors
// are safe (no writes yet). Post-mutation database exceptions throw to roll
// back the transaction; the public method catches them, re-reads task-scoped
// idempotency, and returns a typed conflict.
// Unexpected infrastructure errors propagate to the caller as thrown Errors.
// This module performs NO retry of its own: a P2034 serialization failure is
// reconciled once against task-scoped idempotency and then reported, and a
// P2002 on a constraint that cannot express a version race is rethrown as
// UnexpectedUniqueViolationError. Any retry policy belongs to the caller.

import { commandDigest, CanonicalJsonError } from './canonical-json';
import { reduce } from './execution-authority.reducer';
import { replayJournal } from './execution-authority.replay';
// InvalidTransitionError, UnissuedAttemptError, RetryBackoffError and
// RetryBudgetExhaustedError are intentionally NOT imported here: the pure
// reducer is the single source of truth for those validations and the service
// returns its typed error unchanged (see `if (result instanceof Error) return
// result;`). They were previously imported but never referenced.
import {
  IdempotencyCollisionError,
  StaleVersionError,
  UnexpectedUniqueViolationError,
} from './execution-authority.errors';
import type { ExecutionAuthorityError } from './execution-authority.errors';
import { validateEvidenceRefs } from './evidence-ref.validator';
import { EvidenceRefValidationError } from './evidence-ref.validator';
import type {
  Clock,
  ExecutionAuthorityCommand,
  IdSource,
  TaskExecutionAttempt,
  TaskExecutionState,
  TaskExecutionTransition,
  TransitionAttemptCommand,
} from './execution-authority.types';
import { EVENT_TO_ATTEMPT_STATUS } from './execution-authority.types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExecutionResult {
  committedResult: Record<string, unknown>;
  transition: TaskExecutionTransition;
  state: TaskExecutionState;
}

/**
 * Every typed outcome the public method can return.
 * Unexpected infrastructure failures (DB connection loss, an unresolvable
 * serialization conflict, a unique violation on a constraint that cannot
 * express a version race) throw to the caller.
 */
export type ExecutionOutcome =
  | ExecutionResult
  | ExecutionAuthorityError
  | EvidenceRefValidationError
  | CanonicalJsonError;

const TX_OPTS = {
  maxWait: 10_000,
  timeout: 30_000,
  isolationLevel: 'ReadCommitted' as const,
};

export interface TransactionalClient {
  $transaction<T>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      // P2034 (serialization conflict), and P2002 only on the constraints that
      // can actually express a lost version race.
      if (
        err instanceof StaleVersionError ||
        isPrismaSerializationConflict(err)
      ) {
        return this.reconcileAfterRollback(prisma, command);
      }
      if (isPrismaUniqueViolation(err)) {
        if (isVersionRaceUniqueViolation(err)) {
          return this.reconcileAfterRollback(prisma, command);
        }
        // Any other unique violation (e.g. a duplicate attempt or transition
        // UUID from a faulty IdSource) is not a concurrency conflict. Reporting
        // it as StaleVersionError told the caller to re-read and re-issue, which
        // would collide identically forever (QA finding F4).
        throw new UnexpectedUniqueViolationError(
          command.taskId,
          describeUniqueViolation(err),
          err,
        );
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

      // No transition recorded under this key, so this is not an idempotency
      // race. The caller has already established that the rollback cause was a
      // version-race-capable constraint (or an explicit StaleVersionError, or a
      // serialization conflict), so a version race is the only remaining
      // explanation and re-reading gives the caller the version to retry from.
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

    // Raw driver rows: camelCase from Prisma, snake_case from raw queries.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

    // Canonicalization is a pre-mutation validation like every other one here,
    // so a malformed command returns its typed error instead of escaping as an
    // untyped throw. Fail-closed behaviour is unchanged: no write has happened.
    let digest: string;
    try {
      digest = commandDigest(command);
    } catch (err) {
      if (err instanceof CanonicalJsonError) return err;
      throw err;
    }

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

    return {
      committedResult: result.transition.committedResult,
      transition: this.unmarshalTransition(createdTransition),
      state: result.nextState,
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

  private marshalTransition(
    id: string,
    t: Omit<TaskExecutionTransition, 'id' | 'recordedAt'> & {
      commandDigest: string;
    },
    now: Date,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// ---------------------------------------------------------------------------
// Unique-violation classification (QA finding F4)
// ---------------------------------------------------------------------------
//
// Not every P2002 means "another writer advanced this aggregate". Treating them
// all as a version race made a duplicate attempt UUID surface as
// `StaleVersionError: ... expected 0, got 0` — self-contradictory, and a caller
// following the documented "re-read and re-issue" contract retries forever.
//
// Constraint                                        | lost version race? | why
// --------------------------------------------------+--------------------+-----
// task_execution_state_pkey (task_id)                | YES  | concurrent initial issuance: the aggregate appeared between our read and our create
// task_execution_attempts_task_ordinal_unique        | YES  | ordinal is derived from the state we read, so a collision means the state moved
// task_execution_transitions_task_version_unique     | YES  | the canonical lost-update signal
// task_execution_transitions_task_idempotency_unique | YES  | concurrent same-key command; reconciliation returns the recorded result
// task_execution_attempts_pkey (attempt_id)          | NO   | duplicate UUID from IdSource
// task_execution_attempts_attempt_task_unique        | NO   | duplicate UUID from IdSource
// task_execution_transitions_pkey (id)               | NO   | duplicate UUID from IdSource
// anything else / unidentifiable                     | NO   | fail closed rather than invent a version race

const VERSION_RACE_CONSTRAINTS: ReadonlySet<string> = new Set([
  'task_execution_state_pkey',
  'task_execution_attempts_task_ordinal_unique',
  'task_execution_transitions_task_version_unique',
  'task_execution_transitions_task_idempotency_unique',
]);

/** Same set keyed by violated columns, sorted and comma-joined. */
const VERSION_RACE_COLUMN_SETS: ReadonlySet<string> = new Set([
  'task_id', // task_execution_state_pkey
  'ordinal,task_id', // task_execution_attempts_task_ordinal_unique
  'aggregate_version,task_id', // task_execution_transitions_task_version_unique
  'idempotency_key,task_id', // task_execution_transitions_task_idempotency_unique
]);

function toSnakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function normalizeColumns(columns: readonly string[]): string {
  return columns.map(toSnakeCase).sort().join(',');
}

/**
 * Extract what a P2002 actually violated.
 *
 * Prisma's documented `err.meta.target` is NOT populated by this project's
 * driver-adapter configuration (`@prisma/adapter-pg`) — it is always undefined
 * there, and the detail lives under `meta.driverAdapterError.cause` instead.
 * Both shapes are read, plus the raw PostgreSQL message as a last resort, and
 * an unidentifiable violation is reported as such rather than guessed.
 */
function uniqueViolationSignature(err: unknown): {
  constraint: string | null;
  columns: string | null;
} {
  const empty = { constraint: null, columns: null };
  if (err === null || typeof err !== 'object') return empty;

  const meta = (err as { meta?: Record<string, unknown> }).meta;
  if (meta === null || typeof meta !== 'object') return empty;

  let constraint: string | null = null;
  let columns: string | null = null;

  // Shape 1: classic Prisma `meta.target`.
  const target = (meta as { target?: unknown }).target;
  if (typeof target === 'string') {
    constraint = target;
  } else if (Array.isArray(target) && target.every((t) => typeof t === 'string')) {
    columns = normalizeColumns(target as string[]);
  }

  // Shape 2: driver-adapter error detail.
  const cause = (
    meta as { driverAdapterError?: { cause?: Record<string, unknown> } }
  ).driverAdapterError?.cause;
  if (cause !== null && typeof cause === 'object') {
    const c = (cause as { constraint?: unknown }).constraint;
    if (c !== null && typeof c === 'object') {
      const fields = (c as { fields?: unknown }).fields;
      if (
        columns === null &&
        Array.isArray(fields) &&
        fields.every((f) => typeof f === 'string')
      ) {
        columns = normalizeColumns(fields as string[]);
      }
      const index = (c as { index?: unknown }).index;
      if (constraint === null && typeof index === 'string') {
        constraint = index;
      }
    }

    // Shape 3: parse the constraint name out of the raw PostgreSQL message.
    const original = (cause as { originalMessage?: unknown }).originalMessage;
    if (constraint === null && typeof original === 'string') {
      const match = /unique constraint "([^"]+)"/.exec(original);
      if (match) constraint = match[1];
    }
  }

  return { constraint, columns };
}

/**
 * True only when the violated constraint can express a lost version race.
 * Fails closed: an absent or unrecognized signature returns false.
 */
function isVersionRaceUniqueViolation(err: unknown): boolean {
  const { constraint, columns } = uniqueViolationSignature(err);
  if (constraint !== null && VERSION_RACE_CONSTRAINTS.has(constraint)) {
    return true;
  }
  if (constraint !== null) {
    // The constraint was identified and is not in the allow-list. Trust that
    // over the column set, which is ambiguous across tables.
    return false;
  }
  return columns !== null && VERSION_RACE_COLUMN_SETS.has(columns);
}

/** Human-readable identification of the violated constraint for diagnostics. */
function describeUniqueViolation(err: unknown): string {
  const { constraint, columns } = uniqueViolationSignature(err);
  if (constraint !== null) return constraint;
  if (columns !== null) return `(${columns})`;
  return 'unknown';
}

function isPrismaSerializationConflict(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  if (typeof err !== 'object') return false;
  const e = err as { code?: string };
  return e.code === 'P2034';
}
