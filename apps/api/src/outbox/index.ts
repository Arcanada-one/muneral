// MUN-0021: Outbox relay public API surface.
// Deliberately narrow — no HTTP controller, no NestJS module, no provider
// wiring. Consumers instantiate OutboxRelay directly with a Prisma
// transaction client. Disabled by default.

export { OutboxRelay } from './outbox.relay';
export type { TransactionalClient } from './outbox.relay';

export {
  WrongPlanePayloadError,
  OutboxInsertError,
  LeaseAcquisitionError,
  StaleFenceError,
  ConsumerExecutionError,
  LeaseExpiredError,
  InboxIntegrityError,
} from './outbox.errors';

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
} from './outbox.types';

export {
  deriveOutboxEventType,
  validatePayloadPlane,
  FORBIDDEN_PAYLOAD_KEYS,
  normaliseConfig,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_BATCH_SIZE,
} from './outbox.types';
