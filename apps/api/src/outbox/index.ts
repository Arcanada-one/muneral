// MUN-0021: Outbox relay public API surface.
// Deliberately narrow — no HTTP controller, no NestJS module, no provider
// wiring. Consumers instantiate OutboxRelay directly with a Prisma
// transaction client. Disabled by default.

export { OutboxRelay } from './outbox.relay.js';
export type { TransactionalClient } from './outbox.relay.js';

export {
  MalformedOutboxEventError,
  WrongPlanePayloadError,
  OutboxInsertError,
  LeaseAcquisitionError,
  StaleFenceError,
  ConsumerExecutionError,
  LeaseExpiredError,
  InboxIntegrityError,
} from './outbox.errors.js';

export type {
  OutboxEventType,
  OutboxEventPayloadV1,
  OutboxEvent,
  DeliveryDisposition,
  LeaseStatus,
  LeaseFence,
  OutboxLeaseState,
  DeliveryAttempt,
  QuarantineEntry,
  OutboxConsumer,
  ConsumerResult,
  RelayConfig,
  CycleResult,
  ReconciliationSnapshot,
  Clock,
  IdSource,
} from './outbox.types.js';

export {
  deriveOutboxEventType,
  validateOutboxEvent,
  validatePayloadPlane,
  FORBIDDEN_PAYLOAD_KEYS,
  normaliseConfig,
  sanitiseErrorDetail,
  MAX_ERROR_DETAIL_LENGTH,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_BATCH_SIZE,
} from './outbox.types.js';

export { OutboxModule } from './outbox.module.js';
export { OutboxRelayWorker, relayEnabled, relayIntervalMs } from './outbox-relay.worker.js';
export {
  WorkOutcomeLedgerConsumer,
  WORK_OUTCOME_LEDGER_CONSUMER_ID,
  WORK_OUTCOME_EVENT_TYPES,
} from './work-outcome-ledger.consumer.js';
export { foldWorkOutcomes, readWorkOutcome } from './work-outcome-ledger.reader.js';
export type {
  WorkOutcomeDisposition,
  WorkOutcomeRow,
  WorkOutcomeView,
} from './work-outcome-ledger.reader.js';
