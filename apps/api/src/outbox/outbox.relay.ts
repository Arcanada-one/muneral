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

import { WrongPlanePayloadError } from './outbox.errors';
import { validatePayloadPlane } from './outbox.types';
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

export interface TransactionalClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction<T>(
    fn: (tx: any) => Promise<T>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: Record<string, any>,
  ): Promise<T>;
}

export class OutboxRelay {
  private stopped: boolean;
  private cycleId: string | null;

  constructor(
    private readonly prisma: TransactionalClient,
    private readonly clock: Clock,
    private readonly idSource: IdSource,
    private readonly config: RelayConfig,
  ) {
    this.stopped = true; // disabled by default
    this.cycleId = null;
  }

  // -- public API -----------------------------------------------------------

  /** Poll for pending events and events with expired leases. */
  async poll(): Promise<OutboxEvent[]> {
    const now = this.clock.now();

    const rows = await this.prisma.$transaction(async (tx) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updated = await (tx as any).$queryRawUnsafe?.call?.(
        tx as any,
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
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const leaseRow = (tx as any).outboxLease?.updateMany
              ? await (tx as any).outboxLease.updateMany({
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
              const reRead = await (tx as any).outboxLease.findUnique({
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
   * Runs inside a single PostgreSQL transaction.
   */
  async dispatch(
    event: OutboxEvent,
    consumer: OutboxConsumer,
  ): Promise<DeliveryDisposition> {
    const fence = (event as unknown as { _fence?: LeaseFence })._fence;
    const now = this.clock.now();

    // ---- 0. Wrong-plane payload check (pre-tx, fail-closed) ----
    // Must happen BEFORE any transaction so that quarantine evidence is not
    // rolled back by a subsequent throw. If the payload is wrong-plane we
    // record quarantine in a durable mini-transaction, then throw.
    const planeErr = validatePayloadPlane(
      event.eventPayload as unknown as Record<string, unknown>,
    );
    if (planeErr !== null) {
      await this.recordWrongPlaneQuarantine(event.id, fence, planeErr);
      throw new WrongPlanePayloadError(event.id, planeErr);
    }

    return this.prisma.$transaction(async (tx) => {
      // ---- 1. Fence check — verify holder+ordinal match ----
      const leaseRow = await (tx as any).outboxLease.findUnique({
        where: { outboxEventId: event.id },
      });
      if (!leaseRow) {
        return 'expired' as DeliveryDisposition;
      }
      if (
        fence &&
        (leaseRow.leaseHolder !== fence.leaseHolder ||
          leaseRow.deliveryOrdinal !== fence.deliveryOrdinal)
      ) {
        return 'expired' as DeliveryDisposition;
      }
      if (
        leaseRow.deliveryStatus === 'leased' &&
        leaseRow.leaseExpiresAt &&
        new Date(leaseRow.leaseExpiresAt) < now
      ) {
        return 'expired' as DeliveryDisposition;
      }

      // ---- 2. Inbox dedup check ----
      const inboxRow = await (tx as any).consumerInbox.findUnique({
        where: {
          consumerId_outboxEventId: {
            consumerId: consumer.consumerId,
            outboxEventId: event.id,
          },
        },
      });

      if (inboxRow) {
        await this.updateLeaseFenced(tx, event.id, 'delivered', fence);
        await this.recordDeliveryAttempt(
          tx, event.id, fence?.deliveryOrdinal ?? 0, 'delivered',
          inboxRow.sideEffectDigest ?? inboxRow.side_effect_digest, null,
        );
        return 'delivered' as DeliveryDisposition;
      }

      // ---- 3. Call consumer inside the transaction ----
      try {
        const consumerResult = await consumer.consume(event, tx);

        await (tx as any).consumerInbox.create({
          data: {
            consumerId: consumer.consumerId,
            outboxEventId: event.id,
            consumedAt: now,
            sideEffectDigest: consumerResult.digest,
          },
        });

        await this.updateLeaseFenced(tx, event.id, 'delivered', fence);

        await this.recordDeliveryAttempt(
          tx, event.id, fence?.deliveryOrdinal ?? 0, 'delivered',
          consumerResult.digest, null,
        );

        return 'delivered' as DeliveryDisposition;
      } catch (err) {
        const errorCode =
          err instanceof Error ? err.constructor.name : 'UNKNOWN';
        const errorMessage =
          err instanceof Error ? err.message : String(err);

        const updatedLease = await this.bumpFailureCountFenced(
          tx, event.id, errorCode, fence,
        );
        if (!updatedLease) {
          // The holder/ordinal fence was lost while the consumer ran. A stale
          // worker must not append evidence or mutate the reclaimed lease.
          return 'expired' as DeliveryDisposition;
        }
        const failureCount = updatedLease?.failureCount ?? 0;
        const currentOrdinal = updatedLease?.deliveryOrdinal ?? (fence?.deliveryOrdinal ?? 0);

        if (
          updatedLease &&
          failureCount >= this.config.maxRetries
        ) {
          await this.recordQuarantine(
            tx, event.id, currentOrdinal, failureCount, errorCode,
          );
          await this.recordDeliveryAttempt(
            tx, event.id, currentOrdinal, 'quarantined', null,
            { error: errorMessage, code: errorCode },
          );
          await this.updateLeaseFenced(tx, event.id, 'quarantined', {
            leaseHolder: updatedLease.leaseHolder ?? (fence?.leaseHolder ?? ''),
            deliveryOrdinal: currentOrdinal,
          });
          return 'quarantined' as DeliveryDisposition;
        }

        // Record the failed attempt without quarantine.
        // Return 'expired' instead of throwing so this transaction commits
        // and the failure_count increment + delivery-attempt evidence are
        // durable. The consumer's own side effects were never committed
        // (the consumer threw inside this tx) — that is correct.
        await this.recordDeliveryAttempt(
          tx, event.id, currentOrdinal, 'expired', null,
          { error: errorMessage, code: errorCode },
        );

        return 'expired' as DeliveryDisposition;
      }
    });
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

    for (const event of leased) {
      try {
        const disposition = await this.dispatch(event, consumer);
        if (disposition === 'delivered') delivered++;
        else if (disposition === 'quarantined') quarantined++;
        else skipped++;
      } catch (err) {
        if (err instanceof WrongPlanePayloadError) {
          // Wrong-plane dispatch records durable quarantine evidence before
          // throwing, so the cycle result must expose it as quarantined.
          quarantined++;
        } else {
          skipped++;
        }
      }
    }

    return { polled, leased: leasedCount, delivered, quarantined, skipped };
  }

  /** Stop the relay. In-flight dispatch completes; new cycles are no-ops. */
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
      const t = tx as any;

      // Lease summary
      const leaseRows: Array<{ deliveryStatus: string }> =
        await t.outboxLease.findMany({ select: { deliveryStatus: true } });
      const leaseSummary: Record<string, number> = {};
      for (const r of leaseRows) {
        const s = r.deliveryStatus ?? 'unknown';
        leaseSummary[s] = (leaseSummary[s] ?? 0) + 1;
      }

      // Quarantined
      const qRows = await t.quarantineEvidence.findMany({
        orderBy: { quarantinedAt: 'desc' },
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
      });
      const inboxSummary: Record<string, number> = {};
      for (const r of inboxRows) {
        const cid = r.consumerId ?? r.consumer_id;
        inboxSummary[cid] = (inboxSummary[cid] ?? 0) + 1;
      }

      // Orphan events (outbox rows with no lease)
      const outboxIds: Array<{ id: string }> = await t.taskOutboxEvent.findMany({
        select: { id: true },
      });
      const leaseEventIds: Array<{ outboxEventId: string }> =
        await t.outboxLease.findMany({ select: { outboxEventId: true } });
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
    });
  }

  // -- private helpers -------------------------------------------------------

  /**
   * Record wrong-plane quarantine in a durable mini-transaction that commits
   * before the WrongPlanePayloadError is thrown. This ensures the quarantine
   * evidence survives and the event is not endlessly re-polled.
   */
  private async recordWrongPlaneQuarantine(
    outboxEventId: string,
    fence: LeaseFence | undefined,
    reason: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.recordQuarantine(
        tx, outboxEventId, fence?.deliveryOrdinal ?? 0, 1, 'WRONG_PLANE',
      );
      await this.recordDeliveryAttempt(
        tx, outboxEventId, fence?.deliveryOrdinal ?? 0, 'quarantined', null,
        { reason },
      );
      await this.updateLeaseFenced(tx, outboxEventId, 'quarantined', fence);
    });
  }

  private async updateLeaseFenced(
    tx: PrismaTx,
    outboxEventId: string,
    status: string,
    fence?: LeaseFence,
  ): Promise<void> {
    const where: Record<string, unknown> = { outboxEventId };
    if (fence) {
      where.leaseHolder = fence.leaseHolder;
      where.deliveryOrdinal = fence.deliveryOrdinal;
    }
    await (tx as any).outboxLease.updateMany({
      where,
      data: { deliveryStatus: status },
    });
  }

  private async bumpFailureCountFenced(
    tx: PrismaTx,
    outboxEventId: string,
    errorCode: string,
    fence?: LeaseFence,
  ): Promise<{ failureCount: number; deliveryOrdinal: number; leaseHolder: string | null } | null> {
    const where: Record<string, unknown> = { outboxEventId };
    if (fence) {
      where.leaseHolder = fence.leaseHolder;
      where.deliveryOrdinal = fence.deliveryOrdinal;
    }
    // Increment failure_count atomically
    const updated = await (tx as any).outboxLease.updateMany({
      where,
      data: {
        failureCount: { increment: 1 },
        lastErrorCode: errorCode,
      },
    });
    if ((updated?.count ?? 0) !== 1) return null;

    // Re-read for the new values
    const row = await (tx as any).outboxLease.findUnique({ where });
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
    await (tx as any).deliveryAttemptEvidence.create({
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
    await (tx as any).quarantineEvidence.create({
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
    const lease = row.lease as Record<string, unknown> | undefined;
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
