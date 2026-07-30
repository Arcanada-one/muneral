// MUN-0020: Execution authority public API surface.
// Deliberately narrow — no HTTP controller, no NestJS module, no provider
// wiring. Consumers use the service directly with a Prisma transaction.

export { ExecutionAuthorityService } from './execution-authority.service';
export type {
  ExecutionResult,
  ExecutionOutcome,
  TransactionalClient,
} from './execution-authority.service';

export { reduce } from './execution-authority.reducer';

export { canonicalJson, commandDigest, jsonDigest } from './canonical-json';

export { replayJournal, decisionHash } from './execution-authority.replay';

export {
  StaleVersionError,
  InvalidTransitionError,
  UnissuedAttemptError,
  IdempotencyCollisionError,
  RetryBudgetExhaustedError,
  RetryBackoffError,
  ExecutionStateAlreadyExistsError,
} from './execution-authority.errors';
export type { ExecutionAuthorityError } from './execution-authority.errors';

export type {
  AttemptStatus,
  TransitionEventType,
  TaskExecutionState,
  TaskExecutionAttempt,
  TaskExecutionTransition,
  IssueInitialAttemptCommand,
  TransitionAttemptCommand,
  IssueRetryAttemptCommand,
  ExecutionAuthorityCommand,
  IdempotencyRecord,
  ReducerResult,
  Clock,
  IdSource,
} from './execution-authority.types';

export {
  ATTEMPT_TRANSITIONS,
  EVENT_TO_ATTEMPT_STATUS,
  isValidAttemptTransition,
  isTerminalAttempt,
  clearsCurrentAttempt,
  MAX_RETRY_BUDGET,
  MAX_RETRY_BACKOFF_MS,
} from './execution-authority.types';

export {
  validateEvidenceRef,
  validateEvidenceRefs,
  EvidenceRefValidationError,
} from './evidence-ref.validator';
