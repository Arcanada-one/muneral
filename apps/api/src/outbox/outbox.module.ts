// A2-370 (AEV E03.03): Nest wiring for the outbox relay and its consumer.
import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  SYSTEM_CLOCK,
  UUID_ID_SOURCE,
} from '../execution-authority/execution-authority.module.js';
import { OutboxRelayWorker } from './outbox-relay.worker.js';
import { WorkOutcomeLedgerConsumer } from './work-outcome-ledger.consumer.js';

@Module({
  imports: [PrismaModule],
  providers: [
    {
      provide: WorkOutcomeLedgerConsumer,
      useFactory: () => new WorkOutcomeLedgerConsumer(UUID_ID_SOURCE),
    },
    {
      provide: OutboxRelayWorker,
      useFactory: (prisma: PrismaService, consumer: WorkOutcomeLedgerConsumer) =>
        new OutboxRelayWorker(prisma, consumer, SYSTEM_CLOCK, UUID_ID_SOURCE),
      inject: [PrismaService, WorkOutcomeLedgerConsumer],
    },
  ],
  exports: [OutboxRelayWorker],
})
export class OutboxModule {}
