// A2-370 (AEV E03.03): runtime wiring for the MUN-0021 outbox relay.
//
// OutboxRelay is a plain class that is stopped when constructed. This provider
// constructs ONE relay per API process, binds it to the one real consumer
// (WorkOutcomeLedgerConsumer) and — only when OUTBOX_RELAY_ENABLED is exactly
// "true" — resumes it and runs cycle() on an interval. With the flag unset
// (the default, and production's state when this shipped) nothing polls,
// nothing leases, and pending events stay pending exactly as before.
//
// Cycles never overlap within a process; across processes the relay's fenced
// leases already make concurrent relays safe.

import { hostname } from 'node:os';
import {
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { OutboxRelay, type TransactionalClient } from './outbox.relay.js';
import { WorkOutcomeLedgerConsumer } from './work-outcome-ledger.consumer.js';
import type { Clock, CycleResult, IdSource } from './outbox.types.js';

export const DEFAULT_RELAY_INTERVAL_MS = 5_000;
const MIN_RELAY_INTERVAL_MS = 1_000;

export function relayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OUTBOX_RELAY_ENABLED === 'true';
}

export function relayIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OUTBOX_RELAY_INTERVAL_MS ?? DEFAULT_RELAY_INTERVAL_MS);
  return Number.isSafeInteger(raw) && raw >= MIN_RELAY_INTERVAL_MS
    ? raw
    : DEFAULT_RELAY_INTERVAL_MS;
}

export class OutboxRelayWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayWorker.name);
  readonly relay: OutboxRelay;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<CycleResult> | null = null;

  constructor(
    prisma: PrismaService,
    readonly consumer: WorkOutcomeLedgerConsumer,
    clock: Clock,
    idSource: IdSource,
  ) {
    this.relay = new OutboxRelay(
      prisma as unknown as TransactionalClient,
      clock,
      idSource,
      { relayId: `muneral-api:${hostname()}:${process.pid}`.slice(0, 128) },
    );
  }

  onApplicationBootstrap(): void {
    if (!relayEnabled()) {
      this.logger.log('outbox relay wired, disabled (OUTBOX_RELAY_ENABLED != "true")');
      return;
    }
    void this.relay.resume();
    const interval = relayIntervalMs();
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
    this.logger.log(`outbox relay enabled, consumer=${this.consumer.consumerId}, interval=${interval}ms`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.relay.stop();
    if (this.inFlight) await this.inFlight.catch(() => void 0);
  }

  /** One relay cycle; skipped (null) while the previous one is still running. */
  async tick(): Promise<CycleResult | null> {
    if (this.inFlight) return null;
    this.inFlight = this.relay.cycle(this.consumer);
    try {
      const result = await this.inFlight;
      if (result.polled > 0) {
        this.logger.log(`outbox cycle ${JSON.stringify(result)}`);
      }
      return result;
    } catch (err) {
      this.logger.error(`outbox cycle failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      this.inFlight = null;
    }
  }
}
