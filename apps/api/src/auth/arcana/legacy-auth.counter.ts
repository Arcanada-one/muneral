import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

export type LegacySurface = 'http' | 'ws';

export const LEGACY_REPORT_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Counts requests authenticated by the legacy HS256 verifier, so that its removal can be decided
 * on a reading and not on an assumption. It holds numbers only: no token, no user, no address.
 * `mun_sk_` API keys are not legacy sign-in and are never counted.
 *
 * Each window is logged, zeros included, so that "no legacy use" is a line that can be read and
 * is distinct from "nothing was reported". The first use of a surface is also logged at once.
 * Counts live in memory: a restart loses at most the unreported window.
 */
@Injectable()
export class LegacyAuthCounter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('LegacyAuthCounter');
  private window: Record<LegacySurface, number> = { http: 0, ws: 0 };
  private readonly total: Record<LegacySurface, number> = { http: 0, ws: 0 };
  private timer?: ReturnType<typeof setInterval>;

  onModuleInit(): void {
    this.timer = setInterval(() => this.report(), LEGACY_REPORT_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  record(surface: LegacySurface): void {
    this.window[surface] += 1;
    this.total[surface] += 1;
    if (this.total[surface] === 1) {
      this.logger.log(`legacy_auth_verified first_since_start surface=${surface}`);
    }
  }

  /** Log the current window and start a new one. */
  report(): void {
    this.logger.log(
      `legacy_auth_verified window_http=${this.window.http} window_ws=${this.window.ws} ` +
        `since_start_http=${this.total.http} since_start_ws=${this.total.ws}`,
    );
    this.window = { http: 0, ws: 0 };
  }
}
