// MUN-0021: Outbox relay — disabled-by-default, stoppable PostgreSQL-local
// lease relay. Polls the outbox for pending/expired events, acquires fenced
// leases via atomic UPDATE, dispatches to a database-local transactional
// fixture consumer with durable inbox deduplication, and quarantines poison
// events without head-of-line blocking.
//
// This is a plain class, NOT a NestJS service. No @Injectable(), no module
// registration, no runtime wiring. The caller instantiates and calls cycle().
//
// Fleet supervision is a forbidden ownership leak — this relay transports
// committed Muneral task facts only: no fleet registry, lifecycle, placement,
// update, watchdog, telemetry aggregation, or direct command routing.

import {
  MalformedOutboxEventError,
  StaleFenceError,
  WrongPlanePayloadError,
} from './outbox.errors';
import {
  normaliseConfig,
  validateOutboxEvent,
  validatePayloadPlane,
  MAX_ERROR_DETAIL_LENGTH,
  sanitiseErrorDetail,
} from './outbox.types';
import type {
  OutboxEvent,
  OutboxConsumer,
  DeliveryDisposition,
  RelayConfig,
  CycleResult,
  ReconciliationSnapshot,
  QuarantineEntry,
  LeaseFence,
  Clock,
  IdSource,
} from './outbox.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrismaTx = any;

const FENCE_REQUIRED_MSG =
  'OutboxRelay: event has no fence token — was it leased? Fencing is mandatory.';

export interface TransactionalClient {
  $transaction<T>(
    fn: (tx: PrismaTx) => Promise<T>,
    options?: Record<string, unknown>,
  ): Promise<T>;
}

export class OutboxRelay {
  private stopped: boolean;
  private cycleId: string | null;

  constructor(
    private readonly prisma: TransactionalClient,
    private readonly clock: Clock,
    private readonly idSource: IdSource,
    config: RelayConfig | Partial<RelayConfig> & { relayId: string },
  ) {
    // IMP10: normaliseConfig enforced at the public constructor boundary.
    // Raw RelayConfig callers cannot bypass identifier and numeric bounds.
    this.config = normaliseConfig(
      config as Partial<RelayConfig> & { relayId: string },
    );
    this.stopped = true; // disabled by default
    this.cycleId = null;
  }

  private readonly config: RelayConfig;

  // -- public API -----------------------------------------------------------

  /** Poll for pending events and events with expired leases. */
  async poll(): Promise<OutboxEvent[]> {
    const now = this.clock.now();

    const rows = await this.prisma.$transaction(async (tx) => {

      return tx.taskOutboxEvent.findMany({
        where: {
          lease: {
            OR: [
              { deliveryStatus: 'pending' },
              {
                deliveryStatus: 'leased',
                leaseExpiresAt: { lt: now },
              },
            ],
          },
        },
        include: { lease: true },
        orderBy: { recordedAt: 'asc' },
        take: this.config.batchSize,
      });
    });

    return rows.map((r: Record<string, unknown>) => this.unmarshalOutboxEvent(r));
  }

  /**
   * Acquire a lease on a batch of events via atomic UPDATE with fencing.
   * Returns only the events whose lease was successfully acquired.
   */
  async lease(events: OutboxEvent[]): Promise<OutboxEvent[]> {
    if (events.length === 0) return [];

    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + this.config.leaseTtlMs);
    const holder = `${this.config.relayId}-${this.idSource.generate()}`;
    this.cycleId = holder;

    const ids = events.map((e) => e.id);

    const result = await this.prisma.$transaction(async (tx) => {
      // Atomic fenced lease acquisition.
      // Increments delivery_ordinal so every acquisition has a unique fence.

      const updated = await (tx as PrismaTx).$queryRawUnsafe?.call?.(
        tx as PrismaTx,
        `UPDATE outbox_leases
         SET lease_holder = $1,
             lease_acquired_at = $2,
             lease_expires_at = $3,
             delivery_ordinal = delivery_ordinal + 1,
             delivery_status = 'leased'
         WHERE outbox_event_id = ANY($4::uuid[])
           AND (delivery_status = 'pending'
                OR (delivery_status = 'leased' AND lease_expires_at < $2))
         RETURNING outbox_event_id, delivery_ordinal`,
        holder,
        now,
        expiresAt,
        ids,
      ) as Array<{ outbox_event_id: string; delivery_ordinal: number }>;

      // If using Prisma's type-safe API instead of raw SQL, fall through to
      // the individual update path:
      if (!Array.isArray(updated) || updated.length === 0) {
        // Fallback: update one-by-one for environments without $queryRawUnsafe
        const acquired: Array<{ outbox_event_id: string; delivery_ordinal: number }> = [];
        for (const event of events) {
          try {

            const leaseRow = (tx as PrismaTx).outboxLease?.updateMany
              ? await (tx as PrismaTx).outboxLease.updateMany({
                  where: {
                    outboxEventId: event.id,
                    OR: [
                      { deliveryStatus: 'pending' },
                      {
                        deliveryStatus: 'leased',
                        leaseExpiresAt: { lt: now },
                      },
                    ],
                  },
                  data: {
                    leaseHolder: holder,
                    leaseAcquiredAt: now,
                    leaseExpiresAt: expiresAt,
                    deliveryOrdinal: { increment: 1 },
                    deliveryStatus: 'leased',
                  },
                })
              : null;

            if (leaseRow && leaseRow.count > 0) {
              // Re-read to get the new ordinal
              const reRead = await (tx as PrismaTx).outboxLease.findUnique({
                where: { outboxEventId: event.id },
              });
              acquired.push({
                outbox_event_id: event.id,
                delivery_ordinal: reRead?.deliveryOrdinal ?? 0,
              });
            }
          } catch {
            // Skip — another worker claimed it
          }
        }
        return acquired;
      }

      return updated.map((r) => ({
        outbox_event_id: r.outbox_event_id,
        delivery_ordinal: Number(r.delivery_ordinal),
      }));
    });

    // Build a map of acquired events by id with their new ordinal
    const acquiredMap = new Map(
      result.map((r) => [r.outbox_event_id, r.delivery_ordinal]),
    );

    // Return only the events whose lease was successfully acquired
    return events
      .filter((e) => acquiredMap.has(e.id))
      .map((e) => ({
        ...e,
        _fence: {
          leaseHolder: holder,
          deliveryOrdinal: acquiredMap.get(e.id)!,
        } as LeaseFence,
      })) as Array<OutboxEvent & { _fence: LeaseFence }> as unknown as OutboxEvent[];
  }

  /**
   * Dispatch one event to the consumer with fenced inbox deduplication.
   *
   * CRIT1: The consumer runs inside a bounded PostgreSQL transaction. If
   * the consumer throws, that entire transaction rolls back — no partial
   * consumer writes survive. A second, separate bounded transaction then
   * writes retry/quarantine evidence, gated on the same holder/ordinal
   * fence. A stale or reclaimed lease commits no consumer effect, inbox,
   * delivery evidence, or success state.
   *
   * CRIT2: Fencing is mandatory. The event MUST carry a _fence token from
   * lease(). Every mutation checks holder+ordinal and detects
   * updateMany.count=0 (stale/reclaimed lease).
   */
  async dispatch(
    event: OutboxEvent,
    consumer: OutboxConsumer,
  ): Promise<DeliveryDisposition> {
    const candidate = event as unknown as Record<string, unknown> | null;
    const eventId = candidate?.id;
    if (typeof eventId !== 'string' || eventId.length === 0) {
      throw new MalformedOutboxEventError(
        '<invalid-id>',
        'id must be a non-empty string before any quarantine write',
      );
    }
    const fence = candidate?._fence as LeaseFence | undefined;
    if (
      !fence ||
      typeof fence.leaseHolder !== 'string' ||
      fence.leaseHolder.length === 0 ||
      !Number.isSafeInteger(fence.deliveryOrdinal) ||
      fence.deliveryOrdinal < 1
    ) {
      throw new Error(FENCE_REQUIRED_MSG);
    }
    const now = this.clock.now();

    // ---- 0. Wrong-plane payload check (pre-tx, fail-closed) ----
    // Must happen BEFORE any transaction so that quarantine evidence is not
    // rolled back by a subsequent throw. If the payload is wrong-plane we
    // record quarantine in a durable mini-transaction, then throw.
    const planeErr = validatePayloadPlane(
      event.eventPayload as unknown as Record<string, unknown>,
    );
    if (planeErr !== null) {
      const recorded = await this.recordInvalidEventQuarantine(
        eventId,
        fence,
        planeErr,
        'WRONG_PLANE',
      );
      if (!recorded) return 'expired';
      throw new WrongPlanePayloadError(eventId, planeErr);
    }
    const contractErr = validateOutboxEvent(event);
    if (contractErr !== null) {
      const recorded = await this.recordInvalidEventQuarantine(
        eventId,
        fence,
        contractErr,
        'MALFORMED_EVENT',
      );
      if (!recorded) return 'expired';
      throw new MalformedOutboxEventError(eventId, contractErr);
    }

    // ---- 1. Consumer transaction (may roll back) ----
    // The consumer runs inside its own transaction. If the consumer throws,
    // every consumer write is rolled back. On success, inbox, delivery
    // evidence, and lease status commit together.
    try {
      return await this.prisma.$transaction(async (tx) => {
        // -- 1a. Fence check — verify holder+ordinal match (mandatory) --
        const leaseValid = await this.validateLeaseFence(
          tx, event.id, fence, now,
        );
        if (!leaseValid) return 'expired' as DeliveryDisposition;

        // -- 1b. Inbox dedup check --
        const inboxRow = await (tx as PrismaTx).consumerInbox.findUnique({
          where: {
            consumerId_outboxEventId: {
              consumerId: consumer.consumerId,
              outboxEventId: event.id,
            },
          },
        });

        if (inboxRow) {
          // IMP5: Only attempt to update the lease if it is still in 'leased'
          // state. If already 'delivered' (prior dispatch completed), skip the
          // update — terminal rows are forward-only. The inbox row proves
          // delivery already happened.
          const currentLease = await (tx as PrismaTx).outboxLease.findUnique({
            where: { outboxEventId: event.id },
            select: { deliveryStatus: true },
          });
          if (currentLease?.deliveryStatus === 'leased') {
            const updated = await this.updateLeaseFenced(
              tx, event.id, 'delivered', fence,
            );
            if (!updated) return 'expired' as DeliveryDisposition;
          }
          await this.recordDeliveryAttempt(
            tx, event.id, fence.deliveryOrdinal, 'delivered',
            inboxRow.sideEffectDigest ?? inboxRow.side_effect_digest, null,
          );
          return 'delivered' as DeliveryDisposition;
        }

        // -- 1c. Call consumer inside the transaction --
        // If the consumer throws, this ENTIRE transaction rolls back.
        // No partial consumer writes, no evidence rows survive.
        const consumerResult = await consumer.consume(event, tx);

        await (tx as PrismaTx).consumerInbox.create({
          data: {
            consumerId: consumer.consumerId,
            outboxEventId: event.id,
            consumedAt: now,
            sideEffectDigest: consumerResult.digest,
          },
        });

        const leaseUpdated = await this.updateLeaseFenced(
          tx, event.id, 'delivered', fence,
        );
        if (!leaseUpdated) {
          // CRIT1: Fence was reclaimed between consumer success and the
          // final fenced lease update. THROW to roll back the entire tx —
          // consumer effect, inbox row, and all evidence. A stale/reclaimed
          // lease commits zero consumer effect, inbox, evidence, or status
          // change.
          throw new StaleFenceError(
            event.id,
            { holder: fence.leaseHolder, ordinal: fence.deliveryOrdinal },
            { holder: null, ordinal: -1 },
          );
        }

        await this.recordDeliveryAttempt(
          tx, event.id, fence.deliveryOrdinal, 'delivered',
          consumerResult.digest, null,
        );

        return 'delivered' as DeliveryDisposition;
      });
    } catch (err) {
      // ---- 2. Consumer threw → transaction rolled back ----
      // The consumer's writes are completely gone. Now open a SECOND
      // bounded transaction to write failure evidence, gated on the
      // same holder/ordinal fence. A stale/reclaimed lease records
      // no evidence.
      if (err instanceof WrongPlanePayloadError) throw err;
      // CRIT1: Stale fence after consumer success → tx was rolled back,
      // no failure evidence needed (consumer didn't fail, fence was reclaimed).
      if (err instanceof StaleFenceError) return 'expired' as DeliveryDisposition;
      // Re-throw infrastructure errors
      if (isInfrastructureError(err)) throw err;

      return this.recordFailureEvidence(event.id, fence, err);
    }
  }

  /** Full cycle: poll → lease → dispatch each → return result. */
  async cycle(consumer: OutboxConsumer): Promise<CycleResult> {
    if (this.stopped) {
      return { polled: 0, leased: 0, delivered: 0, quarantined: 0, skipped: 0 };
    }

    const events = await this.poll();
    const polled = events.length;

    if (polled === 0) {
      return { polled: 0, leased: 0, delivered: 0, quarantined: 0, skipped: 0 };
    }

    const leased = await this.lease(events);
    const leasedCount = leased.length;

    let delivered = 0;
    let quarantined = 0;
    let skipped = 0;

    // IMP9: stop() must prevent dispatch of the remainder of an already
    // leased batch. Check stopped before each dispatch iteration.
    for (const event of leased) {
      if (this.stopped) {
        // Remainder of batch left pending/recoverable — lease will expire
        // naturally and be re-acquired after resume().
        skipped++;
        continue;
      }
      try {
        const disposition = await this.dispatch(event, consumer);
        if (disposition === 'delivered') delivered++;
        else if (disposition === 'quarantined') quarantined++;
        else skipped++;
      } catch (err) {
        if (
          err instanceof WrongPlanePayloadError ||
          err instanceof MalformedOutboxEventError
        ) {
          // Invalid dispatch throws only after durable quarantine evidence
          // commits. Stale/expired fences return `expired` instead.
          quarantined++;
        } else if (isInfrastructureError(err)) {
          // Infrastructure errors (connection loss) — skip, event will be
          // re-polled after lease expiry.
          skipped++;
        } else {
          skipped++;
        }
      }
    }

    return { polled, leased: leasedCount, delivered, quarantined, skipped };
  }

  /** Stop the relay. Rejects new cycles. In-flight dispatch completes;
   *  unstarted remainder of a leased batch is left pending/recoverable.
   *  IMP9: stop() prevents dispatch of the remainder. */
  stop(): void {
    this.stopped = true;
  }

  /** Resume from durable state. No in-memory state is restored. */
  async resume(): Promise<void> {
    this.stopped = false;
  }

  /** Read-only reconciliation snapshot across all surfaces. */
  async reconciliation(): Promise<ReconciliationSnapshot> {
    return this.prisma.$transaction(async (tx) => {
      const t = tx as PrismaTx;

      // Lease summary
      const leaseRows: Array<{ deliveryStatus: string }> =
        await t.outboxLease.findMany({
          select: { deliveryStatus: true },
          orderBy: { outboxEventId: 'asc' },
        });
      const leaseSummary: Record<string, number> = {};
      for (const r of leaseRows) {
        const s = r.deliveryStatus ?? 'unknown';
        leaseSummary[s] = (leaseSummary[s] ?? 0) + 1;
      }

      // Quarantined
      const qRows = await t.quarantineEvidence.findMany({
        orderBy: [
          { quarantinedAt: 'desc' },
          { outboxEventId: 'asc' },
        ],
      });
      const quarantined: QuarantineEntry[] = qRows.map(
        (r: Record<string, unknown>) => ({
          id: r.id as string,
          outboxEventId: (r.outboxEventId ?? r.outbox_event_id) as string,
          deliveryOrdinal: Number(r.deliveryOrdinal ?? r.delivery_ordinal),
          failureCount: Number(r.failureCount ?? r.failure_count),
          lastErrorCode: (r.lastErrorCode ?? r.last_error_code ?? null) as string | null,
          lastErrorDetail: (r.lastErrorDetail ?? r.last_error_detail ?? null) as Record<string, unknown> | null,
          quarantinedAt: new Date((r.quarantinedAt ?? r.quarantined_at) as string),
        }),
      );

      // Attempt counts
      const attemptRows = await t.deliveryAttemptEvidence.findMany({
        select: { outboxEventId: true },
        orderBy: [
          { outboxEventId: 'asc' },
          { attemptedAt: 'asc' },
        ],
      });
      const attemptMap = new Map<string, number>();
      for (const r of attemptRows) {
        const id = r.outboxEventId ?? r.outbox_event_id;
        attemptMap.set(id, (attemptMap.get(id) ?? 0) + 1);
      }
      const attemptCounts = Array.from(attemptMap.entries()).map(
        ([outboxEventId, count]) => ({ outboxEventId, count }),
      );

      // Inbox summary
      const inboxRows = await t.consumerInbox.findMany({
        select: { consumerId: true },
        orderBy: [
          { consumerId: 'asc' },
          { outboxEventId: 'asc' },
        ],
      });
      const inboxSummary: Record<string, number> = {};
      for (const r of inboxRows) {
        const cid = r.consumerId ?? r.consumer_id;
        inboxSummary[cid] = (inboxSummary[cid] ?? 0) + 1;
      }

      // Orphan events (outbox rows with no lease)
      const outboxIds: Array<{ id: string }> = await t.taskOutboxEvent.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      const leaseEventIds: Array<{ outboxEventId: string }> =
        await t.outboxLease.findMany({
          select: { outboxEventId: true },
          orderBy: { outboxEventId: 'asc' },
        });
      const leaseIdSet = new Set(
        leaseEventIds.map((r) => r.outboxEventId),
      );
      const orphanEvents = outboxIds
        .map((r) => r.id)
        .filter((id) => !leaseIdSet.has(id));

      // Stale leases
      const now = this.clock.now();
      const staleLeaseRows = await t.outboxLease.findMany({
        where: {
          deliveryStatus: 'leased',
          leaseExpiresAt: { lt: now },
        },
        select: { outboxEventId: true, leaseExpiresAt: true },
        orderBy: { outboxEventId: 'asc' },
      });
      const staleLeases = staleLeaseRows.map(
        (r: Record<string, unknown>) => ({
          outboxEventId: (r.outboxEventId ?? r.outbox_event_id) as string,
          expiresAt: new Date((r.leaseExpiresAt ?? r.lease_expires_at) as string),
        }),
      );

      return {
        leaseSummary,
        quarantined,
        attemptCounts,
        inboxSummary,
        orphanEvents,
        staleLeases,
      };
    }, { isolationLevel: 'RepeatableRead' });
  }

  // -- private helpers -------------------------------------------------------

  /**
   * IMP6 / CRIT1 / CRIT2: Record failure evidence in a SECOND bounded
   * transaction that opens AFTER the consumer transaction has rolled back.
   * All writes are gated on the same holder/ordinal fence. A stale/reclaimed
   * lease records no evidence. Error detail is bounded, redacted, and
   * non-secret.
   */
  private async recordFailureEvidence(
    outboxEventId: string,
    fence: LeaseFence,
    err: unknown,
  ): Promise<DeliveryDisposition> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Re-validate fence — it may have been reclaimed while the
        // consumer was running.
        const leaseRow = await (tx as PrismaTx).outboxLease.findUnique({
          where: { outboxEventId },
        });
        if (!leaseRow) return 'expired' as DeliveryDisposition;
        if (
          leaseRow.leaseHolder !== fence.leaseHolder ||
          leaseRow.deliveryOrdinal !== fence.deliveryOrdinal
        ) {
          return 'expired' as DeliveryDisposition;
        }
        const now = this.clock.now();
        if (
          leaseRow.deliveryStatus === 'leased' &&
          leaseRow.leaseExpiresAt &&
          new Date(leaseRow.leaseExpiresAt) < now
        ) {
          return 'expired' as DeliveryDisposition;
        }

        const errorCode =
          err instanceof Error ? err.constructor.name : 'UNKNOWN';
        const rawMessage =
          err instanceof Error ? err.message : String(err);

        // IMP6: Bound and redact error detail. Raw exception messages
        // and attacker-sized content must not enter error_detail.
        const boundedError = sanitiseErrorDetail(rawMessage);

        const updatedLease = await this.bumpFailureCountFenced(
          tx, outboxEventId, errorCode, fence,
        );
        if (!updatedLease) {
          // Fence was lost — stale worker must not append evidence.
          return 'expired' as DeliveryDisposition;
        }
        const failureCount = updatedLease.failureCount;
        const currentOrdinal = updatedLease.deliveryOrdinal;

        if (failureCount >= this.config.maxRetries) {
          await this.recordQuarantine(
            tx, outboxEventId, currentOrdinal, failureCount, errorCode,
          );
          await this.recordDeliveryAttempt(
            tx, outboxEventId, currentOrdinal, 'quarantined', null,
            boundedError,
          );
          await this.updateLeaseFenced(tx, outboxEventId, 'quarantined', {
            leaseHolder: updatedLease.leaseHolder ?? fence.leaseHolder,
            deliveryOrdinal: currentOrdinal,
          });
          return 'quarantined' as DeliveryDisposition;
        }

        // Record the failed attempt without quarantine.
        await this.recordDeliveryAttempt(
          tx, outboxEventId, currentOrdinal, 'expired', null,
          boundedError,
        );

        return 'expired' as DeliveryDisposition;
      });
    } catch (innerErr) {
      // If the evidence transaction itself fails (e.g., connection loss),
      // the event will be re-polled after lease expiry. Return expired
      // so the caller doesn't abort the cycle.
      if (isInfrastructureError(innerErr)) return 'expired' as DeliveryDisposition;
      throw innerErr;
    }
  }

  /**
   * Validate that the current lease row matches the holder+ordinal fence
   * and has not expired. Returns false (stale/expired) or true (valid).
   * CRIT2: This check is mandatory before any dispatch-side write.
   */
  private async validateLeaseFence(
    tx: PrismaTx,
    outboxEventId: string,
    fence: LeaseFence,
    now: Date,
  ): Promise<boolean> {
    const leaseRow = await (tx as PrismaTx).outboxLease.findUnique({
      where: { outboxEventId },
    });
    if (!leaseRow) return false;
    if (
      leaseRow.leaseHolder !== fence.leaseHolder ||
      leaseRow.deliveryOrdinal !== fence.deliveryOrdinal
    ) {
      return false;
    }
    if (
      leaseRow.deliveryStatus === 'leased' &&
      leaseRow.leaseExpiresAt &&
      new Date(leaseRow.leaseExpiresAt) < now
    ) {
      return false;
    }
    return true;
  }

  /**
   * Record wrong-plane quarantine in a durable mini-transaction that commits
   * before the WrongPlanePayloadError is thrown. This ensures the quarantine
   * evidence survives and the event is not endlessly re-polled.
   *
   * BLOCKER1: The fenced status update is the FIRST write and its result
   * gates all evidence persistence. A stale/reclaimed worker's updateMany
   * returns count=0 → zero quarantine, zero attempt evidence, zero status
   * change. The prior code SELECT-checked the fence (read-then-write race
   * window), wrote both evidence rows, then ignored a failed fenced status
   * update return value — a stale worker could persist evidence rows while
   * failing to change status. Now the entire block is one atomic fail-closed
   * transaction: the fenced update gates evidence; if the fence was lost,
   * nothing is written.
   */
  private async recordInvalidEventQuarantine(
    outboxEventId: string,
    fence: LeaseFence,
    reason: string,
    errorCode: 'WRONG_PLANE' | 'MALFORMED_EVENT',
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // Re-read time inside the evidence transaction. Dispatch validation may
      // straddle the TTL boundary; quarantine is allowed only while the lease
      // is live at the write gate, not merely when dispatch began.
      const quarantineNow = this.clock.now();
      // Atomic fenced status update FIRST — gates all evidence writes.
      // updateMany WHERE includes holder+ordinal+status='leased'. A stale
      // or reclaimed worker matches zero rows.
      const updated = await (tx as PrismaTx).outboxLease.updateMany({
        where: {
          outboxEventId,
          leaseHolder: fence.leaseHolder,
          deliveryOrdinal: fence.deliveryOrdinal,
          deliveryStatus: 'leased',
          leaseExpiresAt: { gt: quarantineNow },
        },
        data: { deliveryStatus: 'quarantined' },
      });
      if ((updated?.count ?? 0) === 0) {
        // Stale worker — atomically forward-only, zero evidence persisted.
        return false;
      }

      await this.recordQuarantine(
        tx, outboxEventId, fence.deliveryOrdinal, 1, errorCode,
      );
      await this.recordDeliveryAttempt(
        tx, outboxEventId, fence.deliveryOrdinal, 'quarantined', null,
        {
          error: errorCode === 'WRONG_PLANE' ? 'wrong-plane' : 'malformed-event',
          code: errorCode,
          detail: reason.slice(0, MAX_ERROR_DETAIL_LENGTH),
        },
      );
      return true;
    });
  }

  /**
   * CRIT2 / IMP5: Update lease status with mandatory fence. Returns true if
   * the update affected a row, false if the fence was stale or the row is
   * in a terminal (delivered/quarantined) state. Terminal rows are
   * forward-only and cannot be mutated.
   */
  private async updateLeaseFenced(
    tx: PrismaTx,
    outboxEventId: string,
    status: string,
    fence: LeaseFence,
  ): Promise<boolean> {
    const result = await (tx as PrismaTx).outboxLease.updateMany({
      where: {
        outboxEventId,
        leaseHolder: fence.leaseHolder,
        deliveryOrdinal: fence.deliveryOrdinal,
        deliveryStatus: 'leased', // IMP5: only mutable while leased
      },
      data: { deliveryStatus: status },
    });
    return (result?.count ?? 0) > 0;
  }

  private async bumpFailureCountFenced(
    tx: PrismaTx,
    outboxEventId: string,
    errorCode: string,
    fence: LeaseFence,
  ): Promise<{ failureCount: number; deliveryOrdinal: number; leaseHolder: string | null } | null> {
    // Increment failure_count atomically, gated on fence and mutable state.
    // IMP5: Only rows in 'leased' state can be bumped — delivered/quarantined
    // rows are forward-only and immutable.
    const updated = await (tx as PrismaTx).outboxLease.updateMany({
      where: {
        outboxEventId,
        leaseHolder: fence.leaseHolder,
        deliveryOrdinal: fence.deliveryOrdinal,
        deliveryStatus: 'leased',
      },
      data: {
        failureCount: { increment: 1 },
        lastErrorCode: errorCode,
      },
    });
    if ((updated?.count ?? 0) !== 1) return null;

    // Re-read for the new values
    const row = await (tx as PrismaTx).outboxLease.findUnique({
      where: { outboxEventId },
    });
    if (!row) return null;
    return {
      failureCount: row.failureCount ?? row.failure_count ?? 0,
      deliveryOrdinal: row.deliveryOrdinal ?? row.delivery_ordinal ?? 0,
      leaseHolder: (row.leaseHolder ?? row.lease_holder ?? null) as string | null,
    };
  }

  private async recordDeliveryAttempt(
    tx: PrismaTx,
    outboxEventId: string,
    deliveryOrdinal: number,
    disposition: string,
    consumerDigest: string | null,
    errorDetail: Record<string, unknown> | null,
  ): Promise<void> {
    await (tx as PrismaTx).deliveryAttemptEvidence.create({
      data: {
        id: this.idSource.generate(),
        outboxEventId,
        deliveryOrdinal,
        disposition,
        consumerDigest,
        errorDetail: errorDetail ?? undefined,
        attemptedAt: this.clock.now(),
      },
    });
  }

  private async recordQuarantine(
    tx: PrismaTx,
    outboxEventId: string,
    deliveryOrdinal: number,
    failureCount: number,
    lastErrorCode: string,
  ): Promise<void> {
    await (tx as PrismaTx).quarantineEvidence.create({
      data: {
        id: this.idSource.generate(),
        outboxEventId,
        deliveryOrdinal,
        failureCount,
        lastErrorCode,
        lastErrorDetail: undefined,
        quarantinedAt: this.clock.now(),
      },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private unmarshalOutboxEvent(row: Record<string, any>): OutboxEvent {
    return {
      id: row.id as string,
      taskId: (row.taskId ?? row.task_id) as string,
      aggregateVersion: Number(row.aggregateVersion ?? row.aggregate_version),
      attemptId: (row.attemptId ?? row.attempt_id) as string,
      transitionId: (row.transitionId ?? row.transition_id) as string,
      eventType: (row.eventType ?? row.event_type) as OutboxEvent['eventType'],
      eventPayload:
        (row.eventPayload ?? row.event_payload ?? {}) as OutboxEvent['eventPayload'],
      recordedAt: new Date((row.recordedAt ?? row.recorded_at) as string),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isInfrastructureError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  if (typeof err !== 'object') return false;
  const e = err as { code?: string };
  // Prisma connection / transaction errors
  return (
    e.code === 'P1000' ||
    e.code === 'P1001' ||
    e.code === 'P1002' ||
    e.code === 'P1010' ||
    e.code === 'P1011' ||
    e.code === 'P1017' ||
    e.code === 'P2024' ||
    e.code === 'P2028' ||
    e.code === 'P2034'
  );
}
