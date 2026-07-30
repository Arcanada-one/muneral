// MUN-0021: Outbox relay types — server-derived outbox event payload,
// consumer contract, relay configuration, lease fencing, and reconciliation
// surface. No HTTP controller, provider/model invocation, broker, or runtime
// wiring. This relay transports committed Muneral task facts only: no fleet
// registry, lifecycle, placement, update, watchdog, telemetry aggregation, or
// direct command routing.

import type { TransitionEventType } from '../execution-authority/execution-authority.types';

// ---------------------------------------------------------------------------
// Outbox event types — derived from MUN-0020 transition outcomes
// ---------------------------------------------------------------------------

export type OutboxEventType =
  | 'task:completed'
  | 'task:failed'
  | 'task:terminal_failed'
  | 'task:cancelled';

/**
 * Map a transition event type and post-transition retry state to the outbox
 * event type. Returns null when no outbox event should be emitted (e.g.
 * attempt:started, attempt:issued, attempt:retry_issued).
 */
export function deriveOutboxEventType(
  transitionEventType: TransitionEventType,
  retryCount: number,
  retryBudget: number,
): OutboxEventType | null {
  switch (transitionEventType) {
    case 'attempt:succeeded':
      return 'task:completed';
    case 'attempt:failed':
      return retryCount >= retryBudget
        ? 'task:terminal_failed'
        : 'task:failed';
    case 'attempt:cancelled':
      return 'task:cancelled';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Outbox event payload v1 — server-derived closed envelope
// ---------------------------------------------------------------------------

/**
 * Closed v1 payload derived by the server from the committed transition and
 * aggregate state. Callers cannot choose routing, recipient, or an opaque
 * payload. Every field is populated from authoritative Muneral facts.
 */
export interface OutboxEventPayloadV1 {
  schema: 'muneral-outbox-v1';
  /** The transition event type that triggered this outbox row. */
  transitionEventType: TransitionEventType;
  /** The transition's committed result (from TaskExecutionTransition). */
  committedResult: Record<string, unknown>;
  /** The transition's idempotency key. */
  idempotencyKey: string;
  /** The aggregate version at the time of this transition. */
  aggregateVersion: number;
  /** The attempt that this transition applies to. */
  attemptId: string;
  /** The attempt's ordinal. */
  attemptOrdinal: number;
  /** Retry state at the time of this transition. */
  retryCount: number;
  retryBudget: number;
}

// ---------------------------------------------------------------------------
// Outbox event (stable identity)
// ---------------------------------------------------------------------------

export interface OutboxEvent {
  id: string;
  taskId: string;
  aggregateVersion: number;
  attemptId: string;
  transitionId: string;
  eventType: OutboxEventType;
  /** Server-derived closed payload — never caller-chosen. */
  eventPayload: OutboxEventPayloadV1;
  recordedAt: Date;
}

// ---------------------------------------------------------------------------
// Delivery disposition
// ---------------------------------------------------------------------------

export type DeliveryDisposition = 'delivered' | 'quarantined' | 'expired';

// ---------------------------------------------------------------------------
// Delivery lease state (with fencing)
// ---------------------------------------------------------------------------

export type LeaseStatus = 'pending' | 'leased' | 'delivered' | 'quarantined';

/** Fence token — holder + ordinal must match for any mutation to succeed. */
export interface LeaseFence {
  leaseHolder: string;
  deliveryOrdinal: number;
}

export interface OutboxLeaseState {
  outboxEventId: string;
  leaseHolder: string | null;
  leaseAcquiredAt: Date | null;
  leaseExpiresAt: Date | null;
  deliveryStatus: LeaseStatus;
  deliveryOrdinal: number;
  failureCount: number;
  lastErrorCode: string | null;
}

// ---------------------------------------------------------------------------
// Delivery attempt evidence
// ---------------------------------------------------------------------------

export interface DeliveryAttempt {
  id: string;
  outboxEventId: string;
  deliveryOrdinal: number;
  disposition: DeliveryDisposition;
  consumerDigest: string | null;
  errorDetail: Record<string, unknown> | null;
  attemptedAt: Date;
}

// ---------------------------------------------------------------------------
// Quarantine evidence
// ---------------------------------------------------------------------------

export interface QuarantineEntry {
  id: string;
  outboxEventId: string;
  deliveryOrdinal: number;
  failureCount: number;
  lastErrorCode: string | null;
  lastErrorDetail: Record<string, unknown> | null;
  quarantinedAt: Date;
}

// ---------------------------------------------------------------------------
// Consumer contract
// ---------------------------------------------------------------------------

/** The consumer's return type — a digest and optional result. */
export interface ConsumerResult {
  /** SHA-256 hex digest of the side-effect evidence. */
  digest: string;
  /** Optional structured result for delivery-attempt evidence. */
  result?: Record<string, unknown>;
}

/**
 * A consumer that applies a database-local fixture side effect
 * transactionally with the inbox write. Network, provider, tool, and
 * filesystem effects are prohibited — the consumer receives only the
 * open Prisma transaction.
 */
export interface OutboxConsumer {
  /** Stable consumer identity for inbox deduplication. */
  readonly consumerId: string;

  /**
   * Apply the side effect and return a digest.
   * Called inside the same transaction as the inbox write.
   * Throw to signal failure — the relay records a delivery-attempt evidence
   * row and may quarantine after maxRetries.
   */
  consume(
    event: OutboxEvent,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx: any,
  ): Promise<ConsumerResult>;
}

// ---------------------------------------------------------------------------
// Relay configuration
// ---------------------------------------------------------------------------

export interface RelayConfig {
  /** Lease TTL in milliseconds (default 60_000, min 1_000, max 300_000). */
  leaseTtlMs: number;
  /** Max consecutive failures before quarantine (default 3, min 1, max 10). */
  maxRetries: number;
  /** Max events to poll per cycle (default 10, min 1, max 100). */
  batchSize: number;
  /** Relay instance identity — used as lease_holder. */
  relayId: string;
}

export const DEFAULT_LEASE_TTL_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_BATCH_SIZE = 10;

/** Validate and normalise a RelayConfig. Returns a fully-populated config. */
export function normaliseConfig(
  partial: Partial<RelayConfig> & { relayId: string },
): RelayConfig {
  const leaseTtlMs = partial.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const maxRetries = partial.maxRetries ?? DEFAULT_MAX_RETRIES;
  const batchSize = partial.batchSize ?? DEFAULT_BATCH_SIZE;

  if (
    typeof leaseTtlMs !== 'number' ||
    !Number.isSafeInteger(leaseTtlMs) ||
    leaseTtlMs < 1_000 ||
    leaseTtlMs > 300_000
  ) {
    throw new Error(
      `leaseTtlMs must be a safe integer between 1000 and 300000, got ${leaseTtlMs}`,
    );
  }
  if (
    typeof maxRetries !== 'number' ||
    !Number.isSafeInteger(maxRetries) ||
    maxRetries < 1 ||
    maxRetries > 10
  ) {
    throw new Error(
      `maxRetries must be a safe integer between 1 and 10, got ${maxRetries}`,
    );
  }
  if (
    typeof batchSize !== 'number' ||
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 100
  ) {
    throw new Error(
      `batchSize must be a safe integer between 1 and 100, got ${batchSize}`,
    );
  }
  if (typeof partial.relayId !== 'string' || partial.relayId.length === 0) {
    throw new Error('relayId must be a non-empty string');
  }

  return { relayId: partial.relayId, leaseTtlMs, maxRetries, batchSize };
}

// ---------------------------------------------------------------------------
// Cycle result
// ---------------------------------------------------------------------------

export interface CycleResult {
  polled: number;
  leased: number;
  delivered: number;
  quarantined: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// Reconciliation snapshot
// ---------------------------------------------------------------------------

export interface ReconciliationSnapshot {
  /** Counts per delivery_status. */
  leaseSummary: Record<string, number>;
  /** All quarantined events with their evidence. */
  quarantined: QuarantineEntry[];
  /** Delivery attempt count per outbox event. */
  attemptCounts: Array<{ outboxEventId: string; count: number }>;
  /** Inbox row count per consumer. */
  inboxSummary: Record<string, number>;
  /** Events with no lease row (should always be zero). */
  orphanEvents: string[];
  /** Leased events with expired leases. */
  staleLeases: Array<{ outboxEventId: string; expiresAt: Date }>;
}

// ---------------------------------------------------------------------------
// Wrong-plane payload validation — reject fleet/supervisor content before any
// host or process effect, without importing a Supervisor domain model.
// ---------------------------------------------------------------------------

/**
 * Forbidden top-level keys in an outbox event payload. The presence of any
 * of these keys signals a wrong-plane payload (fleet registry, lifecycle,
 * placement, update, watchdog, telemetry, or direct command routing).
 * This is a structural check only — no Supervisor domain model is imported.
 */
export const FORBIDDEN_PAYLOAD_KEYS: readonly string[] = [
  'host_id',
  'hostId',
  'instance_id',
  'instanceId',
  'desired_generation',
  'desiredGeneration',
  'desired_state',
  'desiredState',
  'observed_state',
  'observedState',
  'placement',
  'rollout',
  'rollback',
  'stage',
  'activate',
  'deactivate',
  'canary',
  'drain',
  'heartbeat',
  'watchdog',
  'progress',
  'telemetry',
  'fleet',
  'controller_epoch',
  'controllerEpoch',
  'node_id',
  'nodeId',
  'runtime_incarnation',
  'runtimeIncarnation',
  'start_process',
  'startProcess',
  'stop_process',
  'stopProcess',
  'cancel_process',
  'cancelProcess',
  'restart_process',
  'restartProcess',
];

/**
 * Validate that an event payload does not contain forbidden fleet/supervisor
 * keys. Returns a string error message on violation, null on pass.
 *
 * This is a structural guard that does NOT import or depend on a Supervisor
 * domain model. It checks only top-level JSON keys.
 */
export function validatePayloadPlane(
  payload: Record<string, unknown>,
): string | null {
  for (const key of Object.keys(payload)) {
    if ((FORBIDDEN_PAYLOAD_KEYS as readonly string[]).includes(key)) {
      return `wrong-plane payload rejected: forbidden key "${key}" — Muneral outbox transports task facts only; fleet/supervisor content belongs in the separate Supervisor project`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Service dependencies (re-exported from execution-authority for convenience)
// ---------------------------------------------------------------------------

export type { Clock, IdSource } from '../execution-authority/execution-authority.types';
