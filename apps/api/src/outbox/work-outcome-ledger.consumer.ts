// A2-370 (AEV E03.03): the first real OutboxConsumer.
//
// `work.outcome.recorded` in the AEV event contract (arcanada-universal-program
// contracts/autonomous-evolution/events.v1.json) rides the Muneral outbox as
// task:completed / task:failed / task:terminal_failed / task:cancelled, with
// TaskOutboxEvent.id as its idempotency key. This consumer turns each such
// event into one work_outcome_records row — the read model Evolutio and
// Probatio are named as consumers of. attempt:* events are acknowledged
// without an effect (transport consumers may ignore event kinds they do not
// need — outbox.types.ts).
//
// It runs inside the relay's transaction: the row, the consumer_inbox row and
// the delivered lease commit together or not at all. Deduplication is the
// relay's inbox check against consumer_inbox (consumerId, outboxEventId); this
// class does not deduplicate on its own, by design — see the migration.

import { createHash } from 'node:crypto';
import type {
  ConsumerResult,
  IdSource,
  OutboxConsumer,
  OutboxEvent,
  OutboxEventType,
} from './outbox.types.js';

export const WORK_OUTCOME_LEDGER_CONSUMER_ID = 'work-outcome-ledger';

export const WORK_OUTCOME_EVENT_TYPES: ReadonlySet<OutboxEventType> = new Set([
  'task:completed',
  'task:failed',
  'task:terminal_failed',
  'task:cancelled',
]);

function sha256Hex(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class WorkOutcomeLedgerConsumer implements OutboxConsumer {
  readonly consumerId = WORK_OUTCOME_LEDGER_CONSUMER_ID;

  constructor(private readonly idSource: IdSource) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async consume(event: OutboxEvent, tx: any): Promise<ConsumerResult> {
    if (!WORK_OUTCOME_EVENT_TYPES.has(event.eventType)) {
      return {
        digest: sha256Hex({ consumer: this.consumerId, ignored: event.eventType, event: event.id }),
        result: { effect: 'none', eventType: event.eventType },
      };
    }

    const record = {
      id: this.idSource.generate(),
      outboxEventId: event.id,
      taskId: event.taskId,
      attemptId: event.attemptId,
      eventType: event.eventType,
      aggregateVersion: BigInt(event.aggregateVersion),
      idempotencyKey: event.eventPayload.idempotencyKey,
      outcomeRecordedAt: event.recordedAt,
      consumedAt: new Date(),
    };
    await tx.workOutcomeRecord.create({ data: record });

    return {
      digest: sha256Hex({
        consumer: this.consumerId,
        outboxEventId: record.outboxEventId,
        taskId: record.taskId,
        eventType: record.eventType,
        aggregateVersion: String(record.aggregateVersion),
        idempotencyKey: record.idempotencyKey,
      }),
      result: { effect: 'work_outcome_record', recordId: record.id },
    };
  }
}
