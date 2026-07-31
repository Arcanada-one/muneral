// MUN-0020: Typed fail-closed errors. Every error is raised before any state
// mutation — no partial aggregate/journal rows survive a thrown error.

/**
 * The command's expectedVersion does not match the current aggregate version.
 * The caller must re-read the aggregate and re-issue the command.
 */
export class StaleVersionError extends Error {
  public readonly code = 'STALE_VERSION' as const;

  constructor(
    public readonly taskId: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(
      `Stale version for task ${taskId}: expected ${expectedVersion}, got ${actualVersion}`,
    );
    this.name = 'StaleVersionError';
  }
}

/**
 * The requested attempt status transition is not valid given the current
 * attempt state (e.g. running → running, or succeeded → anything).
 */
export class InvalidTransitionError extends Error {
  public readonly code = 'INVALID_TRANSITION' as const;

  constructor(
    public readonly taskId: string,
    public readonly attemptId: string,
    public readonly from: string,
    public readonly to: string,
  ) {
    super(
      `Invalid transition for task ${taskId} attempt ${attemptId}: ${from} → ${to}`,
    );
    this.name = 'InvalidTransitionError';
  }
}

/**
 * The command references an attempt that has not been issued by Muneral, or
 * references a non-current attempt (one that has been superseded by a retry).
 */
export class UnissuedAttemptError extends Error {
  public readonly code = 'UNISSUED_ATTEMPT' as const;

  constructor(
    public readonly taskId: string,
    public readonly attemptId: string,
    public readonly reason: 'not_found' | 'not_current',
  ) {
    super(
      `Unissued attempt for task ${taskId}: ${attemptId} (${reason})`,
    );
    this.name = 'UnissuedAttemptError';
  }
}

/**
 * The idempotency key is reused with a different canonical command digest.
 * The caller must use a new key or issue the same command bytes.
 */
export class IdempotencyCollisionError extends Error {
  public readonly code = 'IDEMPOTENCY_COLLISION' as const;

  constructor(
    public readonly taskId: string,
    public readonly idempotencyKey: string,
    public readonly storedDigest: string,
    public readonly receivedDigest: string,
  ) {
    super(
      `Idempotency collision for task ${taskId} key ${idempotencyKey}: ` +
        `stored digest ${storedDigest.substring(0, 16)}... ≠ ` +
        `received digest ${receivedDigest.substring(0, 16)}...`,
    );
    this.name = 'IdempotencyCollisionError';
  }
}

/**
 * The retry budget for this task is exhausted (retryCount >= retryBudget).
 * No further retries will be permitted without an operator override.
 */
export class RetryBudgetExhaustedError extends Error {
  public readonly code = 'RETRY_BUDGET_EXHAUSTED' as const;

  constructor(
    public readonly taskId: string,
    public readonly retryCount: number,
    public readonly retryBudget: number,
  ) {
    super(
      `Retry budget exhausted for task ${taskId}: ${retryCount}/${retryBudget}`,
    );
    this.name = 'RetryBudgetExhaustedError';
  }
}

/**
 * A retry was requested before the backoff period has elapsed.
 * The caller must wait until retryEligibleAt before issuing a retry command.
 */
export class RetryBackoffError extends Error {
  public readonly code = 'RETRY_BACKOFF' as const;

  constructor(
    public readonly taskId: string,
    public readonly retryEligibleAt: Date,
    public readonly now: Date,
  ) {
    super(
      `Retry backoff for task ${taskId}: eligible at ${retryEligibleAt.toISOString()}, ` +
        `now ${now.toISOString()}`,
    );
    this.name = 'RetryBackoffError';
  }
}

/**
 * The initial attempt command specified a nonzero expected version, meaning
 * an aggregate already exists. Use issue_retry_attempt for existing tasks.
 */
export class ExecutionStateAlreadyExistsError extends Error {
  public readonly code = 'EXECUTION_STATE_ALREADY_EXISTS' as const;

  constructor(
    public readonly taskId: string,
    public readonly actualVersion: number,
  ) {
    super(
      `Execution state already exists for task ${taskId} at version ${actualVersion}`,
    );
    this.name = 'ExecutionStateAlreadyExistsError';
  }
}

/**
 * A unique-constraint violation on a constraint that cannot express a lost
 * version race — for example a duplicate attempt or transition UUID produced by
 * a faulty IdSource.
 *
 * This is deliberately NOT a member of `ExecutionAuthorityError`. Every member
 * of that union is a domain outcome the caller is expected to handle by
 * re-reading the aggregate and re-issuing the command. This condition is not:
 * re-issuing would collide identically forever, so it is thrown rather than
 * returned, joining the other unexpected infrastructure failures.
 *
 * It exists because the previous code reported such violations as
 * `StaleVersionError`, producing self-contradictory diagnostics
 * ("expected 0, got 0") and an unbounded caller retry loop (QA finding F4).
 */
export class UnexpectedUniqueViolationError extends Error {
  public readonly code = 'UNEXPECTED_UNIQUE_VIOLATION' as const;

  constructor(
    public readonly taskId: string,
    /** Constraint name, or the violated column set, or 'unknown'. */
    public readonly constraint: string,
    public readonly cause?: unknown,
  ) {
    super(
      `Unexpected unique-constraint violation for task ${taskId} on ${constraint}: ` +
        `this constraint cannot express a lost version race, so the command ` +
        `must not be retried as a stale-version conflict`,
    );
    this.name = 'UnexpectedUniqueViolationError';
  }
}

export type { EvidenceRefValidationError } from './evidence-ref.validator';

/**
 * The command specifies a retry budget or backoff outside the allowed bounds.
 */
export class InvalidRetryConfigError extends Error {
  public readonly code = 'INVALID_RETRY_CONFIG' as const;

  constructor(
    public readonly field: string,
    public readonly value: number,
    public readonly reason: string,
  ) {
    super(`Invalid retry config: ${field}=${value} — ${reason}`);
    this.name = 'InvalidRetryConfigError';
  }
}

/** Union of all typed execution-authority errors for exhaustiveness checks. */
export type ExecutionAuthorityError =
  | StaleVersionError
  | InvalidTransitionError
  | UnissuedAttemptError
  | IdempotencyCollisionError
  | RetryBudgetExhaustedError
  | RetryBackoffError
  | ExecutionStateAlreadyExistsError
  | InvalidRetryConfigError;
