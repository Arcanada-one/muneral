// MUN-0020: Muneral execution authority — discriminated commands, attempt
// lifecycle, aggregate state, and immutable transition facts.
// No HTTP controller, provider/model invocation, broker, outbox, relay, or
// Assembly Package wiring. The module extends the existing Task model; it does
// not introduce a competing work-item concept.

// ---------------------------------------------------------------------------
// Bounded constants
// ---------------------------------------------------------------------------

/** Maximum retry budget a Muneral command may authorize. */
export const MAX_RETRY_BUDGET = 1000;
/** Maximum retry backoff in milliseconds (1 hour). */
export const MAX_RETRY_BACKOFF_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Evidence reference — bounded, content-addressed pointer
// ---------------------------------------------------------------------------

/** A structured reference to external evidence with digest validation. */
export interface EvidenceRef {
  /** Bounded URI — not an arbitrary URL; must be a content-addressed path. */
  uri: string;
  /** SHA-256 hex digest of the referenced content. */
  digest: string;
  /** MIME content type (e.g. "text/plain", "application/json"). */
  contentType: string;
  /** Optional human-readable label. */
  label?: string;
}

// ---------------------------------------------------------------------------
// Attempt status machine
// ---------------------------------------------------------------------------

export type AttemptStatus =
  | 'issued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/**
 * Allowed attempt status edges. Terminal statuses (succeeded, cancelled)
 * cannot transition. Only `failed` can receive a retry via issue_retry_attempt.
 */
export const ATTEMPT_TRANSITIONS: Record<AttemptStatus, AttemptStatus[]> = {
  issued: ['running', 'failed', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [], // retry issues a NEW attempt, does not mutate this one
  cancelled: [],
};

export function isValidAttemptTransition(
  from: AttemptStatus,
  to: AttemptStatus,
): boolean {
  return ATTEMPT_TRANSITIONS[from]?.includes(to) ?? false;
}

/** True when the attempt can never transition again. */
export function isTerminalAttempt(status: AttemptStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

/**
 * True when the aggregate should clear currentAttemptId.
 * Only succeeded/cancelled — failed remains current for Muneral retry authorization.
 */
export function clearsCurrentAttempt(status: AttemptStatus): boolean {
  return status === 'succeeded' || status === 'cancelled';
}

// ---------------------------------------------------------------------------
// Transition event type
// ---------------------------------------------------------------------------

export type TransitionEventType =
  | 'attempt:issued'
  | 'attempt:started'
  | 'attempt:succeeded'
  | 'attempt:failed'
  | 'attempt:cancelled'
  | 'attempt:retry_issued';

/** Maps a TransitionEventType to the target AttemptStatus it implies. */
export const EVENT_TO_ATTEMPT_STATUS: Record<
  TransitionEventType,
  AttemptStatus
> = {
  'attempt:issued': 'issued',
  'attempt:started': 'running',
  'attempt:succeeded': 'succeeded',
  'attempt:failed': 'failed',
  'attempt:cancelled': 'cancelled',
  'attempt:retry_issued': 'issued',
};

// ---------------------------------------------------------------------------
// Aggregate state
// ---------------------------------------------------------------------------

/** One row per task — the task-scoped execution aggregate root. */
export interface TaskExecutionState {
  taskId: string;
  aggregateVersion: number;
  currentAttemptId: string | null;
  retryBudget: number;
  retryCount: number;
  retryBackoffMs: number;
  retryEligibleAt: Date | null;
}

/** One row per Muneral-issued execution attempt. */
export interface TaskExecutionAttempt {
  attemptId: string;
  taskId: string;
  ordinal: number;
  status: AttemptStatus;
  issuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

/** One immutable row per transition fact — append-only journal. */
export interface TaskExecutionTransition {
  id: string;
  taskId: string;
  attemptId: string;
  aggregateVersion: number;
  eventType: TransitionEventType;
  idempotencyKey: string;
  commandDigest: string; // SHA-256 hex of canonical command JSON
  transitionPayload: Record<string, unknown>;
  committedResult: Record<string, unknown>;
  evidenceRefs: EvidenceRef[];
  causationId: string;
  correlationId: string;
  recordedAt: Date;
}

// ---------------------------------------------------------------------------
// Discriminated commands
// ---------------------------------------------------------------------------

export interface IssueInitialAttemptCommand {
  readonly kind: 'issue_initial_attempt';
  readonly taskId: string;
  readonly expectedVersion: number; // must be 0
  readonly idempotencyKey: string;
  readonly causationId: string;
  readonly correlationId: string;
  readonly retryBudget: number;
  readonly retryBackoffMs: number;
  readonly evidenceRefs: EvidenceRef[];
}

export interface TransitionAttemptCommand {
  readonly kind: 'transition_attempt';
  readonly taskId: string;
  readonly attemptId: string;
  readonly expectedVersion: number;
  readonly eventType: TransitionEventType;
  readonly idempotencyKey: string;
  readonly causationId: string;
  readonly correlationId: string;
  readonly evidenceRefs: EvidenceRef[];
  readonly payload: Record<string, unknown>;
  readonly committedResult: Record<string, unknown>;
}

export interface IssueRetryAttemptCommand {
  readonly kind: 'issue_retry_attempt';
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly causationId: string;
  readonly correlationId: string;
  readonly evidenceRefs: EvidenceRef[];
}

export type ExecutionAuthorityCommand =
  | IssueInitialAttemptCommand
  | TransitionAttemptCommand
  | IssueRetryAttemptCommand;

// ---------------------------------------------------------------------------
// Idempotency record
// ---------------------------------------------------------------------------

export interface IdempotencyRecord {
  idempotencyKey: string;
  commandDigest: string;
  committedResult: Record<string, unknown>;
  aggregateVersion: number;
  transitionId: string;
  recordedAt: Date;
}

// ---------------------------------------------------------------------------
// Reducer result
// ---------------------------------------------------------------------------

export interface ReducerResult {
  nextState: TaskExecutionState;
  attempt: TaskExecutionAttempt | null;
  transition: Omit<TaskExecutionTransition, 'id' | 'recordedAt'>;
}

// ---------------------------------------------------------------------------
// Service dependencies
// ---------------------------------------------------------------------------

export interface Clock {
  now(): Date;
}

export interface IdSource {
  generate(): string;
}
