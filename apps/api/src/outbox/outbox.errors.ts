// MUN-0021: Outbox typed errors — fail-closed error classes for lease,
// dispatch, quarantine, fencing, and wrong-plane rejection.
// All errors extend the standard Error class and carry typed context fields.

/**
 * A payload was rejected because it contained forbidden fleet/supervisor keys.
 * This is a structural guard — no Supervisor domain model is imported.
 */
export class WrongPlanePayloadError extends Error {
  public readonly outboxEventId: string;
  public readonly forbiddenKey: string;

  constructor(outboxEventId: string, forbiddenKey: string) {
    super(
      `wrong-plane payload rejected for outbox event ${outboxEventId}: forbidden key "${forbiddenKey}" — Muneral outbox transports task facts only`,
    );
    this.name = 'WrongPlanePayloadError';
    this.outboxEventId = outboxEventId;
    this.forbiddenKey = forbiddenKey;
  }
}

/** Outbox row creation failed — should roll back the authority transaction. */
export class OutboxInsertError extends Error {
  public readonly taskId: string;
  public readonly transitionId: string;

  constructor(taskId: string, transitionId: string, cause: string) {
    super(`outbox insert failed for task ${taskId} transition ${transitionId}: ${cause}`);
    this.name = 'OutboxInsertError';
    this.taskId = taskId;
    this.transitionId = transitionId;
  }
}

/** Lease acquisition returned empty — no events matched the predicate. */
export class LeaseAcquisitionError extends Error {
  public readonly eventIds: string[];

  constructor(eventIds: string[], reason: string) {
    super(`lease acquisition failed for ${eventIds.length} events: ${reason}`);
    this.name = 'LeaseAcquisitionError';
    this.eventIds = eventIds;
  }
}

/**
 * Stale fence — the caller's lease holder or ordinal did not match the
 * current lease row. The lease was reclaimed by another worker.
 */
export class StaleFenceError extends Error {
  public readonly outboxEventId: string;
  public readonly expected: { holder: string; ordinal: number };
  public readonly actual: { holder: string | null; ordinal: number };

  constructor(
    outboxEventId: string,
    expected: { holder: string; ordinal: number },
    actual: { holder: string | null; ordinal: number },
  ) {
    super(
      `stale fence for outbox event ${outboxEventId}: expected holder=${expected.holder} ordinal=${expected.ordinal}, got holder=${actual.holder} ordinal=${actual.ordinal}`,
    );
    this.name = 'StaleFenceError';
    this.outboxEventId = outboxEventId;
    this.expected = expected;
    this.actual = actual;
  }
}

/** Consumer threw during dispatch — may trigger retry or quarantine. */
export class ConsumerExecutionError extends Error {
  public readonly outboxEventId: string;
  public readonly consumerId: string;
  public readonly cause: Error;

  constructor(outboxEventId: string, consumerId: string, cause: Error) {
    super(`consumer ${consumerId} failed for outbox event ${outboxEventId}: ${cause.message}`);
    this.name = 'ConsumerExecutionError';
    this.outboxEventId = outboxEventId;
    this.consumerId = consumerId;
    this.cause = cause;
  }
}

/** Lease expired before dispatch could complete. */
export class LeaseExpiredError extends Error {
  public readonly outboxEventId: string;
  public readonly expiresAt: Date;

  constructor(outboxEventId: string, expiresAt: Date) {
    super(`lease expired for outbox event ${outboxEventId} at ${expiresAt.toISOString()}`);
    this.name = 'LeaseExpiredError';
    this.outboxEventId = outboxEventId;
    this.expiresAt = expiresAt;
  }
}

/** Inbox integrity check failed — digest mismatch or unexpected state. */
export class InboxIntegrityError extends Error {
  public readonly consumerId: string;
  public readonly outboxEventId: string;

  constructor(consumerId: string, outboxEventId: string, detail: string) {
    super(`inbox integrity error for consumer ${consumerId} event ${outboxEventId}: ${detail}`);
    this.name = 'InboxIntegrityError';
    this.consumerId = consumerId;
    this.outboxEventId = outboxEventId;
  }
}
