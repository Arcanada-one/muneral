// MUN-0020: Pure reducer unit tests — exhaustive coverage of allowed and
// disallowed transitions, version gating, retry logic, and error typing.

import { reduce } from '../src/execution-authority/execution-authority.reducer';
import {
  ExecutionStateAlreadyExistsError,
  InvalidTransitionError,
  RetryBackoffError,
  RetryBudgetExhaustedError,
  StaleVersionError,
} from '../src/execution-authority/execution-authority.errors';
import type {
  IssueInitialAttemptCommand,
  IssueRetryAttemptCommand,
  TaskExecutionAttempt,
  TaskExecutionState,
  TransitionAttemptCommand,
} from '../src/execution-authority/execution-authority.types';

const DEPS = {
  attemptId: 'attempt-uuid-1',
  transitionId: 'tx-uuid-1',
  now: new Date('2026-07-30T12:00:00Z'),
};

const DEPS_RETRY = {
  attemptId: 'attempt-uuid-2',
  transitionId: 'tx-uuid-2',
  now: new Date('2026-07-30T12:05:00Z'),
};

// Current attempt fixture for transition_attempt tests
const ATT_ISSUED: TaskExecutionAttempt = {
  attemptId: 'attempt-uuid-1',
  taskId: 'task-1',
  ordinal: 1,
  status: 'issued',
  issuedAt: DEPS.now,
  startedAt: null,
  completedAt: null,
};

const ATT_RUNNING: TaskExecutionAttempt = {
  ...ATT_ISSUED,
  status: 'running',
  startedAt: DEPS.now,
};

// Current attempt fixture for retry tests
const ATT_FAILED: TaskExecutionAttempt = {
  attemptId: 'attempt-old',
  taskId: 'task-1',
  ordinal: 1,
  status: 'failed',
  issuedAt: DEPS.now,
  startedAt: new Date('2026-07-30T11:00:00Z'),
  completedAt: new Date('2026-07-30T11:30:00Z'),
};

describe('reduce — issue_initial_attempt', () => {
  const cmd: IssueInitialAttemptCommand = {
    kind: 'issue_initial_attempt',
    taskId: 'task-1',
    expectedVersion: 0,
    idempotencyKey: 'idem-1',
    causationId: 'cause-1',
    correlationId: 'corr-1',
    retryBudget: 3,
    retryBackoffMs: 1_000,
    evidenceRefs: [],
  };

  it('creates initial state and attempt at version 1', () => {
    const result = reduce(null, null, cmd, DEPS);
    expect(result).not.toBeInstanceOf(Error);
    if (result instanceof Error) return;

    expect(result.nextState.aggregateVersion).toBe(1);
    expect(result.nextState.currentAttemptId).toBe(DEPS.attemptId);
    expect(result.nextState.retryBudget).toBe(3);
    expect(result.nextState.retryCount).toBe(0);
    expect(result.nextState.retryBackoffMs).toBe(1_000);
    expect(result.nextState.retryEligibleAt).toBeNull();

    expect(result.attempt).not.toBeNull();
    expect(result.attempt!.attemptId).toBe(DEPS.attemptId);
    expect(result.attempt!.ordinal).toBe(1);
    expect(result.attempt!.status).toBe('issued');
    expect(result.attempt!.startedAt).toBeNull();
    expect(result.attempt!.completedAt).toBeNull();

    expect(result.transition.eventType).toBe('attempt:issued');
    expect(result.transition.aggregateVersion).toBe(1);
  });

  it('rejects nonzero expectedVersion (aggregate already exists)', () => {
    const cmdNonzero: IssueInitialAttemptCommand = {
      ...cmd,
      expectedVersion: 1,
    };
    const result = reduce(null, null, cmdNonzero, DEPS);
    expect(result).toBeInstanceOf(StaleVersionError);
  });

  it('rejects when aggregate already exists', () => {
    const existingState: TaskExecutionState = {
      taskId: 'task-1',
      aggregateVersion: 1,
      currentAttemptId: 'some-id',
      retryBudget: 3,
      retryCount: 0,
      retryBackoffMs: 1_000,
      retryEligibleAt: null,
    };
    const result = reduce(existingState, null, cmd, DEPS);
    expect(result).toBeInstanceOf(ExecutionStateAlreadyExistsError);
  });
});

describe('reduce — transition_attempt', () => {
  const baseState: TaskExecutionState = {
    taskId: 'task-1',
    aggregateVersion: 1,
    currentAttemptId: 'attempt-uuid-1',
    retryBudget: 3,
    retryCount: 0,
    retryBackoffMs: 1_000,
    retryEligibleAt: null,
  };

  const makeCmd = (
    overrides: Partial<TransitionAttemptCommand> = {},
  ): TransitionAttemptCommand => ({
    kind: 'transition_attempt',
    taskId: 'task-1',
    attemptId: 'attempt-uuid-1',
    expectedVersion: 1,
    eventType: 'attempt:started',
    idempotencyKey: 'idem-2',
    causationId: 'cause-2',
    correlationId: 'corr-2',
    evidenceRefs: [],
    payload: {},
    committedResult: { status: 'running' },
    ...overrides,
  });

  it('allows issued → started (running)', () => {
    const result = reduce(baseState, ATT_ISSUED, makeCmd(), DEPS);
    expect(result).not.toBeInstanceOf(Error);
    if (result instanceof Error) return;

    expect(result.nextState.aggregateVersion).toBe(2);
    expect(result.nextState.currentAttemptId).toBe('attempt-uuid-1');
    expect(result.attempt).toBeNull();
    expect(result.transition.eventType).toBe('attempt:started');
  });

  it('advances the version monotonically', () => {
    const stateV5: TaskExecutionState = {
      ...baseState,
      aggregateVersion: 5,
    };
    const cmd = makeCmd({ expectedVersion: 5, eventType: 'attempt:succeeded' });
    const result = reduce(stateV5, ATT_RUNNING, cmd, DEPS);
    expect(result).not.toBeInstanceOf(Error);
    if (result instanceof Error) return;

    expect(result.nextState.aggregateVersion).toBe(6);
  });

  it('clears currentAttemptId on terminal succeeded', () => {
    const cmd = makeCmd({
      eventType: 'attempt:succeeded',
      committedResult: { status: 'done' },
    });
    const result = reduce(baseState, ATT_RUNNING, cmd, DEPS);
    expect(result).not.toBeInstanceOf(Error);
    if (result instanceof Error) return;

    expect(result.nextState.currentAttemptId).toBeNull();
  });

  it('clears currentAttemptId on terminal cancelled', () => {
    const cmd = makeCmd({
      eventType: 'attempt:cancelled',
      committedResult: { status: 'cancelled' },
    });
    const result = reduce(baseState, ATT_RUNNING, cmd, DEPS);
    expect(result).not.toBeInstanceOf(Error);
    if (result instanceof Error) return;

    expect(result.nextState.currentAttemptId).toBeNull();
  });

  it('preserves currentAttemptId on failed (not cleared like succeeded/cancelled)', () => {
    const cmd = makeCmd({
      eventType: 'attempt:failed',
      committedResult: { error: 'crash' },
    });
    const result = reduce(baseState, ATT_ISSUED, cmd, DEPS);
    expect(result).not.toBeInstanceOf(Error);
    if (result instanceof Error) return;
    // currentAttemptId persists — retry authorization needs the failed attempt
    expect(result.nextState.currentAttemptId).toBe('attempt-uuid-1');
    expect(result.nextState.retryEligibleAt).not.toBeNull();
  });

  it('sets retryEligibleAt on failure', () => {
    const cmd = makeCmd({
      eventType: 'attempt:failed',
      committedResult: { error: 'crash' },
    });
    const result = reduce(baseState, ATT_ISSUED, cmd, DEPS);
    expect(result).not.toBeInstanceOf(Error);
    if (result instanceof Error) return;

    expect(result.nextState.retryEligibleAt).not.toBeNull();
    // retryBackoffMs = 1000, retryCount = 0 → 1000 * 2^0 = 1000ms
    expect(
      result.nextState.retryEligibleAt!.getTime(),
    ).toBeGreaterThan(DEPS.now.getTime());
  });

  it('rejects stale expectedVersion', () => {
    const cmd = makeCmd({ expectedVersion: 0 });
    const result = reduce(baseState, ATT_ISSUED, cmd, DEPS);
    expect(result).toBeInstanceOf(StaleVersionError);
    if (result instanceof StaleVersionError) {
      expect(result.expectedVersion).toBe(0);
      expect(result.actualVersion).toBe(1);
    }
  });

  it('rejects null state (no aggregate exists)', () => {
    const cmd = makeCmd();
    const result = reduce(null, null, cmd, DEPS);
    expect(result).toBeInstanceOf(StaleVersionError);
  });
});

describe('reduce — issue_retry_attempt', () => {
  const failedState: TaskExecutionState = {
    taskId: 'task-1',
    aggregateVersion: 3,
    currentAttemptId: 'attempt-old',
    retryBudget: 3,
    retryCount: 1,
    retryBackoffMs: 100,
    retryEligibleAt: new Date('2026-07-30T12:04:00Z'), // before DEPS_RETRY.now
  };

  const makeCmd = (
    overrides: Partial<IssueRetryAttemptCommand> = {},
  ): IssueRetryAttemptCommand => ({
    kind: 'issue_retry_attempt',
    taskId: 'task-1',
    expectedVersion: 3,
    idempotencyKey: 'idem-retry',
    causationId: 'cause-retry',
    correlationId: 'corr-retry',
    evidenceRefs: [],
    ...overrides,
  });

  it('issues a new attempt and advances version/count', () => {
    const result = reduce(failedState, ATT_FAILED, makeCmd(), DEPS_RETRY);
    expect(result).not.toBeInstanceOf(Error);
    if (result instanceof Error) return;

    expect(result.nextState.aggregateVersion).toBe(4);
    expect(result.nextState.currentAttemptId).toBe(DEPS_RETRY.attemptId);
    expect(result.nextState.retryCount).toBe(2);

    expect(result.attempt).not.toBeNull();
    expect(result.attempt!.attemptId).toBe(DEPS_RETRY.attemptId);
    expect(result.attempt!.ordinal).toBe(3); // retryCount was 1, ordinal = 1 + spent + 1 (this one)
    expect(result.attempt!.status).toBe('issued');

    expect(result.transition.eventType).toBe('attempt:retry_issued');
    expect(result.transition.aggregateVersion).toBe(4);
  });

  it('rejects when retry budget is exhausted', () => {
    const exhausted: TaskExecutionState = {
      ...failedState,
      retryCount: 3,
      retryBudget: 3,
    };
    const cmd = makeCmd({ expectedVersion: 3 });
    const result = reduce(
      { ...exhausted, aggregateVersion: 3 },
      ATT_FAILED,
      cmd,
      DEPS_RETRY,
    );
    expect(result).toBeInstanceOf(RetryBudgetExhaustedError);
  });

  it('rejects when before retryEligibleAt', () => {
    const notYetEligible: TaskExecutionState = {
      ...failedState,
      retryEligibleAt: new Date('2026-07-30T13:00:00Z'), // after now
    };
    const result = reduce(
      { ...notYetEligible, aggregateVersion: 3 },
      ATT_FAILED,
      makeCmd({ expectedVersion: 3 }),
      DEPS_RETRY,
    );
    expect(result).toBeInstanceOf(RetryBackoffError);
  });

  it('rejects stale expectedVersion', () => {
    const result = reduce(failedState, ATT_FAILED, makeCmd({ expectedVersion: 1 }), DEPS_RETRY);
    expect(result).toBeInstanceOf(StaleVersionError);
  });
});
