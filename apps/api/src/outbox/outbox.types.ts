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
  | 'attempt:issued'
  | 'attempt:started'
  | 'attempt:retry_issued'
  | 'task:completed'
  | 'task:failed'
  | 'task:terminal_failed'
  | 'task:cancelled';

/**
 * Map a transition event type and post-transition retry state to the outbox
 * event type. Every committed authority transition has one stable outbox
 * identity; transport consumers may ignore event kinds they do not need.
 */
export function deriveOutboxEventType(
  transitionEventType: TransitionEventType,
  retryCount: number,
  retryBudget: number,
): OutboxEventType {
  switch (transitionEventType) {
    case 'attempt:issued':
      return 'attempt:issued';
    case 'attempt:started':
      return 'attempt:started';
    case 'attempt:retry_issued':
      return 'attempt:retry_issued';
    case 'attempt:succeeded':
      return 'task:completed';
    case 'attempt:failed':
      return retryCount >= retryBudget
        ? 'task:terminal_failed'
        : 'task:failed';
    case 'attempt:cancelled':
      return 'task:cancelled';
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

const OUTBOX_EVENT_FIELDS = new Set([
  'id',
  'taskId',
  'aggregateVersion',
  'attemptId',
  'transitionId',
  'eventType',
  'eventPayload',
  'recordedAt',
  '_fence',
]);

const REQUIRED_OUTBOX_EVENT_FIELDS = [
  'id',
  'taskId',
  'aggregateVersion',
  'attemptId',
  'transitionId',
  'eventType',
  'eventPayload',
  'recordedAt',
] as const;

const OUTBOX_PAYLOAD_FIELDS = new Set([
  'schema',
  'transitionEventType',
  'committedResult',
  'idempotencyKey',
  'aggregateVersion',
  'attemptId',
  'attemptOrdinal',
  'retryCount',
  'retryBudget',
]);

const TRANSITION_EVENT_TYPES = new Set<TransitionEventType>([
  'attempt:issued',
  'attempt:started',
  'attempt:retry_issued',
  'attempt:succeeded',
  'attempt:failed',
  'attempt:cancelled',
]);

const OUTBOX_EVENT_TYPES = new Set<OutboxEventType>([
  'attempt:issued',
  'attempt:started',
  'attempt:retry_issued',
  'task:completed',
  'task:failed',
  'task:terminal_failed',
  'task:cancelled',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Validate the closed server-derived event and its row/payload identity.
 * Returns a bounded reason on refusal and null on success. Wrong-plane content
 * is checked separately so it retains its dedicated typed error/evidence code.
 */
export function validateOutboxEvent(value: unknown): string | null {
  if (!isPlainRecord(value)) return 'outbox event must be a plain object';
  for (const key of REQUIRED_OUTBOX_EVENT_FIELDS) {
    if (!(key in value)) return `missing required field "${key}" on outbox event`;
  }
  for (const key of Object.keys(value)) {
    if (!OUTBOX_EVENT_FIELDS.has(key)) {
      return `unknown field "${key}" on closed outbox event`;
    }
  }
  for (const key of ['id', 'taskId', 'attemptId', 'transitionId'] as const) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      return `${key} must be a non-empty string`;
    }
  }
  if (
    typeof value.aggregateVersion !== 'number' ||
    !Number.isSafeInteger(value.aggregateVersion) ||
    value.aggregateVersion < 1
  ) {
    return 'aggregateVersion must be a positive safe integer';
  }
  if (
    typeof value.eventType !== 'string' ||
    !OUTBOX_EVENT_TYPES.has(value.eventType as OutboxEventType)
  ) {
    return 'eventType is not a supported Muneral outbox event type';
  }
  if (
    !(value.recordedAt instanceof Date) ||
    Number.isNaN(value.recordedAt.getTime())
  ) {
    return 'recordedAt must be a valid Date';
  }

  const payload = value.eventPayload;
  if (!isPlainRecord(payload)) return 'eventPayload must be a plain object';
  for (const key of OUTBOX_PAYLOAD_FIELDS) {
    if (!(key in payload)) {
      return `missing required field "${key}" on outbox event payload`;
    }
  }
  for (const key of Object.keys(payload)) {
    if (!OUTBOX_PAYLOAD_FIELDS.has(key)) {
      return `unknown field "${key}" on closed outbox event payload`;
    }
  }
  if (payload.schema !== 'muneral-outbox-v1') {
    return 'eventPayload.schema must be "muneral-outbox-v1"';
  }
  if (
    typeof payload.transitionEventType !== 'string' ||
    !TRANSITION_EVENT_TYPES.has(
      payload.transitionEventType as TransitionEventType,
    )
  ) {
    return 'eventPayload.transitionEventType is unsupported';
  }
  if (!isPlainRecord(payload.committedResult)) {
    return 'eventPayload.committedResult must be a plain object';
  }
  if (
    typeof payload.idempotencyKey !== 'string' ||
    payload.idempotencyKey.length === 0 ||
    payload.idempotencyKey.length > 256
  ) {
    return 'eventPayload.idempotencyKey must be 1..256 characters';
  }
  for (const [key, minimum] of [
    ['aggregateVersion', 1],
    ['attemptOrdinal', 1],
    ['retryCount', 0],
    ['retryBudget', 0],
  ] as const) {
    const field = payload[key];
    if (
      typeof field !== 'number' ||
      !Number.isSafeInteger(field) ||
      field < minimum
    ) {
      return `eventPayload.${key} must be a safe integer of at least ${minimum}`;
    }
  }
  if (typeof payload.attemptId !== 'string' || payload.attemptId.length === 0) {
    return 'eventPayload.attemptId must be a non-empty string';
  }
  if ((payload.retryCount as number) > (payload.retryBudget as number)) {
    return 'eventPayload.retryCount cannot exceed retryBudget';
  }
  if (payload.aggregateVersion !== value.aggregateVersion) {
    return 'aggregateVersion mismatch between outbox row and event payload';
  }
  if (payload.attemptId !== value.attemptId) {
    return 'attemptId mismatch between outbox row and event payload';
  }
  const derived = deriveOutboxEventType(
    payload.transitionEventType as TransitionEventType,
    payload.retryCount as number,
    payload.retryBudget as number,
  );
  if (derived !== value.eventType) {
    return 'eventType mismatch between outbox row and transition payload';
  }
  return null;
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
 * Forbidden keys at any depth in an outbox event payload. The presence of any
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
  // `nodeId` / `node_id` are deliberately NOT listed. The ARCA-0194 result
  // consilium ratified that a valid Task Card `nodeId` is a result addressing
  // field and must be accepted, while Supervisor lifecycle, placement,
  // watchdog and command authority stay rejected. Per-message closed
  // validators in src/result-authority own the result plane; this structural
  // denylist remains the backstop for every other payload.
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
 * keys at any depth. Returns a string error message on violation, null on
 * pass. The traversal is bounded and fails closed on cyclic or over-deep
 * structures, which are invalid JSON payloads in any case.
 *
 * This structural guard does NOT import or depend on a Supervisor domain
 * model.
 */
export function validatePayloadPlane(
  payload: Record<string, unknown>,
): string | null {
  const forbidden = new Set(FORBIDDEN_PAYLOAD_KEYS);
  const seen = new WeakSet<object>();
  let visitedNodes = 0;

  const visit = (
    value: unknown,
    path: string,
    depth: number,
  ): string | null => {
    if (value === null || typeof value !== 'object') return null;
    if (depth > 16) {
      return `wrong-plane payload rejected: structure exceeds the bounded validation depth at "${path}"`;
    }
    if (seen.has(value)) {
      return `wrong-plane payload rejected: cyclic structure at "${path}"`;
    }
    seen.add(value);
    visitedNodes += 1;
    if (visitedNodes > 256) {
      return 'wrong-plane payload rejected: structure exceeds the bounded validation size';
    }

    for (const key of Object.keys(value)) {
      const childPath = `${path}.${key}`;
      if (forbidden.has(key)) {
        return `wrong-plane payload rejected: forbidden key "${key}" at "${childPath}" — Muneral outbox transports task facts only; fleet/supervisor content belongs in the separate Supervisor project`;
      }
      const nested = visit(
        (value as Record<string, unknown>)[key],
        childPath,
        depth + 1,
      );
      if (nested) return nested;
    }
    return null;
  };

  return visit(payload, '$', 0);
}

// ---------------------------------------------------------------------------
// Error detail sanitisation (IMP6)
// ---------------------------------------------------------------------------

/** Maximum length of error_detail stored in delivery attempt evidence. */
export const MAX_ERROR_DETAIL_LENGTH = 256;

/**
 * Sanitise a raw error message for storage in error_detail.
 * Truncates to MAX_ERROR_DETAIL_LENGTH, strips newlines and control
 * characters, and redacts potential secret patterns.
 * Returns a bounded Record<string, unknown> suitable for JSONB storage.
 *
 * Redaction order matters: credential/key patterns are redacted FIRST,
 * then control characters stripped, then the result is truncated.
 */
export function sanitiseErrorDetail(raw: string): Record<string, unknown> {
  // Redact credential/token/key shapes before any other processing.
  // These patterns cover common secret formats without being exhaustive
  // enough to require a domain-specific secret scanner.
  let cleaned = raw
    // JWT tokens (three base64url segments separated by dots)
    .replace(/eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, '[REDACTED:jwt]')
    // Bearer tokens
    .replace(/bearer\s+[a-zA-Z0-9_\-+.%=]+/gi, 'Bearer [REDACTED]')
    // GitHub personal access tokens (ghp_ prefix; redact partial values too)
    .replace(/ghp_[a-zA-Z0-9]{16,}/g, '[REDACTED:github-pat]')
    // Slack bot tokens (xoxb- prefix, digits + hyphens + alphanumeric)
    .replace(
      /xoxb-[0-9]+-[0-9]+(?:-[a-zA-Z0-9]+)?/g,
      '[REDACTED:slack-bot]',
    )
    // Stripe live/secret keys (sk_live_ or sk-live-, standalone token form)
    .replace(
      /sk[-_]live[-_][a-zA-Z0-9]{20,}/g,
      '[REDACTED:stripe-live]',
    )
    // API key patterns (sk-..., pk-..., etc.) with key=value delimiter
    .replace(/\b(sk|pk|api[-_]?key|token|secret|password|passwd|pwd)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    // Connection strings with embedded credentials
    .replace(/[a-z]+:\/\/[^:]+:[^@]+@/gi, '[REDACTED-URL]://')
    // AWS-style access keys and secrets
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED:aws-key]')
    // Private key headers/footers (PEM)
    .replace(/-----BEGIN\s*(RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END\s*(RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g, '[REDACTED:private-key]')
    // Generic long hex/base64 strings (likely tokens)
    .replace(/\b[a-fA-F0-9]{64,}\b/g, '[REDACTED:hex-64+]')
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[REDACTED:base64-40+]');

  // Strip control characters (except tab, newline), then newlines
  cleaned = cleaned
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/\n/g, ' ')
    .replace(/\r/g, '');

  // Truncate to max length
  const truncated = cleaned.length > MAX_ERROR_DETAIL_LENGTH;
  cleaned = cleaned.slice(0, MAX_ERROR_DETAIL_LENGTH);

  return {
    error: cleaned,
    truncated: truncated || raw.length > MAX_ERROR_DETAIL_LENGTH,
  };
}

// ---------------------------------------------------------------------------
// Service dependencies (re-exported from execution-authority for convenience)
// ---------------------------------------------------------------------------

export type { Clock, IdSource } from '../execution-authority/execution-authority.types';
