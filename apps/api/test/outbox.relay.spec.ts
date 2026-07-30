// MUN-0021: Outbox relay unit tests.
// Verifies poll, lease, dispatch, fence, commit-before-ack dedup,
// poison quarantine, stop/resume, reconciliation, wrong-plane rejection,
// and negative controls. All tests use in-memory mock Prisma — no database.

import { OutboxRelay } from '../src/outbox/outbox.relay';
import type { TransactionalClient } from '../src/outbox/outbox.relay';
import { normaliseConfig } from '../src/outbox/outbox.types';
import { WrongPlanePayloadError } from '../src/outbox/outbox.errors';
import type {
  OutboxEvent,
  OutboxConsumer,
  ConsumerResult,
  RelayConfig,
  LeaseFence,
  Clock,
  IdSource,
} from '../src/outbox/outbox.types';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date('2026-07-30T12:00:00Z');
const FIXED_NOW_PLUS_30S = new Date('2026-07-30T12:00:30Z');
const FIXED_NOW_MINUS_90S = new Date('2026-07-30T11:58:30Z'); // 90s ago → expired lease

const clock: Clock = { now: () => FIXED_NOW };

let idCounter = 0;
const idSource: IdSource = {
  generate: () => {
    idCounter += 1;
    return `id-${String(idCounter).padStart(4, '0')}`;
  },
};

const config: RelayConfig = normaliseConfig({
  relayId: 'test-relay-01',
  leaseTtlMs: 60_000,
  maxRetries: 3,
  batchSize: 10,
});

// ---------------------------------------------------------------------------
// Outbox event factory
// ---------------------------------------------------------------------------

function makeOutboxEvent(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    id: 'evt-0001',
    taskId: 'task-0001',
    aggregateVersion: 5,
    attemptId: 'att-0001',
    transitionId: 'txn-0001',
    eventType: 'task:completed',
    eventPayload: {
      schema: 'muneral-outbox-v1',
      transitionEventType: 'attempt:succeeded',
      committedResult: { status: 'done' },
      idempotencyKey: 'idem-1',
      aggregateVersion: 5,
      attemptId: 'att-0001',
      attemptOrdinal: 1,
      retryCount: 0,
      retryBudget: 3,
    },
    recordedAt: FIXED_NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Consumer factory
// ---------------------------------------------------------------------------

function makeConsumer(
  overrides: Partial<OutboxConsumer> = {},
): OutboxConsumer {
  return {
    consumerId: 'consumer-01',
    consume: jest.fn().mockResolvedValue({
      digest: 'sha256:abc123',
      result: { saved: true },
    } as ConsumerResult),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock Prisma transaction helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeTx(overrides: Record<string, any> = {}): any {
  return {
    taskOutboxEvent: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    outboxLease: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue({}),
    },
    consumerInbox: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    deliveryAttemptEvidence: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    quarantineEvidence: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $queryRawUnsafe: undefined,
    ...overrides,
  };
}

function makePrisma(
  tx: ReturnType<typeof makeTx>,
): TransactionalClient {
  return {
    $transaction: jest
      .fn()
      .mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (fn: (t: any) => Promise<unknown>) => fn(tx),
      ),
  };
}

// ---------------------------------------------------------------------------
// Mock lease row factory
// ---------------------------------------------------------------------------

function makeLeaseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outboxEventId: 'evt-0001',
    leaseHolder: null,
    leaseAcquiredAt: null,
    leaseExpiresAt: null,
    deliveryStatus: 'pending',
    deliveryOrdinal: 0,
    failureCount: 0,
    lastErrorCode: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock outbox event row factory (as returned by Prisma findMany)
// ---------------------------------------------------------------------------

function makeOutboxRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'evt-0001',
    task_id: 'task-0001',
    aggregate_version: 5n,
    attempt_id: 'att-0001',
    transition_id: 'txn-0001',
    event_type: 'task:completed',
    event_payload: {
      schema: 'muneral-outbox-v1',
      transitionEventType: 'attempt:succeeded',
      committedResult: { status: 'done' },
      idempotencyKey: 'idem-1',
      aggregateVersion: 5,
      attemptId: 'att-0001',
      attemptOrdinal: 1,
      retryCount: 0,
      retryBudget: 3,
    },
    recorded_at: FIXED_NOW.toISOString(),
    lease: {
      outboxEventId: 'evt-0001',
      deliveryStatus: 'pending',
      leaseHolder: null,
      leaseAcquiredAt: null,
      leaseExpiresAt: null,
      deliveryOrdinal: 0,
      failureCount: 0,
      lastErrorCode: null,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OutboxRelay', () => {
  let relay: OutboxRelay;

  beforeEach(() => {
    idCounter = 0;
    relay = new OutboxRelay(
      {} as TransactionalClient,
      clock,
      idSource,
      config,
    );
  });

  // -- construction & defaults ------------------------------------------------

  describe('construction', () => {
    it('is stopped by default (disabled-by-default contract)', () => {
      expect((relay as unknown as { stopped: boolean }).stopped).toBe(true);
    });

    it('cycle returns zero-result when stopped', async () => {
      const prisma = makePrisma(makeTx());
      const stoppedRelay = new OutboxRelay(prisma, clock, idSource, config);
      const consumer = makeConsumer();
      const result = await stoppedRelay.cycle(consumer);
      expect(result).toEqual({
        polled: 0, leased: 0, delivered: 0, quarantined: 0, skipped: 0,
      });
    });
  });

  // -- poll ------------------------------------------------------------------

  describe('poll', () => {
    it('fetches events with pending leases', async () => {
      const row = makeOutboxRow();
      const tx = makeTx({
        taskOutboxEvent: {
          findMany: jest.fn().mockResolvedValue([row]),
        },
      });
      const prisma = makePrisma(tx);
      const pollRelay = new OutboxRelay(prisma, clock, idSource, config);

      const events = await pollRelay.poll();
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe('evt-0001');
      expect(events[0].taskId).toBe('task-0001');
    });

    it('fetches events with expired leases', async () => {
      const row = makeOutboxRow({
        lease: {
          outboxEventId: 'evt-0001',
          deliveryStatus: 'leased',
          leaseHolder: 'other-relay',
          leaseExpiresAt: FIXED_NOW_MINUS_90S.toISOString(),
          deliveryOrdinal: 1,
          failureCount: 0,
        },
      });
      const tx = makeTx({
        taskOutboxEvent: {
          findMany: jest.fn().mockResolvedValue([row]),
        },
      });
      const prisma = makePrisma(tx);
      const pollRelay = new OutboxRelay(prisma, clock, idSource, config);

      const events = await pollRelay.poll();
      expect(events).toHaveLength(1);
    });

    it('returns empty array when no events match', async () => {
      const tx = makeTx({
        taskOutboxEvent: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      });
      const prisma = makePrisma(tx);
      const pollRelay = new OutboxRelay(prisma, clock, idSource, config);

      const events = await pollRelay.poll();
      expect(events).toHaveLength(0);
    });

    it('respects batchSize from config', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const tx = makeTx({ taskOutboxEvent: { findMany } });
      const prisma = makePrisma(tx);
      const pollRelay = new OutboxRelay(prisma, clock, idSource, config);
      await pollRelay.poll();

      // The findMany call should include take: config.batchSize
      const callArgs = findMany.mock.calls[0][0];
      expect(callArgs.take).toBe(config.batchSize);
    });
  });

  // -- lease -----------------------------------------------------------------

  describe('lease', () => {
    it('returns empty array for empty input', async () => {
      const events = await relay.lease([]);
      expect(events).toHaveLength(0);
    });

    it('acquires lease with relayId prefix as crash prefix', async () => {
      // The lease holder format is `${relayId}-${idSource.generate()}`
      // We verify the prefix contract via the raw SQL fallback path.
      const events = [makeOutboxEvent()];
      const leaseRow = makeLeaseRow({ deliveryStatus: 'pending' });

      const tx = makeTx({
        outboxLease: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue({
            ...leaseRow,
            leaseHolder: `${config.relayId}-id-0001`,
            deliveryOrdinal: 1,
            deliveryStatus: 'leased',
          }),
        },
      });
      const prisma = makePrisma(tx);
      const leaseRelay = new OutboxRelay(prisma, clock, idSource, config);

      const leased = await leaseRelay.lease(events);
      expect(leased).toHaveLength(1);

      // Verify the cycleId contains the relayId prefix (crash prefix contract)
      const cycleId = (leaseRelay as unknown as { cycleId: string | null }).cycleId;
      expect(cycleId).not.toBeNull();
      expect(cycleId).toContain(config.relayId);
    });

    it('skips events already leased by another holder (not expired)', async () => {
      const events = [makeOutboxEvent()];
      // The updateMany returns { count: 0 } — lease not acquired
      const tx = makeTx({
        outboxLease: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          findUnique: jest.fn().mockResolvedValue(null),
        },
      });
      const prisma = makePrisma(tx);
      const leaseRelay = new OutboxRelay(prisma, clock, idSource, config);

      const leased = await leaseRelay.lease(events);
      expect(leased).toHaveLength(0);
    });

    it('resets failure_count to 0 on lease acquisition', async () => {
      const events = [makeOutboxEvent()];
      const tx = makeTx({
        outboxLease: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue({
            outboxEventId: 'evt-0001',
            leaseHolder: `${config.relayId}-id-0001`,
            deliveryOrdinal: 2,
            failureCount: 0,
            deliveryStatus: 'leased',
          }),
        },
      });
      const prisma = makePrisma(tx);
      const leaseRelay = new OutboxRelay(prisma, clock, idSource, config);

      const leased = await leaseRelay.lease(events);
      expect(leased).toHaveLength(1);

      // Verify failure_count was reset in the updateMany call
      const updateCall = tx.outboxLease.updateMany.mock.calls[0][0];
      expect(updateCall.data.failureCount).toBe(0);
    });

    it('increments delivery_ordinal on each lease acquisition', async () => {
      const events = [makeOutboxEvent()];
      const tx = makeTx({
        outboxLease: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue({
            outboxEventId: 'evt-0001',
            leaseHolder: `${config.relayId}-id-0001`,
            deliveryOrdinal: 3,
            failureCount: 0,
            deliveryStatus: 'leased',
          }),
        },
      });
      const prisma = makePrisma(tx);
      const leaseRelay = new OutboxRelay(prisma, clock, idSource, config);

      await leaseRelay.lease(events);

      // Verify delivery_ordinal is incremented
      const updateCall = tx.outboxLease.updateMany.mock.calls[0][0];
      expect(updateCall.data.deliveryOrdinal).toEqual({ increment: 1 });
    });
  });

  // -- dispatch: wrong-plane rejection ---------------------------------------

  describe('dispatch — wrong-plane payload rejection', () => {
    it('rejects payload with forbidden fleet key (host_id) before consumer invocation', async () => {
      const event = makeOutboxEvent({
        eventPayload: {
          schema: 'muneral-outbox-v1',
          transitionEventType: 'attempt:succeeded',
          committedResult: { status: 'done' },
          idempotencyKey: 'idem-1',
          aggregateVersion: 5,
          attemptId: 'att-0001',
          attemptOrdinal: 1,
          retryCount: 0,
          retryBudget: 3,
          host_id: 'h-1234', // WRONG PLANE
        } as unknown as OutboxEvent['eventPayload'],
      });

      const leaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
      });

      const tx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue(leaseRow),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });
      const prisma = makePrisma(tx);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);
      const consumer = makeConsumer();

      // Attach fence to event
      const fencedEvent = {
        ...event,
        _fence: { leaseHolder: 'holder-1', deliveryOrdinal: 1 } as LeaseFence,
      } as OutboxEvent & { _fence: LeaseFence };

      await expect(
        dispatchRelay.dispatch(fencedEvent as unknown as OutboxEvent, consumer),
      ).rejects.toThrow(WrongPlanePayloadError);

      // Consumer must NOT have been invoked
      expect(consumer.consume).not.toHaveBeenCalled();

      // Must have been quarantined
      expect(tx.quarantineEvidence.create).toHaveBeenCalled();
      expect(tx.deliveryAttemptEvidence.create).toHaveBeenCalled();

      // Verify quarantine was created with WRONG_PLANE error code
      const quarantineCall = tx.quarantineEvidence.create.mock.calls[0][0];
      expect(quarantineCall.data.lastErrorCode).toBe('WRONG_PLANE');
    });

    it('rejects payload with Supervisor-shaped key (desired_state)', async () => {
      const event = makeOutboxEvent({
        eventPayload: {
          schema: 'muneral-outbox-v1',
          transitionEventType: 'attempt:succeeded',
          committedResult: { status: 'done' },
          idempotencyKey: 'idem-1',
          aggregateVersion: 5,
          attemptId: 'att-0001',
          attemptOrdinal: 1,
          retryCount: 0,
          retryBudget: 3,
          desired_state: 'running', // Supervisor-shaped
        } as unknown as OutboxEvent['eventPayload'],
      });

      const leaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
      });

      const tx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue(leaseRow),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });
      const prisma = makePrisma(tx);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);
      const consumer = makeConsumer();

      const fencedEvent = {
        ...event,
        _fence: { leaseHolder: 'holder-1', deliveryOrdinal: 1 } as LeaseFence,
      } as OutboxEvent & { _fence: LeaseFence };

      await expect(
        dispatchRelay.dispatch(fencedEvent as unknown as OutboxEvent, consumer),
      ).rejects.toThrow(WrongPlanePayloadError);

      expect(consumer.consume).not.toHaveBeenCalled();
    });

    it('NEGATIVE-CONTROL: Supervisor-shaped payload does not alter attempt identity, aggregate version, retry budget or result references', async () => {
      // The wrong-plane check happens before any state mutation.
      // We verify the event's identity fields are untouched.
      const originalEvent = makeOutboxEvent({
        eventPayload: {
          schema: 'muneral-outbox-v1',
          transitionEventType: 'attempt:succeeded',
          committedResult: { status: 'done' },
          idempotencyKey: 'idem-1',
          aggregateVersion: 5,
          attemptId: 'att-0001',
          attemptOrdinal: 1,
          retryCount: 0,
          retryBudget: 3,
          fleet: 'production', // Supervisor-shaped
        } as unknown as OutboxEvent['eventPayload'],
      });

      const leaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 1,
      });

      const tx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue(leaseRow),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });
      const prisma = makePrisma(tx);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);

      const negConsumer = makeConsumer();
      const fencedEvent = {
        ...originalEvent,
        _fence: { leaseHolder: 'holder-1', deliveryOrdinal: 1 } as LeaseFence,
      } as OutboxEvent & { _fence: LeaseFence };

      await expect(
        dispatchRelay.dispatch(fencedEvent as unknown as OutboxEvent, negConsumer),
      ).rejects.toThrow(WrongPlanePayloadError);

      // Identity fields must be unchanged
      expect(originalEvent.id).toBe('evt-0001');
      expect(originalEvent.taskId).toBe('task-0001');
      expect(originalEvent.aggregateVersion).toBe(5);
      expect(originalEvent.attemptId).toBe('att-0001');
      expect(originalEvent.eventPayload.retryBudget).toBe(3);
      expect(originalEvent.eventPayload.retryCount).toBe(0);
    });
  });

  // -- dispatch: fence & lease expiry ----------------------------------------

  describe('dispatch — fence and lease expiry', () => {
    it('returns expired on stale fence (lease reclaimed by another worker)', async () => {
      const event = makeOutboxEvent();
      const leaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'other-holder', // Different holder!
        deliveryOrdinal: 5, // Different ordinal!
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
      });

      const tx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue(leaseRow),
        },
      });
      const prisma = makePrisma(tx);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);
      const consumer = makeConsumer();

      // Event fence says holder-1, ordinal 1, but actual lease says other-holder, ordinal 5
      const fencedEvent = {
        ...event,
        _fence: { leaseHolder: 'holder-1', deliveryOrdinal: 1 } as LeaseFence,
      } as OutboxEvent & { _fence: LeaseFence };

      const disposition = await dispatchRelay.dispatch(
        fencedEvent as unknown as OutboxEvent,
        consumer,
      );

      expect(disposition).toBe('expired');
      expect(consumer.consume).not.toHaveBeenCalled();
    });

    it('returns expired when lease has timed out', async () => {
      const event = makeOutboxEvent();
      const leaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_MINUS_90S, // In the past!
      });

      const tx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue(leaseRow),
        },
      });
      const prisma = makePrisma(tx);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);
      const consumer = makeConsumer();

      const fencedEvent = {
        ...event,
        _fence: { leaseHolder: 'holder-1', deliveryOrdinal: 1 } as LeaseFence,
      } as OutboxEvent & { _fence: LeaseFence };

      const disposition = await dispatchRelay.dispatch(
        fencedEvent as unknown as OutboxEvent,
        consumer,
      );

      expect(disposition).toBe('expired');
      expect(consumer.consume).not.toHaveBeenCalled();
    });

    it('returns expired when no lease row exists', async () => {
      const event = makeOutboxEvent();
      const tx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
      });
      const prisma = makePrisma(tx);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);
      const consumer = makeConsumer();

      const disposition = await dispatchRelay.dispatch(event, consumer);
      expect(disposition).toBe('expired');
    });
  });

  // -- dispatch: commit-before-ack (inbox dedup) -----------------------------

  describe('dispatch — commit-before-ack (inbox dedup)', () => {
    it('returns delivered when inbox row already exists (idempotent replay)', async () => {
      const event = makeOutboxEvent();
      const leaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
      });

      const tx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue(leaseRow),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        consumerInbox: {
          findUnique: jest.fn().mockResolvedValue({
            consumerId: 'consumer-01',
            outboxEventId: 'evt-0001',
            side_effect_digest: 'sha256:abc123',
          }),
        },
      });
      const prisma = makePrisma(tx);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);
      const consumer = makeConsumer();

      const fencedEvent = {
        ...event,
        _fence: { leaseHolder: 'holder-1', deliveryOrdinal: 1 } as LeaseFence,
      } as OutboxEvent & { _fence: LeaseFence };

      const disposition = await dispatchRelay.dispatch(
        fencedEvent as unknown as OutboxEvent,
        consumer,
      );

      expect(disposition).toBe('delivered');
      // Consumer must NOT be called — it was already delivered
      expect(consumer.consume).not.toHaveBeenCalled();
      // Lease must be marked as delivered
      expect(tx.outboxLease.updateMany).toHaveBeenCalled();
      // Delivery attempt must be recorded as delivered
      expect(tx.deliveryAttemptEvidence.create).toHaveBeenCalled();
    });

    it('duplicate dispatch is idempotent — does not re-invoke consumer', async () => {
      const event = makeOutboxEvent();
      const leaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
      });

      const tx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue(leaseRow),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        consumerInbox: {
          // First dispatch: no inbox row → consumer is called
          // Second dispatch: inbox row exists → dedup
          findUnique: jest
            .fn()
            .mockResolvedValueOnce(null) // first dispatch
            .mockResolvedValueOnce({
              // second dispatch
              consumerId: 'consumer-01',
              outboxEventId: 'evt-0001',
              side_effect_digest: 'sha256:abc123',
            }),
          create: jest.fn().mockResolvedValue({}),
        },
        deliveryAttemptEvidence: {
          create: jest.fn().mockResolvedValue({}),
        },
      });
      const prisma = makePrisma(tx);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);
      const consumer = makeConsumer();

      const fencedEvent = {
        ...event,
        _fence: { leaseHolder: 'holder-1', deliveryOrdinal: 1 } as LeaseFence,
      } as OutboxEvent & { _fence: LeaseFence };

      // First dispatch — consumer is called
      const r1 = await dispatchRelay.dispatch(
        fencedEvent as unknown as OutboxEvent,
        consumer,
      );
      expect(r1).toBe('delivered');
      expect(consumer.consume).toHaveBeenCalledTimes(1);

      // Second dispatch — dedup, consumer NOT called again
      const r2 = await dispatchRelay.dispatch(
        fencedEvent as unknown as OutboxEvent,
        consumer,
      );
      expect(r2).toBe('delivered');
      expect(consumer.consume).toHaveBeenCalledTimes(1); // still 1
    });
  });

  // -- dispatch: consumer success --------------------------------------------

  describe('dispatch — consumer success', () => {
    it('invokes consumer, writes inbox row, marks lease delivered', async () => {
      const event = makeOutboxEvent();
      const leaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
      });

      const tx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue(leaseRow),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });
      const prisma = makePrisma(tx);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);
      const consumer = makeConsumer();

      const fencedEvent = {
        ...event,
        _fence: { leaseHolder: 'holder-1', deliveryOrdinal: 1 } as LeaseFence,
      } as OutboxEvent & { _fence: LeaseFence };

      const disposition = await dispatchRelay.dispatch(
        fencedEvent as unknown as OutboxEvent,
        consumer,
      );

      expect(disposition).toBe('delivered');
      expect(consumer.consume).toHaveBeenCalledTimes(1);
      // Inbox row must be created with the digest
      expect(tx.consumerInbox.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            consumerId: 'consumer-01',
            outboxEventId: 'evt-0001',
            sideEffectDigest: 'sha256:abc123',
          }),
        }),
      );
      // Lease marked as delivered
      expect(tx.outboxLease.updateMany).toHaveBeenCalled();
    });
  });

  // -- dispatch: consumer failure → retry → quarantine -----------------------

  describe('dispatch — consumer failure → retry → quarantine', () => {
    it('bumps failure_count on consumer error (retry, not yet quarantined)', async () => {
      const event = makeOutboxEvent();
      const leaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
        failureCount: 0,
      });

      const tx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue(leaseRow),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });
      const prisma = makePrisma(tx);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);
      const failingConsumer = makeConsumer({
        consume: jest.fn().mockRejectedValue(new Error('side-effect failed')),
      });

      const fencedEvent = {
        ...event,
        _fence: { leaseHolder: 'holder-1', deliveryOrdinal: 1 } as LeaseFence,
      } as OutboxEvent & { _fence: LeaseFence };

      await expect(
        dispatchRelay.dispatch(
          fencedEvent as unknown as OutboxEvent,
          failingConsumer,
        ),
      ).rejects.toThrow('side-effect failed');

      // Failure count was bumped
      expect(tx.outboxLease.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            outboxEventId: 'evt-0001',
          }),
          data: expect.objectContaining({
            failureCount: { increment: 1 },
          }),
        }),
      );
      // Delivery attempt was recorded
      expect(tx.deliveryAttemptEvidence.create).toHaveBeenCalled();
      // NOT quarantined (failure count < maxRetries)
      expect(tx.quarantineEvidence.create).not.toHaveBeenCalled();
    });

    it('quarantines after maxRetries consecutive failures', async () => {
      const event = makeOutboxEvent();
      // Already at maxRetries - 1 failures
      const leaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
        failureCount: 2, // One more failure → quarantine
      });

      // After bumpFailureCountFenced increments, re-read returns 3 failures
      const tx = makeTx({
        outboxLease: {
          findUnique: jest
            .fn()
            // First call (in dispatch fence check): return leaseRow
            .mockResolvedValueOnce(leaseRow)
            // Second call (in bumpFailureCountFenced re-read): return 3 failures
            .mockResolvedValueOnce({
              ...leaseRow,
              failureCount: 3,
              leaseHolder: 'holder-1',
              deliveryOrdinal: 1,
            }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });
      const prisma = makePrisma(tx);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);
      const failingConsumer = makeConsumer({
        consume: jest.fn().mockRejectedValue(new Error('persistent failure')),
      });

      const fencedEvent = {
        ...event,
        _fence: { leaseHolder: 'holder-1', deliveryOrdinal: 1 } as LeaseFence,
      } as OutboxEvent & { _fence: LeaseFence };

      const disposition = await dispatchRelay.dispatch(
        fencedEvent as unknown as OutboxEvent,
        failingConsumer,
      );

      // Must quarantine — returns 'quarantined', doesn't throw
      expect(disposition).toBe('quarantined');

      // Quarantine evidence recorded
      expect(tx.quarantineEvidence.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            outboxEventId: 'evt-0001',
            failureCount: 3,
            lastErrorCode: 'Error',
          }),
        }),
      );
      // Lease marked as quarantined
      expect(tx.outboxLease.updateMany).toHaveBeenCalled();
    });

    it('does NOT quarantine before maxRetries is reached', async () => {
      const event = makeOutboxEvent();
      const leaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
        failureCount: 0,
      });

      const tx = makeTx({
        outboxLease: {
          findUnique: jest
            .fn()
            .mockResolvedValueOnce(leaseRow)
            // After bump: 1 failure, not at max
            .mockResolvedValueOnce({
              ...leaseRow,
              failureCount: 1,
              leaseHolder: 'holder-1',
              deliveryOrdinal: 1,
            }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });
      const prisma = makePrisma(tx);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);
      const failingConsumer = makeConsumer({
        consume: jest.fn().mockRejectedValue(new Error('transient error')),
      });

      const fencedEvent = {
        ...event,
        _fence: { leaseHolder: 'holder-1', deliveryOrdinal: 1 } as LeaseFence,
      } as OutboxEvent & { _fence: LeaseFence };

      await expect(
        dispatchRelay.dispatch(
          fencedEvent as unknown as OutboxEvent,
          failingConsumer,
        ),
      ).rejects.toThrow('transient error');

      // No quarantine — just a retryable failure
      expect(tx.quarantineEvidence.create).not.toHaveBeenCalled();
    });
  });

  // -- cycle: full poll → lease → dispatch -----------------------------------

  describe('cycle', () => {
    it('returns zero result when stopped', async () => {
      const consumer = makeConsumer();
      const result = await relay.cycle(consumer);
      expect(result).toEqual({
        polled: 0, leased: 0, delivered: 0, quarantined: 0, skipped: 0,
      });
    });

    it('completes full poll→lease→dispatch cycle when started', async () => {
      const row = makeOutboxRow();
      // The lease holder generated by lease() is `${relayId}-${idSource.generate()}`
      // First generate call in this test is within lease(), producing id-0001.
      const expectedHolder = `${config.relayId}-id-0001`;
      const leaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: expectedHolder,
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
      });

      const tx = makeTx({
        taskOutboxEvent: {
          findMany: jest.fn().mockResolvedValue([row]),
        },
        outboxLease: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest
            .fn()
            // lease acquisition re-read
            .mockResolvedValueOnce({
              outboxEventId: 'evt-0001',
              leaseHolder: expectedHolder,
              deliveryOrdinal: 1,
              failureCount: 0,
              deliveryStatus: 'leased',
            })
            // dispatch fence check
            .mockResolvedValueOnce(leaseRow),
        },
        consumerInbox: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({}),
        },
        deliveryAttemptEvidence: {
          create: jest.fn().mockResolvedValue({}),
        },
      });
      const prisma = makePrisma(tx);
      const cycleRelay = new OutboxRelay(prisma, clock, idSource, config);

      // Start the relay
      await cycleRelay.resume();
      expect((cycleRelay as unknown as { stopped: boolean }).stopped).toBe(false);

      const consumer = makeConsumer();
      const result = await cycleRelay.cycle(consumer);

      expect(result.polled).toBe(1);
      expect(result.leased).toBe(1);
      expect(result.delivered).toBe(1);
      expect(result.quarantined).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it('returns early when poll returns no events', async () => {
      const tx = makeTx({
        taskOutboxEvent: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      });
      const prisma = makePrisma(tx);
      const cycleRelay = new OutboxRelay(prisma, clock, idSource, config);
      await cycleRelay.resume();

      const consumer = makeConsumer();
      const result = await cycleRelay.cycle(consumer);

      expect(result).toEqual({
        polled: 0, leased: 0, delivered: 0, quarantined: 0, skipped: 0,
      });
    });
  });

  // -- stop & resume ---------------------------------------------------------

  describe('stop & resume', () => {
    it('stop() sets stopped to true', () => {
      const prisma = makePrisma(makeTx());
      const r = new OutboxRelay(prisma, clock, idSource, config);
      // Start it first
      r.resume();
      expect((r as unknown as { stopped: boolean }).stopped).toBe(false);

      r.stop();
      expect((r as unknown as { stopped: boolean }).stopped).toBe(true);
    });

    it('resume() sets stopped to false (no in-memory state restored)', async () => {
      const prisma = makePrisma(makeTx());
      const r = new OutboxRelay(prisma, clock, idSource, config);

      await r.resume();
      expect((r as unknown as { stopped: boolean }).stopped).toBe(false);
    });

    it('cycle after stop → resume works correctly', async () => {
      const row = makeOutboxRow();
      const expectedHolder = `${config.relayId}-id-0001`;
      const leaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: expectedHolder,
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
      });

      const tx = makeTx({
        taskOutboxEvent: {
          findMany: jest.fn().mockResolvedValue([row]),
        },
        outboxLease: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest
            .fn()
            .mockResolvedValueOnce({
              outboxEventId: 'evt-0001',
              leaseHolder: expectedHolder,
              deliveryOrdinal: 1,
              failureCount: 0,
              deliveryStatus: 'leased',
            })
            .mockResolvedValueOnce(leaseRow),
        },
        consumerInbox: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({}),
        },
        deliveryAttemptEvidence: {
          create: jest.fn().mockResolvedValue({}),
        },
      });
      const prisma = makePrisma(tx);
      const cycleRelay = new OutboxRelay(prisma, clock, idSource, config);

      // Stop → resume → cycle
      cycleRelay.stop();
      await cycleRelay.resume();

      const consumer = makeConsumer();
      const result = await cycleRelay.cycle(consumer);

      expect(result.delivered).toBe(1);
    });
  });

  // -- reconciliation --------------------------------------------------------

  describe('reconciliation', () => {
    it('returns full reconciliation snapshot', async () => {
      const tx = makeTx({
        outboxLease: {
          findMany: jest
            .fn()
            // Call 1: lease summary (select: { deliveryStatus: true })
            .mockResolvedValueOnce([
              { deliveryStatus: 'pending' },
              { deliveryStatus: 'leased' },
              { deliveryStatus: 'delivered' },
              { deliveryStatus: 'quarantined' },
            ])
            // Call 2: orphan events check (select: { outboxEventId: true })
            .mockResolvedValueOnce([
              { outboxEventId: 'e1' },
              { outboxEventId: 'e2' },
              { outboxEventId: 'e3' },
              { outboxEventId: 'e4' },
            ])
            // Call 3: stale leases (with where clause — no expired leases)
            .mockResolvedValueOnce([]),
        },
        quarantineEvidence: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'q-1',
              outbox_event_id: 'e4',
              delivery_ordinal: 1,
              failure_count: 3,
              last_error_code: 'Error',
              last_error_detail: null,
              quarantined_at: FIXED_NOW.toISOString(),
            },
          ]),
        },
        deliveryAttemptEvidence: {
          findMany: jest.fn().mockResolvedValue([
            { outboxEventId: 'e1' },
            { outboxEventId: 'e1' },
            { outboxEventId: 'e3' },
          ]),
        },
        consumerInbox: {
          findMany: jest.fn().mockResolvedValue([
            { consumerId: 'c1' },
            { consumerId: 'c1' },
            { consumerId: 'c2' },
          ]),
        },
        taskOutboxEvent: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'e1' }, { id: 'e2' }, { id: 'e3' }, { id: 'e4' },
          ]),
        },
      });
      const prisma = makePrisma(tx);
      const recRelay = new OutboxRelay(prisma, clock, idSource, config);

      const snapshot = await recRelay.reconciliation();

      expect(snapshot.leaseSummary).toEqual({
        pending: 1,
        leased: 1,
        delivered: 1,
        quarantined: 1,
      });
      expect(snapshot.quarantined).toHaveLength(1);
      expect(snapshot.quarantined[0].outboxEventId).toBe('e4');
      expect(snapshot.attemptCounts).toHaveLength(2); // e1 (2), e3 (1)
      expect(snapshot.inboxSummary).toEqual({ c1: 2, c2: 1 });
      expect(snapshot.orphanEvents).toHaveLength(0);
      expect(snapshot.staleLeases).toHaveLength(0);
    });

    it('detects orphan events (outbox rows with no lease)', async () => {
      const tx = makeTx({
        outboxLease: {
          findMany: jest
            .fn()
            // Call 1: lease summary
            .mockResolvedValueOnce([{ deliveryStatus: 'pending' }])
            // Call 2: orphan check — only e1 has a lease
            .mockResolvedValueOnce([{ outboxEventId: 'e1' }])
            // Call 3: stale leases
            .mockResolvedValueOnce([]),
        },
        quarantineEvidence: { findMany: jest.fn().mockResolvedValue([]) },
        deliveryAttemptEvidence: { findMany: jest.fn().mockResolvedValue([]) },
        consumerInbox: { findMany: jest.fn().mockResolvedValue([]) },
        taskOutboxEvent: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'e1' }, { id: 'e2' }, // e2 has no lease!
          ]),
        },
      });
      const prisma = makePrisma(tx);
      const recRelay = new OutboxRelay(prisma, clock, idSource, config);

      const snapshot = await recRelay.reconciliation();

      expect(snapshot.orphanEvents).toContain('e2');
    });

    it('detects stale leases (expired but status still leased)', async () => {
      const staleTime = FIXED_NOW_MINUS_90S;
      const tx = makeTx({
        outboxLease: {
          findMany: jest
            .fn()
            // Call 1: lease summary
            .mockResolvedValueOnce([{ deliveryStatus: 'leased' }])
            // Call 2: orphan check
            .mockResolvedValueOnce([{ outboxEventId: 'e1' }])
            // Call 3: stale leases — e1 is expired and still leased
            .mockResolvedValueOnce([
              { outboxEventId: 'e1', leaseExpiresAt: staleTime.toISOString() },
            ]),
        },
        quarantineEvidence: { findMany: jest.fn().mockResolvedValue([]) },
        deliveryAttemptEvidence: { findMany: jest.fn().mockResolvedValue([]) },
        consumerInbox: { findMany: jest.fn().mockResolvedValue([]) },
        taskOutboxEvent: {
          findMany: jest.fn().mockResolvedValue([{ id: 'e1' }]),
        },
      });
      const prisma = makePrisma(tx);
      const recRelay = new OutboxRelay(prisma, clock, idSource, config);

      const snapshot = await recRelay.reconciliation();

      expect(snapshot.staleLeases).toHaveLength(1);
      expect(snapshot.staleLeases[0].outboxEventId).toBe('e1');
    });
  });

  // -- reorder safety --------------------------------------------------------

  describe('reorder safety', () => {
    it('processes events in recordedAt order (FIFO)', async () => {
      const row1 = makeOutboxRow({ id: 'evt-0001', recorded_at: '2026-07-30T10:00:00Z' });
      const row2 = makeOutboxRow({ id: 'evt-0002', recorded_at: '2026-07-30T11:00:00Z' });

      const findMany = jest.fn().mockResolvedValue([row1, row2]);
      const tx = makeTx({ taskOutboxEvent: { findMany } });
      const prisma = makePrisma(tx);
      const pollRelay = new OutboxRelay(prisma, clock, idSource, config);

      await pollRelay.poll();

      const callArgs = findMany.mock.calls[0][0];
      expect(callArgs.orderBy).toEqual({ recordedAt: 'asc' });
    });

    it('inbox dedup prevents duplicate delivery regardless of poll order', async () => {
      // If two polls return the same event (e.g., after crash recovery),
      // the inbox dedup in dispatch prevents duplicate consumer invocation.
      const event = makeOutboxEvent();
      const leaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
      });

      const tx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue(leaseRow),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        consumerInbox: {
          // First time: no inbox row → create it
          // Second time: inbox row exists → dedup
          findUnique: jest
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
              consumerId: 'consumer-01',
              outboxEventId: 'evt-0001',
              side_effect_digest: 'sha256:abc123',
            }),
          create: jest.fn().mockResolvedValue({}),
        },
        deliveryAttemptEvidence: {
          create: jest.fn().mockResolvedValue({}),
        },
      });
      const prisma = makePrisma(tx);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);
      const consumer = makeConsumer();

      const fencedEvent = {
        ...event,
        _fence: { leaseHolder: 'holder-1', deliveryOrdinal: 1 } as LeaseFence,
      } as OutboxEvent & { _fence: LeaseFence };

      // First delivery — succeeds, consumer called, inbox row written
      const r1 = await dispatchRelay.dispatch(
        fencedEvent as unknown as OutboxEvent,
        consumer,
      );
      expect(r1).toBe('delivered');
      expect(consumer.consume).toHaveBeenCalledTimes(1);

      // Second delivery (reorder/duplicate) — dedup, consumer NOT called
      const r2 = await dispatchRelay.dispatch(
        fencedEvent as unknown as OutboxEvent,
        consumer,
      );
      expect(r2).toBe('delivered');
      expect(consumer.consume).toHaveBeenCalledTimes(1);
    });
  });

  // -- crash prefix ----------------------------------------------------------

  describe('crash prefix', () => {
    it('lease holder always contains the relayId as a crash-identification prefix', async () => {
      const events = [makeOutboxEvent()];
      const tx = makeTx({
        outboxLease: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue({
            outboxEventId: 'evt-0001',
            leaseHolder: `${config.relayId}-id-0001`,
            deliveryOrdinal: 1,
            failureCount: 0,
            deliveryStatus: 'leased',
          }),
        },
      });
      const prisma = makePrisma(tx);
      const leaseRelay = new OutboxRelay(prisma, clock, idSource, config);

      const leased = await leaseRelay.lease(events);
      expect(leased).toHaveLength(1);

      const cycleId = (leaseRelay as unknown as { cycleId: string | null }).cycleId;
      expect(cycleId).not.toBeNull();
      // Crash prefix: relayId must be the prefix
      expect(cycleId!.startsWith(config.relayId)).toBe(true);
    });

    it('different relayIds produce different lease holder prefixes', async () => {
      const configA = normaliseConfig({ relayId: 'relay-A', maxRetries: 3 });
      const configB = normaliseConfig({ relayId: 'relay-B', maxRetries: 3 });

      const events = [makeOutboxEvent()];
      const txA = makeTx({
        outboxLease: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue({
            outboxEventId: 'evt-0001',
            leaseHolder: 'relay-A-id-0001',
            deliveryOrdinal: 1,
            failureCount: 0,
            deliveryStatus: 'leased',
          }),
        },
      });
      const txB = makeTx({
        outboxLease: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue({
            outboxEventId: 'evt-0001',
            leaseHolder: 'relay-B-id-0001',
            deliveryOrdinal: 1,
            failureCount: 0,
            deliveryStatus: 'leased',
          }),
        },
      });

      const prismaA = makePrisma(txA);
      const prismaB = makePrisma(txB);

      const relayA = new OutboxRelay(prismaA, clock, idSource, configA);
      const relayB = new OutboxRelay(prismaB, clock, idSource, configB);

      await relayA.lease(events);
      await relayB.lease(events);

      const idA = (relayA as unknown as { cycleId: string | null }).cycleId;
      const idB = (relayB as unknown as { cycleId: string | null }).cycleId;

      expect(idA).toContain('relay-A');
      expect(idB).toContain('relay-B');
      expect(idA).not.toBe(idB);
    });
  });
});
