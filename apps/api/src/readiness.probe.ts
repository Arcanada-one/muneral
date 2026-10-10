import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

export const READINESS_TIMEOUT_MS = 1000;
type ProbeClient = Pick<PrismaClient, '$queryRaw' | '$disconnect'>;

/** One lazy, read-only connection; a stalled probe cannot queue more database work. */
@Injectable()
export class ReadinessProbe implements OnModuleDestroy {
  private client?: ProbeClient;
  private pending?: Promise<void>;

  static withClient(client: ProbeClient): ReadinessProbe {
    const probe = new ReadinessProbe();
    probe.client = client;
    return probe;
  }

  private getClient(): ProbeClient {
    if (!this.client) {
      this.client = new PrismaClient({
        adapter: new PrismaPg({
          connectionString: process.env.DATABASE_URL,
          max: 1,
          connectionTimeoutMillis: 500,
          query_timeout: 500,
          statement_timeout: 500,
          options: '-c default_transaction_read_only=on',
        }),
      });
    }
    return this.client;
  }

  async check(): Promise<void> {
    if (!this.pending) {
      // No application tables, data reads, migrations or writes. Driver/server
      // deadlines bound database work; the outer deadline bounds the HTTP wait.
      this.pending = this.getClient().$queryRaw`SELECT 1`
        .then(() => undefined)
        .finally(() => { this.pending = undefined; });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('readiness deadline')), READINESS_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.$disconnect();
  }
}
