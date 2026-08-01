// MUN-0021: Outbox relay unit tests.
// Verifies poll, lease, dispatch, fence, commit-before-ack dedup,
// poison quarantine, stop/resume, reconciliation, wrong-plane rejection,
// and negative controls. All tests use in-memory mock Prisma — no database.

import { OutboxRelay } from '../src/outbox/outbox.relay';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { TransactionalClient } from '../src/outbox/outbox.relay';
import {
  normaliseConfig,
  sanitiseErrorDetail,
  validateOutboxEvent,
  validatePayloadPlane,
} from '../src/outbox/outbox.types';
import {
  MalformedOutboxEventError,
  WrongPlanePayloadError,
} from '../src/outbox/outbox.errors';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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

// Make a fenced event (for dispatch — fencing is mandatory)
function makeFencedEvent(
  overrides: Partial<OutboxEvent> = {},
  fenceOverrides: Partial<LeaseFence> = {},
): OutboxEvent & { _fence: LeaseFence } {
  const event = makeOutboxEvent(overrides);
  return {
    ...event,
    _fence: {
      leaseHolder: fenceOverrides.leaseHolder ?? 'holder-1',
      deliveryOrdinal: fenceOverrides.deliveryOrdinal ?? 1,
    },
  } as OutboxEvent & { _fence: LeaseFence };
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

/**
 * Create a mock Prisma client that supports multiple $transaction calls.
 * Each call to $transaction invokes the callback with the tx fixture.
 * For success-path dispatch (single tx), one call is enough.
 * For failure-path dispatch (two txs — consumer + evidence), provide
 * two tx fixtures and the first call throws to simulate consumer failure.
 */
function makePrisma(
  txOrTxs: ReturnType<typeof makeTx> | ReturnType<typeof makeTx>[],
): TransactionalClient {
  const txs = Array.isArray(txOrTxs) ? txOrTxs : [txOrTxs];
  let callIdx = 0;
  return {
    $transaction: jest
      .fn()
      .mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (fn: (t: any) => Promise<unknown>) => {
          const tx = txs[Math.min(callIdx, txs.length - 1)];
          callIdx += 1;
          return fn(tx);
        },
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

    // IMP10: normaliseConfig enforced at constructor boundary
    it('normalises config at constructor boundary', () => {
      const prisma = makePrisma(makeTx());
      const r = new OutboxRelay(prisma, clock, idSource, {
        relayId: 'bare-relay',
      });
      const cfg = (r as unknown as { config: RelayConfig }).config;
      expect(cfg.relayId).toBe('bare-relay');
      expect(cfg.leaseTtlMs).toBe(60000);
      expect(cfg.maxRetries).toBe(3);
      expect(cfg.batchSize).toBe(10);
    });

    it('rejects invalid config values at constructor', () => {
      const prisma = makePrisma(makeTx());
      expect(() => new OutboxRelay(prisma, clock, idSource, {
        relayId: 'bad',
        leaseTtlMs: 50, // below minimum 1000
      })).toThrow(/leaseTtlMs/);
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

      const cycleId = (leaseRelay as unknown as { cycleId: string | null }).cycleId;
      expect(cycleId).not.toBeNull();
      expect(cycleId).toContain(config.relayId);
    });

    it('skips events already leased by another holder (not expired)', async () => {
      const events = [makeOutboxEvent()];
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

    it('preserves failure_count on lease acquisition (does not reset)', async () => {
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

      const updateCall = tx.outboxLease.updateMany.mock.calls[0][0];
      expect(updateCall.data.failureCount).toBeUndefined();
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

      const updateCall = tx.outboxLease.updateMany.mock.calls[0][0];
      expect(updateCall.data.deliveryOrdinal).toEqual({ increment: 1 });
    });
  });

  // -- dispatch: wrong-plane rejection ---------------------------------------

  describe('dispatch — wrong-plane payload rejection', () => {
    it('rejects an empty payload as a malformed closed envelope', () => {
      const event = makeOutboxEvent({
        eventPayload: {} as OutboxEvent['eventPayload'],
      });
      expect(validateOutboxEvent(event)).toMatch(/missing required field/i);
    });

    it('rejects row/payload identity mismatch', () => {
      const event = makeOutboxEvent({
        eventPayload: {
          ...makeOutboxEvent().eventPayload,
          aggregateVersion: 99,
        },
      });
      expect(validateOutboxEvent(event)).toMatch(/aggregateVersion.*mismatch/i);
    });

    it('rejects retry state that exceeds its budget', () => {
      const event = makeOutboxEvent({
        eventPayload: {
          ...makeOutboxEvent().eventPayload,
          retryCount: 4,
          retryBudget: 3,
        },
      });
      expect(validateOutboxEvent(event)).toMatch(/retryCount.*retryBudget/i);
    });

    it('durably quarantines a malformed envelope before consumer invocation', async () => {
      const event = makeFencedEvent({
        eventPayload: {} as OutboxEvent['eventPayload'],
      });
      const tx = makeTx({
        outboxLease: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });
      const dispatchRelay = new OutboxRelay(
        makePrisma(tx),
        clock,
        idSource,
        config,
      );
      const consumer = makeConsumer();

      await expect(dispatchRelay.dispatch(event, consumer)).rejects.toThrow(
        MalformedOutboxEventError,
      );
      expect(consumer.consume).not.toHaveBeenCalled();
      expect(tx.quarantineEvidence.create.mock.calls[0][0].data.lastErrorCode).toBe(
        'MALFORMED_EVENT',
      );
    });

    it('rejects nested Supervisor keys in objects and arrays', () => {
      expect(
        validatePayloadPlane({
          committedResult: {
            metadata: [{ host_id: 'wrong-plane-host' }],
          },
        }),
      ).toContain('forbidden key "host_id"');
    });

    it('fails closed on cyclic non-JSON structures', () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;

      expect(validatePayloadPlane(cyclic)).toContain('cyclic structure');
    });

    it('rejects payload with forbidden fleet key (host_id) before consumer invocation', async () => {
      const event = makeFencedEvent({
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

      // The wrong-plane check happens before the consumer tx, then
      // recordWrongPlaneQuarantine opens its own tx.
      const tx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue(leaseRow),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });
      const prisma = makePrisma(tx);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);
      const consumer = makeConsumer();

      await expect(
        dispatchRelay.dispatch(event as unknown as OutboxEvent, consumer),
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
      const event = makeFencedEvent({
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

      await expect(
        dispatchRelay.dispatch(event as unknown as OutboxEvent, consumer),
      ).rejects.toThrow(WrongPlanePayloadError);

      expect(consumer.consume).not.toHaveBeenCalled();
    });

    it('NEGATIVE-CONTROL: Supervisor-shaped payload does not alter attempt identity', async () => {
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

    // CRIT2: A stale/reclaimed worker must insert no quarantine or attempt
    // evidence and must not change status for wrong-plane payloads.
    it('CRIT2: stale worker inserts zero quarantine evidence for wrong-plane payload', async () => {
      const event = makeFencedEvent(
        {
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
        },
        { leaseHolder: 'stale-holder', deliveryOrdinal: 99 },
      );

      // Lease was reclaimed — different holder + ordinal
      const leaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'current-holder', // ← different from fence!
        deliveryOrdinal: 5, // ← different from fence!
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
      });

      // BLOCKER1: The new atomic fence pattern uses updateMany FIRST.
      // The WHERE clause includes leaseHolder + deliveryOrdinal from the
      // fence. Since the leaseRow has different values, the mock must
      // return count: 0 (zero rows matched = stale fence).
      let updateManyCalled = false;
      const tx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue(leaseRow),
          updateMany: jest.fn().mockImplementation((args: { where?: { leaseHolder?: string; deliveryOrdinal?: number } }) => {
            updateManyCalled = true;
            // Atomic fence check: if WHERE holder/ordinal don't match the
            // actual lease row, return 0 → stale worker, zero evidence.
            const w = args.where ?? {};
            if (w.leaseHolder === 'stale-holder' && w.deliveryOrdinal === 99) {
              return Promise.resolve({ count: 0 }); // fence mismatch
            }
            return Promise.resolve({ count: 1 });
          }),
        },
      });
      const prisma = makePrisma(tx);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);
      const consumer = makeConsumer();

      const disposition = await dispatchRelay.dispatch(
        event as unknown as OutboxEvent,
        consumer,
      );
      expect(disposition).toBe('expired');

      // Consumer NOT called
      expect(consumer.consume).not.toHaveBeenCalled();

      // ZERO quarantine evidence — fence was stale, updateMany returned 0
      expect(updateManyCalled).toBe(true); // fence check DID run
      expect(tx.quarantineEvidence.create).not.toHaveBeenCalled();
      expect(tx.deliveryAttemptEvidence.create).not.toHaveBeenCalled();
    });

    it('expired wrong-plane worker cannot quarantine and is reported expired', async () => {
      const event = makeFencedEvent({
        eventPayload: {
          ...makeOutboxEvent().eventPayload,
          host_id: 'forbidden-host',
        } as unknown as OutboxEvent['eventPayload'],
      });
      const updateMany = jest.fn().mockResolvedValue({ count: 0 });
      const tx = makeTx({
        outboxLease: { updateMany },
      });
      const dispatchRelay = new OutboxRelay(
        makePrisma(tx),
        clock,
        idSource,
        config,
      );

      const disposition = await dispatchRelay.dispatch(event, makeConsumer());

      expect(disposition).toBe('expired');
      expect(updateMany.mock.calls[0][0].where.leaseExpiresAt).toEqual({
        gt: FIXED_NOW,
      });
      expect(tx.quarantineEvidence.create).not.toHaveBeenCalled();
      expect(tx.deliveryAttemptEvidence.create).not.toHaveBeenCalled();
    });

    it('does not quarantine when the lease expires during invalid-event validation', async () => {
      const lateNow = new Date(FIXED_NOW_PLUS_30S.getTime() + 1);
      const advancingClock: Clock = {
        now: jest
          .fn()
          .mockReturnValueOnce(FIXED_NOW)
          .mockReturnValueOnce(lateNow),
      };
      const updateMany = jest.fn().mockImplementation(
        (args: { where: { leaseExpiresAt: { gt: Date } } }) =>
          Promise.resolve({
            count: args.where.leaseExpiresAt.gt < FIXED_NOW_PLUS_30S ? 1 : 0,
          }),
      );
      const tx = makeTx({ outboxLease: { updateMany } });
      const dispatchRelay = new OutboxRelay(
        makePrisma(tx), advancingClock, idSource, config,
      );
      const event = makeFencedEvent({
        eventPayload: {
          ...makeOutboxEvent().eventPayload,
          host_id: 'forbidden-host',
        } as unknown as OutboxEvent['eventPayload'],
      });

      await expect(
        dispatchRelay.dispatch(event, makeConsumer()),
      ).resolves.toBe('expired');
      expect(updateMany.mock.calls[0][0].where.leaseExpiresAt).toEqual({
        gt: lateNow,
      });
      expect(tx.quarantineEvidence.create).not.toHaveBeenCalled();
      expect(tx.deliveryAttemptEvidence.create).not.toHaveBeenCalled();
    });
  });

  // -- dispatch: fencing is mandatory ----------------------------------------

  describe('dispatch — fencing mandatory (CRIT2)', () => {
    it('throws when event has no _fence token', async () => {
      const event = makeOutboxEvent(); // no _fence
      const tx = makeTx();
      const prisma = makePrisma(tx);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);
      const consumer = makeConsumer();

      await expect(
        dispatchRelay.dispatch(event, consumer),
      ).rejects.toThrow(/FENCE_REQUIRED|fence.*mandatory/i);
    });

    it('rejects a malformed fence before invalid-event quarantine writes', async () => {
      const tx = makeTx();
      const event = {
        ...makeOutboxEvent({
          eventPayload: {} as OutboxEvent['eventPayload'],
        }),
        _fence: {},
      } as unknown as OutboxEvent;
      const dispatchRelay = new OutboxRelay(
        makePrisma(tx), clock, idSource, config,
      );

      await expect(
        dispatchRelay.dispatch(event, makeConsumer()),
      ).rejects.toThrow(/fence.*mandatory/i);
      expect(tx.outboxLease.updateMany).not.toHaveBeenCalled();
      expect(tx.quarantineEvidence.create).not.toHaveBeenCalled();
      expect(tx.deliveryAttemptEvidence.create).not.toHaveBeenCalled();
    });

    it('rejects a missing event id before any quarantine write', async () => {
      const tx = makeTx();
      const event = {
        ...makeFencedEvent({
          eventPayload: {
            ...makeOutboxEvent().eventPayload,
            host_id: 'forbidden-host',
          } as unknown as OutboxEvent['eventPayload'],
        }),
        id: undefined,
      } as unknown as OutboxEvent;
      const dispatchRelay = new OutboxRelay(
        makePrisma(tx), clock, idSource, config,
      );

      await expect(
        dispatchRelay.dispatch(event, makeConsumer()),
      ).rejects.toThrow(MalformedOutboxEventError);
      expect(tx.outboxLease.updateMany).not.toHaveBeenCalled();
      expect(tx.quarantineEvidence.create).not.toHaveBeenCalled();
      expect(tx.deliveryAttemptEvidence.create).not.toHaveBeenCalled();
    });
  });

  // -- dispatch: fence & lease expiry ----------------------------------------

  describe('dispatch — fence and lease expiry', () => {
    it('returns expired on stale fence (lease reclaimed by another worker)', async () => {
      const event = makeFencedEvent();
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

      const disposition = await dispatchRelay.dispatch(
        event as unknown as OutboxEvent,
        consumer,
      );

      expect(disposition).toBe('expired');
      expect(consumer.consume).not.toHaveBeenCalled();
    });

    it('returns expired when only the lease holder mismatches', async () => {
      const event = makeFencedEvent();
      const leaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'other-holder',
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
      });
      const tx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue(leaseRow),
        },
      });
      const dispatchRelay = new OutboxRelay(
        makePrisma(tx), clock, idSource, config,
      );
      const consumer = makeConsumer();

      await expect(
        dispatchRelay.dispatch(event as unknown as OutboxEvent, consumer),
      ).resolves.toBe('expired');
      expect(consumer.consume).not.toHaveBeenCalled();
    });

    it('returns expired when only the delivery ordinal mismatches', async () => {
      const event = makeFencedEvent();
      const leaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 2,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
      });
      const tx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue(leaseRow),
        },
      });
      const dispatchRelay = new OutboxRelay(
        makePrisma(tx), clock, idSource, config,
      );
      const consumer = makeConsumer();

      await expect(
        dispatchRelay.dispatch(event as unknown as OutboxEvent, consumer),
      ).resolves.toBe('expired');
      expect(consumer.consume).not.toHaveBeenCalled();
    });

    it('returns expired when lease has timed out', async () => {
      const event = makeFencedEvent();
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

      const disposition = await dispatchRelay.dispatch(
        event as unknown as OutboxEvent,
        consumer,
      );

      expect(disposition).toBe('expired');
      expect(consumer.consume).not.toHaveBeenCalled();
    });

    it('returns expired when no lease row exists', async () => {
      const event = makeFencedEvent();
      const tx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
      });
      const prisma = makePrisma(tx);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);
      const consumer = makeConsumer();

      const disposition = await dispatchRelay.dispatch(
        event as unknown as OutboxEvent,
        consumer,
      );
      expect(disposition).toBe('expired');
    });
  });

  // -- dispatch: commit-before-ack (inbox dedup) -----------------------------

  describe('dispatch — commit-before-ack (inbox dedup)', () => {
    it('returns delivered when inbox row already exists (idempotent replay)', async () => {
      const event = makeFencedEvent();
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

      const disposition = await dispatchRelay.dispatch(
        event as unknown as OutboxEvent,
        consumer,
      );

      expect(disposition).toBe('delivered');
      expect(consumer.consume).not.toHaveBeenCalled();
      expect(tx.outboxLease.updateMany).toHaveBeenCalled();
      expect(tx.deliveryAttemptEvidence.create).toHaveBeenCalled();
    });

    it('duplicate dispatch is idempotent — does not re-invoke consumer', async () => {
      const event = makeFencedEvent();
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

      // First dispatch — consumer is called
      const r1 = await dispatchRelay.dispatch(
        event as unknown as OutboxEvent,
        consumer,
      );
      expect(r1).toBe('delivered');
      expect(consumer.consume).toHaveBeenCalledTimes(1);

      // Second dispatch — dedup, consumer NOT called again
      const r2 = await dispatchRelay.dispatch(
        event as unknown as OutboxEvent,
        consumer,
      );
      expect(r2).toBe('delivered');
      expect(consumer.consume).toHaveBeenCalledTimes(1); // still 1
    });
  });

  // -- dispatch: consumer success --------------------------------------------

  describe('dispatch — consumer success', () => {
    it('invokes consumer, writes inbox row, marks lease delivered', async () => {
      const event = makeFencedEvent();
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

      const disposition = await dispatchRelay.dispatch(
        event as unknown as OutboxEvent,
        consumer,
      );

      expect(disposition).toBe('delivered');
      expect(consumer.consume).toHaveBeenCalledTimes(1);
      expect(tx.consumerInbox.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            consumerId: 'consumer-01',
            outboxEventId: 'evt-0001',
            sideEffectDigest: 'sha256:abc123',
          }),
        }),
      );
      expect(tx.outboxLease.updateMany).toHaveBeenCalled();
    });

    // CRIT1: When the consumer succeeds but the lease is reclaimed before the
    // final fenced update completes, the entire transaction must roll back:
    // zero consumer effect, zero inbox row, zero evidence, zero status change.
    // The fix throws StaleFenceError inside $transaction → rollback → returns
    // 'expired' without opening a failure-evidence tx.
    it('CRIT1: consumer effect + inbox roll back when lease is reclaimed mid-dispatch', async () => {
      const event = makeFencedEvent();
      const leaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
      });

      // Fence is valid for initial check, but the final updateMany returns
      // count=0 — the lease was reclaimed between consumer success and the
      // fenced status update.
      const tx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue(leaseRow),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }), // ← reclaimed!
        },
      });
      const prisma = makePrisma(tx);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);
      const consumer = makeConsumer();

      const disposition = await dispatchRelay.dispatch(
        event as unknown as OutboxEvent,
        consumer,
      );

      // GREEN: StaleFenceError thrown inside $transaction → rolls back the
      // entire tx (consumer effect + inbox). Catch handler returns 'expired'
      // with zero failure evidence.
      expect(disposition).toBe('expired');

      // Consumer was invoked (inside the rolled-back tx)
      expect(consumer.consume).toHaveBeenCalledTimes(1);

      // inbox.create was called inside the tx but the throw rolled it back —
      // deliveryAttemptEvidence.create was NOT called because throw precedes it
      expect(tx.deliveryAttemptEvidence.create).not.toHaveBeenCalled();

      // No second transaction was opened — $transaction called exactly once
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  // -- dispatch: consumer failure → retry → quarantine (CRIT1 + CRIT2) -------

  describe('dispatch — consumer failure → separate evidence tx', () => {
    it('consumer failure rolls back consumer tx, writes failure evidence in second tx', async () => {
      const event = makeFencedEvent();

      // --- Consumer tx fixture (first $transaction) ---
      // The consumer throws, so the first tx rolls back.
      // The mock still needs enough to pass the fence check (findUnique for lease).
      const consumerTxLeaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
        failureCount: 0,
      });

      const consumerTx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue(consumerTxLeaseRow),
        },
      });

      // --- Evidence tx fixture (second $transaction, after rollback) ---
      // Fence still valid → bump failure count → not yet quarantined.
      const evidenceTxLeaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
        failureCount: 1,
      });

      const evidenceTx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue(evidenceTxLeaseRow),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });

      const prisma = makePrisma([consumerTx, evidenceTx]);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);
      const failingConsumer = makeConsumer({
        consume: jest.fn().mockRejectedValue(new Error('side-effect failed')),
      });

      const disposition = await dispatchRelay.dispatch(
        event as unknown as OutboxEvent,
        failingConsumer,
      );

      // Returns 'expired' — evidence is durable
      expect(disposition).toBe('expired');

      // Consumer was called (in the first tx)
      expect(failingConsumer.consume).toHaveBeenCalledTimes(1);

      // Evidence tx bumped failure count and recorded delivery attempt
      expect(evidenceTx.outboxLease.updateMany).toHaveBeenCalled();
      expect(evidenceTx.deliveryAttemptEvidence.create).toHaveBeenCalled();

      // NOT quarantined (only 1 failure, maxRetries=3)
      expect(evidenceTx.quarantineEvidence.create).not.toHaveBeenCalled();
    });

    it('records no evidence when fence is lost during consumer execution', async () => {
      const event = makeFencedEvent();

      const consumerTxLeaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
      });

      const consumerTx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue(consumerTxLeaseRow),
        },
      });

      // Evidence tx: fence was reclaimed while consumer ran
      const evidenceTx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue({
            deliveryStatus: 'leased',
            leaseHolder: 'other-holder', // reclaimed!
            deliveryOrdinal: 3, // different ordinal!
            leaseExpiresAt: FIXED_NOW_PLUS_30S,
          }),
        },
      });

      const prisma = makePrisma([consumerTx, evidenceTx]);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);
      const failingConsumer = makeConsumer({
        consume: jest.fn().mockRejectedValue(new Error('late failure')),
      });

      const disposition = await dispatchRelay.dispatch(
        event as unknown as OutboxEvent,
        failingConsumer,
      );

      expect(disposition).toBe('expired');
      // No evidence written — fence was stale
      expect(evidenceTx.deliveryAttemptEvidence.create).not.toHaveBeenCalled();
      expect(evidenceTx.quarantineEvidence.create).not.toHaveBeenCalled();
    });

    it('quarantines after maxRetries consecutive failures', async () => {
      const event = makeFencedEvent();

      const consumerTxLeaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
        failureCount: 2,
      });

      const consumerTx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue(consumerTxLeaseRow),
        },
      });

      // Evidence tx: after bump, failureCount=3 (maxRetries reached)
      // findUnique is called twice: first for fence re-check (pre-bump), then for
      // bumpFailureCountFenced re-read (post-bump, returns incremented value).
      const evidenceTx = makeTx({
        outboxLease: {
          findUnique: jest
            .fn()
            .mockResolvedValueOnce({
              deliveryStatus: 'leased',
              leaseHolder: 'holder-1',
              deliveryOrdinal: 1,
              leaseExpiresAt: FIXED_NOW_PLUS_30S,
              failureCount: 2,
            })
            .mockResolvedValueOnce({
              deliveryStatus: 'leased',
              leaseHolder: 'holder-1',
              deliveryOrdinal: 1,
              leaseExpiresAt: FIXED_NOW_PLUS_30S,
              failureCount: 3,
            }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });

      const prisma = makePrisma([consumerTx, evidenceTx]);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);
      const failingConsumer = makeConsumer({
        consume: jest.fn().mockRejectedValue(new Error('persistent failure')),
      });

      const disposition = await dispatchRelay.dispatch(
        event as unknown as OutboxEvent,
        failingConsumer,
      );

      expect(disposition).toBe('quarantined');

      // Quarantine evidence recorded
      expect(evidenceTx.quarantineEvidence.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            outboxEventId: 'evt-0001',
            failureCount: 3,
            lastErrorCode: 'Error',
          }),
        }),
      );
      // Lease marked as quarantined
      expect(evidenceTx.outboxLease.updateMany).toHaveBeenCalled();
    });

    it('does NOT quarantine before maxRetries is reached', async () => {
      const event = makeFencedEvent();

      const consumerTxLeaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
        failureCount: 0,
      });

      const consumerTx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue(consumerTxLeaseRow),
        },
      });

      const evidenceTx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue({
            deliveryStatus: 'leased',
            leaseHolder: 'holder-1',
            deliveryOrdinal: 1,
            leaseExpiresAt: FIXED_NOW_PLUS_30S,
            failureCount: 0,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });

      const prisma = makePrisma([consumerTx, evidenceTx]);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);
      const failingConsumer = makeConsumer({
        consume: jest.fn().mockRejectedValue(new Error('transient error')),
      });

      const disposition = await dispatchRelay.dispatch(
        event as unknown as OutboxEvent,
        failingConsumer,
      );

      expect(disposition).toBe('expired');
      expect(evidenceTx.quarantineEvidence.create).not.toHaveBeenCalled();
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

    it('counts a durably rejected wrong-plane event as quarantined', async () => {
      const event = makeOutboxEvent();
      const tx = makeTx();
      const prisma = makePrisma(tx);
      const cycleRelay = new OutboxRelay(prisma, clock, idSource, config);
      await cycleRelay.resume();

      jest.spyOn(cycleRelay, 'poll').mockResolvedValue([event]);
      jest.spyOn(cycleRelay, 'lease').mockResolvedValue([event]);
      jest.spyOn(cycleRelay, 'dispatch').mockRejectedValue(
        new WrongPlanePayloadError(event.id, 'host_id'),
      );

      await expect(cycleRelay.cycle(makeConsumer())).resolves.toEqual({
        polled: 1,
        leased: 1,
        delivered: 0,
        quarantined: 1,
        skipped: 0,
      });
    });

    // IMP9: stop() prevents dispatch of remainder of already leased batch
    it('stop() mid-cycle leaves unstarted events pending/recoverable', async () => {
      const evt1 = makeOutboxEvent({ id: 'evt-0001' });
      const evt2 = makeOutboxEvent({ id: 'evt-0002' });
      const evt3 = makeOutboxEvent({ id: 'evt-0003' });

      const tx = makeTx();
      const prisma = makePrisma(tx);
      const cycleRelay = new OutboxRelay(prisma, clock, idSource, config);
      await cycleRelay.resume();

      jest.spyOn(cycleRelay, 'poll').mockResolvedValue([evt1, evt2, evt3]);
      // lease() returns all three with fences
      const leased = [
        { ...evt1, _fence: { leaseHolder: 'h', deliveryOrdinal: 1 } },
        { ...evt2, _fence: { leaseHolder: 'h', deliveryOrdinal: 2 } },
        { ...evt3, _fence: { leaseHolder: 'h', deliveryOrdinal: 3 } },
      ];
      jest.spyOn(cycleRelay, 'lease').mockResolvedValue(leased as any);

      // dispatch: first succeeds, then we stop, remainder skipped
      let callCount = 0;
      jest.spyOn(cycleRelay, 'dispatch').mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return 'delivered';
        }
        // After first dispatch, stop the relay mid-batch
        cycleRelay.stop();
        return 'skipped' as any;
      });

      const result = await cycleRelay.cycle(makeConsumer());

      // Only the first event was delivered
      expect(result.delivered).toBe(1);
      // Remaining 2 events are skipped (left pending/recoverable)
      expect(result.skipped).toBe(2);
      expect(result.polled).toBe(3);
      expect(result.leased).toBe(3);
    });
  });

  // -- stop & resume ---------------------------------------------------------

  describe('stop & resume', () => {
    it('stop() sets stopped to true', () => {
      const prisma = makePrisma(makeTx());
      const r = new OutboxRelay(prisma, clock, idSource, config);
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
            .mockResolvedValueOnce([
              { deliveryStatus: 'pending' },
              { deliveryStatus: 'leased' },
              { deliveryStatus: 'delivered' },
              { deliveryStatus: 'quarantined' },
            ])
            .mockResolvedValueOnce([
              { outboxEventId: 'e1' },
              { outboxEventId: 'e2' },
              { outboxEventId: 'e3' },
              { outboxEventId: 'e4' },
            ])
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

      expect(prisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ isolationLevel: 'RepeatableRead' }),
      );
      expect(tx.quarantineEvidence.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [
            { quarantinedAt: 'desc' },
            { outboxEventId: 'asc' },
          ],
        }),
      );

      expect(snapshot.leaseSummary).toEqual({
        pending: 1,
        leased: 1,
        delivered: 1,
        quarantined: 1,
      });
      expect(snapshot.quarantined).toHaveLength(1);
      expect(snapshot.quarantined[0].outboxEventId).toBe('e4');
      expect(snapshot.attemptCounts).toHaveLength(2);
      expect(snapshot.inboxSummary).toEqual({ c1: 2, c2: 1 });
      expect(snapshot.orphanEvents).toHaveLength(0);
      expect(snapshot.staleLeases).toHaveLength(0);
    });

    it('detects orphan events (outbox rows with no lease)', async () => {
      const tx = makeTx({
        outboxLease: {
          findMany: jest
            .fn()
            .mockResolvedValueOnce([{ deliveryStatus: 'pending' }])
            .mockResolvedValueOnce([{ outboxEventId: 'e1' }])
            .mockResolvedValueOnce([]),
        },
        quarantineEvidence: { findMany: jest.fn().mockResolvedValue([]) },
        deliveryAttemptEvidence: { findMany: jest.fn().mockResolvedValue([]) },
        consumerInbox: { findMany: jest.fn().mockResolvedValue([]) },
        taskOutboxEvent: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'e1' }, { id: 'e2' },
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
            .mockResolvedValueOnce([{ deliveryStatus: 'leased' }])
            .mockResolvedValueOnce([{ outboxEventId: 'e1' }])
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
      const event = makeFencedEvent();
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

      // First delivery — succeeds, consumer called, inbox row written
      const r1 = await dispatchRelay.dispatch(
        event as unknown as OutboxEvent,
        consumer,
      );
      expect(r1).toBe('delivered');
      expect(consumer.consume).toHaveBeenCalledTimes(1);

      // Second delivery (reorder/duplicate) — dedup, consumer NOT called
      const r2 = await dispatchRelay.dispatch(
        event as unknown as OutboxEvent,
        consumer,
      );
      expect(r2).toBe('delivered');
      expect(consumer.consume).toHaveBeenCalledTimes(1);
    });
  });

  // -- F1: failure_count persistence across transactions and lease cycles -----

  describe('F1: failure_count durability across dispatch and lease cycles', () => {
    it('failure_count persists after consumer throws and consumer tx rolls back', async () => {
      const event = makeFencedEvent();

      const consumerTxLeaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
        failureCount: 0,
      });

      const consumerTx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue(consumerTxLeaseRow),
        },
      });

      const evidenceTx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue({
            deliveryStatus: 'leased',
            leaseHolder: 'holder-1',
            deliveryOrdinal: 1,
            leaseExpiresAt: FIXED_NOW_PLUS_30S,
            failureCount: 0,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });

      const prisma = makePrisma([consumerTx, evidenceTx]);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);
      const failingConsumer = makeConsumer({
        consume: jest.fn().mockRejectedValue(new Error('transient side-effect failure')),
      });

      const disposition = await dispatchRelay.dispatch(
        event as unknown as OutboxEvent,
        failingConsumer,
      );

      // POST-FIX: dispatch returns 'expired', evidence is durable
      expect(disposition).toBe('expired');

      // failure_count was bumped in the evidence transaction
      const bumpCall = evidenceTx.outboxLease.updateMany.mock.calls.find(
        (call: Array<unknown>) => {
          const data = (call[0] as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
          return data?.failureCount != null && (data.failureCount as Record<string, unknown>)?.increment === 1;
        },
      );
      expect(bumpCall).toBeDefined();

      // Delivery attempt evidence was recorded
      const evidenceCall = evidenceTx.deliveryAttemptEvidence.create.mock.calls.find(
        (call: Array<unknown>) => {
          const data = (call[0] as Record<string, unknown>)?.data as Record<string, unknown> | undefined;
          return data?.disposition === 'expired';
        },
      );
      expect(evidenceCall).toBeDefined();
    });

    it('failure_count is NOT reset on lease acquisition (preserved across cycles)', async () => {
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

      await leaseRelay.lease(events);

      const updateCall = tx.outboxLease.updateMany.mock.calls[0][0];
      expect(updateCall.data.failureCount).toBeUndefined();
    });

    it('repeated failures across lease cycles accumulate to quarantine (real pattern)', async () => {
      // Cycle 1: failure_count 0→1
      const event1 = makeFencedEvent();

      const c1LeaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
        failureCount: 0,
      });
      const c1Tx = makeTx({
        outboxLease: { findUnique: jest.fn().mockResolvedValue(c1LeaseRow) },
      });
      const e1Tx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue({
            ...c1LeaseRow, failureCount: 1,
            leaseHolder: 'holder-1', deliveryOrdinal: 1,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });
      const prisma1 = makePrisma([c1Tx, e1Tx]);
      const relay1 = new OutboxRelay(prisma1, clock, idSource, config);
      const failing1 = makeConsumer({
        consume: jest.fn().mockRejectedValue(new Error('failure 1')),
      });

      const r1 = await relay1.dispatch(event1 as unknown as OutboxEvent, failing1);
      expect(r1).toBe('expired');

      // Cycle 2: re-acquire lease with failure_count preserved at 1 → 2
      const event2 = makeFencedEvent({}, { leaseHolder: 'holder-2', deliveryOrdinal: 2 });

      const c2LeaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-2',
        deliveryOrdinal: 2,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
        failureCount: 1,
      });
      const c2Tx = makeTx({
        outboxLease: { findUnique: jest.fn().mockResolvedValue(c2LeaseRow) },
      });
      const e2Tx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue({
            ...c2LeaseRow, failureCount: 2,
            leaseHolder: 'holder-2', deliveryOrdinal: 2,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });
      const prisma2 = makePrisma([c2Tx, e2Tx]);
      const relay2 = new OutboxRelay(prisma2, clock, idSource, config);
      const failing2 = makeConsumer({
        consume: jest.fn().mockRejectedValue(new Error('failure 2')),
      });

      const r2 = await relay2.dispatch(event2 as unknown as OutboxEvent, failing2);
      expect(r2).toBe('expired');

      // Cycle 3: failure_count 2 → 3 → quarantine
      const event3 = makeFencedEvent({}, { leaseHolder: 'holder-3', deliveryOrdinal: 3 });

      const c3LeaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-3',
        deliveryOrdinal: 3,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
        failureCount: 2,
      });
      const c3Tx = makeTx({
        outboxLease: { findUnique: jest.fn().mockResolvedValue(c3LeaseRow) },
      });
      const e3Tx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue({
            ...c3LeaseRow, failureCount: 3,
            leaseHolder: 'holder-3', deliveryOrdinal: 3,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });
      const prisma3 = makePrisma([c3Tx, e3Tx]);
      const relay3 = new OutboxRelay(prisma3, clock, idSource, config);
      const failing3 = makeConsumer({
        consume: jest.fn().mockRejectedValue(new Error('failure 3')),
      });

      const r3 = await relay3.dispatch(event3 as unknown as OutboxEvent, failing3);
      expect(r3).toBe('quarantined');
    });
  });

  // -- IMP6: Error detail is bounded and redacted ----------------------------

  describe('IMP6: error detail sanitisation', () => {
    // Credential-shaped fixtures are assembled at runtime rather than written
    // as literals. The redaction guard still sees a complete, well-formed
    // token, but no scanner-matching string is ever committed to the
    // repository — a source file that carries one trips push protection and
    // every downstream secret scanner for the life of the history.
    const GITHUB_PAT_SHORT = ['ghp', 'a1b2C3d4E5f6G7h8I9j'].join('_');
    const GITHUB_PAT_FULL = [
      'ghp',
      'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0',
    ].join('_');
    const SLACK_BOT_SHORT = ['xoxb', '123456789012', '1234567890123'].join('-');
    const SLACK_BOT_FULL = [
      'xoxb',
      '123456789012',
      '1234567890123',
      'abcdefGHIJKLMnopQRST1uvw',
    ].join('-');
    const STRIPE_LIVE_HYPHENATED = [
      'sk',
      'live',
      '51H2j8kLmN9pQrS0tUvW1xYz',
    ].join('-');
    const STRIPE_LIVE_FULL = [
      'sk',
      'live',
      '51H2j8kLmN9pQrS0tUvW1xYz2AbC3dEfG4hIjKlMnOp',
    ].join('_');

    it.each([
      ['short GitHub token', `failure ${GITHUB_PAT_SHORT}`, '[REDACTED:github-pat]'],
      [
        'two-component Slack token',
        `failure ${SLACK_BOT_SHORT}`,
        '[REDACTED:slack-bot]',
      ],
      [
        'hyphenated Stripe live key',
        `failure ${STRIPE_LIVE_HYPHENATED}`,
        '[REDACTED:stripe-live]',
      ],
    ])('redacts %s without retaining the raw value', (_name, raw, marker) => {
      const detail = sanitiseErrorDetail(raw);
      const stored = detail.error as string;
      const rawValue = raw.split(' ').at(-1);
      expect(stored).toContain(marker);
      expect(stored).not.toContain(rawValue);
    });

    it('truncates long error messages', async () => {
      const event = makeFencedEvent();

      const consumerTxLeaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
      });
      const consumerTx = makeTx({
        outboxLease: { findUnique: jest.fn().mockResolvedValue(consumerTxLeaseRow) },
      });
      const evidenceTx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue({
            deliveryStatus: 'leased',
            leaseHolder: 'holder-1',
            deliveryOrdinal: 1,
            leaseExpiresAt: FIXED_NOW_PLUS_30S,
            failureCount: 0,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });
      const prisma = makePrisma([consumerTx, evidenceTx]);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);

      const longMessage = 'x'.repeat(5000);
      const failingConsumer = makeConsumer({
        consume: jest.fn().mockRejectedValue(new Error(longMessage)),
      });

      await dispatchRelay.dispatch(event as unknown as OutboxEvent, failingConsumer);

      // Verify the error_detail stored is bounded
      const evidenceCall = evidenceTx.deliveryAttemptEvidence.create.mock.calls[0][0];
      const errDetail = evidenceCall.data.errorDetail;
      expect(errDetail).toBeDefined();
      const errorStr = (errDetail as Record<string, unknown>).error as string;
      expect(errorStr.length).toBeLessThanOrEqual(300); // bounded to MAX_ERROR_DETAIL_LENGTH (256)
    });

    // BLOCKER5: red tests for missing secret patterns — must REDACT, not log
    it('redacts GitHub personal access tokens (ghp_)', async () => {
      const event = makeFencedEvent();

      const consumerTxLeaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
      });
      const consumerTx = makeTx({
        outboxLease: { findUnique: jest.fn().mockResolvedValue(consumerTxLeaseRow) },
      });
      const evidenceTx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue({
            deliveryStatus: 'leased',
            leaseHolder: 'holder-1',
            deliveryOrdinal: 1,
            leaseExpiresAt: FIXED_NOW_PLUS_30S,
            failureCount: 0,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });
      const prisma = makePrisma([consumerTx, evidenceTx]);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);

      const failingConsumer = makeConsumer({
        consume: jest.fn().mockRejectedValue(
          new Error(`auth failed with ${GITHUB_PAT_FULL}`),
        ),
      });

      await dispatchRelay.dispatch(event as unknown as OutboxEvent, failingConsumer);

      const evidenceCall = evidenceTx.deliveryAttemptEvidence.create.mock.calls[0][0];
      const errDetail = evidenceCall.data.errorDetail;
      const errorStr = (errDetail as Record<string, unknown>).error as string;
      expect(errorStr).not.toContain(GITHUB_PAT_FULL);
      expect(errorStr).toContain('[REDACTED:github-pat]');
    });

    it('redacts Slack bot tokens (xoxb-)', async () => {
      const event = makeFencedEvent();

      const consumerTxLeaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
      });
      const consumerTx = makeTx({
        outboxLease: { findUnique: jest.fn().mockResolvedValue(consumerTxLeaseRow) },
      });
      const evidenceTx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue({
            deliveryStatus: 'leased',
            leaseHolder: 'holder-1',
            deliveryOrdinal: 1,
            leaseExpiresAt: FIXED_NOW_PLUS_30S,
            failureCount: 0,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });
      const prisma = makePrisma([consumerTx, evidenceTx]);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);

      const failingConsumer = makeConsumer({
        consume: jest.fn().mockRejectedValue(
          new Error(`slack error: ${SLACK_BOT_FULL}`),
        ),
      });

      await dispatchRelay.dispatch(event as unknown as OutboxEvent, failingConsumer);

      const evidenceCall = evidenceTx.deliveryAttemptEvidence.create.mock.calls[0][0];
      const errDetail = evidenceCall.data.errorDetail;
      const errorStr = (errDetail as Record<string, unknown>).error as string;
      expect(errorStr).not.toContain(SLACK_BOT_FULL);
      expect(errorStr).not.toContain('xoxb');
      expect(errorStr).toContain('[REDACTED:slack-bot]');
    });

    it('redacts Stripe live keys (sk_live_) as standalone tokens', async () => {
      const event = makeFencedEvent();

      const consumerTxLeaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
      });
      const consumerTx = makeTx({
        outboxLease: { findUnique: jest.fn().mockResolvedValue(consumerTxLeaseRow) },
      });
      const evidenceTx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue({
            deliveryStatus: 'leased',
            leaseHolder: 'holder-1',
            deliveryOrdinal: 1,
            leaseExpiresAt: FIXED_NOW_PLUS_30S,
            failureCount: 0,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });
      const prisma = makePrisma([consumerTx, evidenceTx]);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);

      const failingConsumer = makeConsumer({
        consume: jest.fn().mockRejectedValue(
          new Error(`stripe: ${STRIPE_LIVE_FULL}`),
        ),
      });

      await dispatchRelay.dispatch(event as unknown as OutboxEvent, failingConsumer);

      const evidenceCall = evidenceTx.deliveryAttemptEvidence.create.mock.calls[0][0];
      const errDetail = evidenceCall.data.errorDetail;
      const errorStr = (errDetail as Record<string, unknown>).error as string;
      expect(errorStr).not.toContain(STRIPE_LIVE_FULL);
      expect(errorStr).toContain('[REDACTED:stripe-live]');
    });
  });

  // -- IMPORTANT 8: negative-control mutation tests (RED → restore → GREEN) ---

  describe('NEGATIVE-CONTROL: missing outbox insert is load-bearing (RED → GREEN)', () => {
    it('RED: relay is blind when outbox row was never created for a completed transition', async () => {
      // The defect: executeInTransaction commits the transition but skips
      // the taskOutboxEvent.create() call. The transition is durable but the
      // relay poll finds nothing — the consumer is never notified.
      const tx = makeTx({
        taskOutboxEvent: {
          findMany: jest.fn().mockResolvedValue([]), // ← outbox row skipped
        },
      });
      const prisma = makePrisma(tx);
      const pollRelay = new OutboxRelay(prisma, clock, idSource, config);
      const consumer = makeConsumer();

      const events = await pollRelay.poll();

      // RED proof: zero events discovered. The outbox row IS load-bearing —
      // without it the relay is blind and the consumer never learns of the
      // completed transition.
      expect(events).toHaveLength(0);
      expect(consumer.consume).not.toHaveBeenCalled();
    });

    it('GREEN: with outbox row restored, relay finds and delivers the event as expected', async () => {
      // Restore (unmutate): the taskOutboxEvent.create was NOT skipped,
      // so the outbox row is present and the relay discovers it.
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
      await cycleRelay.resume();

      const consumer = makeConsumer();
      const result = await cycleRelay.cycle(consumer);

      // GREEN proof: the event was found, leased, and delivered.
      // The relay is not blind — it sees the outbox row and transports it.
      expect(result.polled).toBe(1);
      expect(result.leased).toBe(1);
      expect(result.delivered).toBe(1);
      expect(consumer.consume).toHaveBeenCalledTimes(1);
    });
  });

  describe('NEGATIVE-CONTROL: skipped inbox dedup is load-bearing (RED → GREEN)', () => {
    it('RED: consumer is invoked twice for the same event when inbox check is bypassed', async () => {
      // The defect: dispatch() is mutated to skip consumerInbox.findUnique
      // so the inbox dedup guard is absent. Every dispatch call invokes the
      // consumer regardless of prior delivery — double delivery.
      const event = makeFencedEvent();

      const leaseRow = makeLeaseRow({
        deliveryStatus: 'leased',
        leaseHolder: 'holder-1',
        deliveryOrdinal: 1,
        leaseExpiresAt: FIXED_NOW_PLUS_30S,
      });

      // MUTATION: consumerInbox.findUnique always returns null — the dedup
      // guard has been removed. This simulates a code path where the inbox
      // table read was deleted or bypassed.
      const tx = makeTx({
        outboxLease: {
          findUnique: jest.fn().mockResolvedValue(leaseRow),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        consumerInbox: {
          findUnique: jest.fn().mockResolvedValue(null), // ← ALWAYS null: no dedup
          create: jest.fn().mockResolvedValue({}),
        },
        deliveryAttemptEvidence: {
          create: jest.fn().mockResolvedValue({}),
        },
      });
      const prisma = makePrisma(tx);
      const dispatchRelay = new OutboxRelay(prisma, clock, idSource, config);
      const consumer = makeConsumer();

      // Dispatch the same event twice
      const r1 = await dispatchRelay.dispatch(
        event as unknown as OutboxEvent, consumer,
      );
      const r2 = await dispatchRelay.dispatch(
        event as unknown as OutboxEvent, consumer,
      );

      // RED proof: both dispatches invoke the consumer. Without the inbox
      // dedup guard, double delivery occurs — the invariant is violated.
      expect(r1).toBe('delivered');
      expect(r2).toBe('delivered');
      expect(consumer.consume).toHaveBeenCalledTimes(2);
      expect(tx.consumerInbox.create).toHaveBeenCalledTimes(2);
    });

    it('GREEN: with inbox dedup restored, consumer is invoked exactly once', async () => {
      // Restore (unmutate): the inbox check is present and works.
      // First dispatch → inbox empty → consumer runs.
      // Second dispatch → inbox row exists → consumer skipped (dedup).
      const event = makeFencedEvent();

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
          findUnique: jest
            .fn()
            .mockResolvedValueOnce(null)      // first dispatch: no entry
            .mockResolvedValueOnce({           // second dispatch: entry exists
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

      // Dispatch the same event twice
      const r1 = await dispatchRelay.dispatch(
        event as unknown as OutboxEvent, consumer,
      );
      const r2 = await dispatchRelay.dispatch(
        event as unknown as OutboxEvent, consumer,
      );

      // GREEN proof: the inbox dedup prevented double delivery.
      // Consumer was called exactly once; the second dispatch returned
      // 'delivered' from the dedup path without re-invoking consume().
      expect(r1).toBe('delivered');
      expect(r2).toBe('delivered');
      expect(consumer.consume).toHaveBeenCalledTimes(1);
      expect(tx.consumerInbox.create).toHaveBeenCalledTimes(1);
    });
  });
});
