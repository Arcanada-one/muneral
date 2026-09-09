// MUN-0020: Execution authority public API surface.
// The pure reducer/service/replay core stays framework-free — no HTTP
// controller, still no dependency on Nest beyond what's needed to hand it a
// Prisma transaction. MUN-0040 adds the one NestJS seam
// (ExecutionAuthorityModule) needed to let application code inject the
// service instead of constructing it by hand, plus TaskExecutionRecorderService,
// which is the thing that actually calls it from the real task lifecycle.

export { ExecutionAuthorityService } from './execution-authority.service';
export { ExecutionAuthorityModule } from './execution-authority.module';
export {
  TaskExecutionRecorderService,
} from './task-execution-recorder.service';
export type { RecordOutcome, RecordVerdict } from './task-execution-recorder.service';
export { TaskStalenessService } from './task-staleness.service';
export type { TaskStalenessEntry, StalenessVerdict } from './task-staleness.service';
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
