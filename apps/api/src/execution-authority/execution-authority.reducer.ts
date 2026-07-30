// MUN-0020: Pure reducer — validates commands against current aggregate state
// and produces the next state plus exactly one transition fact. The reducer
// does NOT generate IDs or read wall-clock time; those values are injected
// by the service layer and arrive pre-validated.
//
// The reducer is the single source of truth for every allowed state change.
// It never throws — invalid transitions return a typed error object so the
// caller can distinguish validation failures from infrastructure failures.

import {
  clearsCurrentAttempt,
  EVENT_TO_ATTEMPT_STATUS,
  isValidAttemptTransition,
} from './execution-authority.types';
import type {
  AttemptStatus,
  ExecutionAuthorityCommand,
  IssueInitialAttemptCommand,
  IssueRetryAttemptCommand,
  ReducerResult,
  TaskExecutionAttempt,
  TaskExecutionState,
  TransitionAttemptCommand,
} from './execution-authority.types';
import {
  ExecutionStateAlreadyExistsError,
  InvalidRetryConfigError,
  InvalidTransitionError,
  RetryBackoffError,
  RetryBudgetExhaustedError,
  StaleVersionError,
  UnissuedAttemptError,
} from './execution-authority.errors';
import { MAX_RETRY_BACKOFF_MS, MAX_RETRY_BUDGET } from './execution-authority.types';
import type { ExecutionAuthorityError } from './execution-authority.errors';

// ---------------------------------------------------------------------------
// Reducer entry point
// ---------------------------------------------------------------------------

/**
 * Validate `command` against `currentState` (or null if no aggregate exists)
 * and return the next aggregate state, an optional new attempt, and the
 * transition fact.
 *
 * The caller provides `attemptId`, `transitionId`, and `now` because the
 * reducer is pure and does not perform side-effects or generate identifiers.
 *
 * Returns either a valid ReducerResult or an ExecutionAuthorityError.
 * The caller MUST check `result instanceof Error` before using the result.
 */
export function reduce(
  currentState: TaskExecutionState | null,
  currentAttempt: TaskExecutionAttempt | null,
  command: ExecutionAuthorityCommand,
  deps: {
    attemptId: string;
    transitionId: string;
    now: Date;
  },
): ReducerResult | ExecutionAuthorityError {
  switch (command.kind) {
    case 'issue_initial_attempt':
      return reduceInitialAttempt(currentState, command, deps);
    case 'transition_attempt':
      return reduceTransitionAttempt(
        currentState,
        currentAttempt,
        command,
        deps,
      );
    case 'issue_retry_attempt':
      return reduceRetryAttempt(
        currentState,
        currentAttempt,
        command,
        deps,
      );
  }
}

// ---------------------------------------------------------------------------
// issue_initial_attempt
// ---------------------------------------------------------------------------

function reduceInitialAttempt(
  currentState: TaskExecutionState | null,
  command: IssueInitialAttemptCommand,
  deps: { attemptId: string; transitionId: string; now: Date },
): ReducerResult | ExecutionAuthorityError {
  // Guard: expectedVersion must be 0 (no aggregate exists yet)
  if (command.expectedVersion !== 0) {
    return new StaleVersionError(
      command.taskId,
      command.expectedVersion,
      currentState?.aggregateVersion ?? 0,
    );
  }

  // Guard: no existing aggregate
  if (currentState !== null) {
    return new ExecutionStateAlreadyExistsError(
      command.taskId,
      currentState.aggregateVersion,
    );
  }

  // Guard: retry config must be safe integers within bounds
  const configErr = validateRetryConfig(
    command.retryBudget,
    command.retryBackoffMs,
  );
  if (configErr) return configErr;

  const nextState: TaskExecutionState = {
    taskId: command.taskId,
    aggregateVersion: 1,
    currentAttemptId: deps.attemptId,
    retryBudget: command.retryBudget,
    retryCount: 0,
    retryBackoffMs: command.retryBackoffMs,
    retryEligibleAt: null,
  };

  const attempt: TaskExecutionAttempt = {
    attemptId: deps.attemptId,
    taskId: command.taskId,
    ordinal: 1,
    status: 'issued',
    issuedAt: deps.now,
    startedAt: null,
    completedAt: null,
  };

  const transition = {
    taskId: command.taskId,
    attemptId: deps.attemptId,
    aggregateVersion: 1,
    eventType: 'attempt:issued' as const,
    idempotencyKey: command.idempotencyKey,
    commandDigest: '', // filled by service after canonical JSON
    transitionPayload: {
      retryBudget: command.retryBudget,
      retryBackoffMs: command.retryBackoffMs,
    } as Record<string, unknown>,
    committedResult: {} as Record<string, unknown>,
    evidenceRefs: command.evidenceRefs,
    causationId: command.causationId,
    correlationId: command.correlationId,
  };

  return { nextState, attempt, transition };
}

// ---------------------------------------------------------------------------
// transition_attempt
// ---------------------------------------------------------------------------

function reduceTransitionAttempt(
  currentState: TaskExecutionState | null,
  currentAttempt: TaskExecutionAttempt | null,
  command: TransitionAttemptCommand,
  deps: { attemptId: string; transitionId: string; now: Date },
): ReducerResult | ExecutionAuthorityError {
  // Guard: there must be an existing aggregate
  if (currentState === null) {
    return new StaleVersionError(command.taskId, command.expectedVersion, 0);
  }

  // Guard: version must match
  if (command.expectedVersion !== currentState.aggregateVersion) {
    return new StaleVersionError(
      command.taskId,
      command.expectedVersion,
      currentState.aggregateVersion,
    );
  }

  // Guard: must have a current attempt to transition
  if (currentAttempt === null) {
    return new UnissuedAttemptError(
      command.taskId,
      command.attemptId,
      'not_found',
    );
  }

  // Guard: the attempt must belong to this task
  if (currentAttempt.taskId !== command.taskId) {
    return new UnissuedAttemptError(
      command.taskId,
      command.attemptId,
      'not_found',
    );
  }

  // Guard: the attempt must be the current one
  if (currentAttempt.attemptId !== currentState.currentAttemptId) {
    return new UnissuedAttemptError(
      command.taskId,
      command.attemptId,
      'not_current',
    );
  }

  // Guard: command attempts to reference correct attempt
  if (command.attemptId !== currentAttempt.attemptId) {
    return new UnissuedAttemptError(
      command.taskId,
      command.attemptId,
      'not_current',
    );
  }

  // Guard: validate the lifecycle edge
  const targetStatus = EVENT_TO_ATTEMPT_STATUS[command.eventType];
  if (
    !targetStatus ||
    !isValidAttemptTransition(currentAttempt.status, targetStatus)
  ) {
    return new InvalidTransitionError(
      command.taskId,
      command.attemptId,
      currentAttempt.status,
      targetStatus ?? command.eventType,
    );
  }

  const newVersion = currentState.aggregateVersion + 1;
  const shouldClear = clearsCurrentAttempt(targetStatus);

  const nextState: TaskExecutionState = {
    ...currentState,
    aggregateVersion: newVersion,
    // Clear current attempt only for succeeded/cancelled — failed stays current
    currentAttemptId: shouldClear ? null : currentState.currentAttemptId,
    // Only update backoff on failure
    retryEligibleAt:
      targetStatus === 'failed'
        ? computeRetryEligibleAt(deps.now, currentState)
        : currentState.retryEligibleAt,
  };

  const transition = {
    taskId: command.taskId,
    attemptId: command.attemptId,
    aggregateVersion: newVersion,
    eventType: command.eventType,
    idempotencyKey: command.idempotencyKey,
    commandDigest: '', // filled by service
    transitionPayload: command.payload,
    committedResult: command.committedResult,
    evidenceRefs: command.evidenceRefs,
    causationId: command.causationId,
    correlationId: command.correlationId,
  };

  return { nextState, attempt: null, transition };
}

// ---------------------------------------------------------------------------
// issue_retry_attempt
// ---------------------------------------------------------------------------

function reduceRetryAttempt(
  currentState: TaskExecutionState | null,
  currentAttempt: TaskExecutionAttempt | null,
  command: IssueRetryAttemptCommand,
  deps: { attemptId: string; transitionId: string; now: Date },
): ReducerResult | ExecutionAuthorityError {
  // Guard: there must be an existing aggregate
  if (currentState === null) {
    return new StaleVersionError(command.taskId, command.expectedVersion, 0);
  }

  // Guard: version must match
  if (command.expectedVersion !== currentState.aggregateVersion) {
    return new StaleVersionError(
      command.taskId,
      command.expectedVersion,
      currentState.aggregateVersion,
    );
  }

  // Guard: must have a current attempt
  if (currentAttempt === null) {
    return new UnissuedAttemptError(
      command.taskId,
      currentState.currentAttemptId ?? '(none)',
      'not_found',
    );
  }

  // Guard: must belong to this task
  if (currentAttempt.taskId !== command.taskId) {
    return new UnissuedAttemptError(
      command.taskId,
      currentAttempt.attemptId,
      'not_found',
    );
  }

  // Guard: must be the current attempt
  if (currentAttempt.attemptId !== currentState.currentAttemptId) {
    return new UnissuedAttemptError(
      command.taskId,
      currentAttempt.attemptId,
      'not_current',
    );
  }

  // Guard: retry only permitted from failed
  if (currentAttempt.status !== 'failed') {
    return new InvalidTransitionError(
      command.taskId,
      currentAttempt.attemptId,
      currentAttempt.status,
      'retry',
    );
  }

  // Guard: retry budget not exhausted
  if (currentState.retryCount >= currentState.retryBudget) {
    return new RetryBudgetExhaustedError(
      command.taskId,
      currentState.retryCount,
      currentState.retryBudget,
    );
  }

  // Guard: retry backoff must be satisfied
  if (
    currentState.retryEligibleAt !== null &&
    deps.now < currentState.retryEligibleAt
  ) {
    return new RetryBackoffError(
      command.taskId,
      currentState.retryEligibleAt,
      deps.now,
    );
  }

  const newRetryCount = currentState.retryCount + 1;
  const newVersion = currentState.aggregateVersion + 1;

  const nextState: TaskExecutionState = {
    taskId: currentState.taskId,
    aggregateVersion: newVersion,
    currentAttemptId: deps.attemptId,
    retryBudget: currentState.retryBudget,
    retryCount: newRetryCount,
    retryBackoffMs: currentState.retryBackoffMs,
    // Clear the consumed backoff — a new backoff is set only when this
    // new attempt subsequently fails via transition_attempt.
    retryEligibleAt: null,
  };

  const ordinal = currentState.retryCount + 2; // ordinal 1 was first, retryCount was 0-based for spent retries

  const attempt: TaskExecutionAttempt = {
    attemptId: deps.attemptId,
    taskId: command.taskId,
    ordinal,
    status: 'issued',
    issuedAt: deps.now,
    startedAt: null,
    completedAt: null,
  };

  const transition = {
    taskId: command.taskId,
    attemptId: deps.attemptId,
    aggregateVersion: newVersion,
    eventType: 'attempt:retry_issued' as const,
    idempotencyKey: command.idempotencyKey,
    commandDigest: '', // filled by service
    transitionPayload: {} as Record<string, unknown>,
    committedResult: {} as Record<string, unknown>,
    evidenceRefs: command.evidenceRefs,
    causationId: command.causationId,
    correlationId: command.correlationId,
  };

  return { nextState, attempt, transition };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeRetryEligibleAt(
  now: Date,
  state: TaskExecutionState,
): Date | null {
  if (state.retryBackoffMs <= 0) return null;
  // Exponential backoff: base * 2^(retryCount)
  const delay =
    state.retryBackoffMs * Math.pow(2, Math.max(0, state.retryCount));
  // Cap at 1 hour to prevent unreasonable delays
  const capped = Math.min(delay, MAX_RETRY_BACKOFF_MS);
  return new Date(now.getTime() + capped);
}

function validateRetryConfig(
  budget: number,
  backoffMs: number,
): InvalidRetryConfigError | null {
  if (
    typeof budget !== 'number' ||
    !Number.isSafeInteger(budget) ||
    budget < 0 ||
    budget > MAX_RETRY_BUDGET
  ) {
    return new InvalidRetryConfigError(
      'retryBudget',
      budget,
      `must be a safe integer between 0 and ${MAX_RETRY_BUDGET}`,
    );
  }
  if (
    typeof backoffMs !== 'number' ||
    !Number.isSafeInteger(backoffMs) ||
    backoffMs < 0 ||
    backoffMs > MAX_RETRY_BACKOFF_MS
  ) {
    return new InvalidRetryConfigError(
      'retryBackoffMs',
      backoffMs,
      `must be a safe integer between 0 and ${MAX_RETRY_BACKOFF_MS}`,
    );
  }
  return null;
}
