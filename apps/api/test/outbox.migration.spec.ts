// MUN-0021: Outbox relay migration — static contract tests.
// Verifies the schema shape, append-only triggers, CHECK constraints,
// foreign keys, indexes, and forward-only rollback fingerprint.
// No database connection required — reads the migration SQL and schema
// from disk.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const apiRoot = join(__dirname, '..');
const migration = readFileSync(
  join(
    apiRoot,
    'prisma/migrations/20260730010000_add_outbox_relay/migration.sql',
  ),
  'utf8',
);
const rollback = readFileSync(
  join(
    apiRoot,
    'prisma/migrations/20260730010000_add_outbox_relay/rollback.sql',
  ),
  'utf8',
);
const schema = readFileSync(join(apiRoot, 'prisma/schema.prisma'), 'utf8');

describe('Outbox relay migration', () => {
  // -------------------------------------------------------------------------
  // Schema: models exist in Prisma schema
  // -------------------------------------------------------------------------

  describe('Prisma schema — outbox models', () => {
    it('defines TaskOutboxEvent with all required fields', () => {
      expect(schema).toContain('model TaskOutboxEvent');
      expect(schema).toContain('task_outbox_events');
      // Required fields
      for (const field of [
        'id               String   @id @db.Uuid',
        'taskId           String   @map("task_id") @db.Uuid',
        'aggregateVersion BigInt   @map("aggregate_version")',
        'attemptId        String   @map("attempt_id") @db.Uuid',
        'transitionId     String   @unique @map("transition_id") @db.Uuid',
        'eventType        String   @map("event_type")',
        'eventPayload     Json     @map("event_payload")',
        'recordedAt       DateTime @map("recorded_at")',
      ]) {
        expect(schema).toContain(field);
      }
    });

    it('defines OutboxLease with fence fields', () => {
      expect(schema).toContain('model OutboxLease');
      expect(schema).toContain('outbox_leases');
      for (const field of [
        'outboxEventId  String    @id @map("outbox_event_id")',
        'leaseHolder    String?   @map("lease_holder")',
        'leaseAcquiredAt DateTime? @map("lease_acquired_at")',
        'leaseExpiresAt DateTime? @map("lease_expires_at")',
        'deliveryStatus String    @map("delivery_status")',
        'deliveryOrdinal Int      @map("delivery_ordinal")',
        'failureCount   Int       @map("failure_count")',
        'lastErrorCode  String?   @map("last_error_code")',
      ]) {
        expect(schema).toContain(field);
      }
    });

    it('defines DeliveryAttemptEvidence as append-only', () => {
      expect(schema).toContain('model DeliveryAttemptEvidence');
      expect(schema).toContain('delivery_attempt_evidence');
      for (const field of [
        'id             String    @id @db.Uuid',
        'outboxEventId  String    @map("outbox_event_id")',
        'deliveryOrdinal Int      @map("delivery_ordinal")',
        'disposition    String',
        'consumerDigest String?   @map("consumer_digest")',
        'errorDetail    Json?     @map("error_detail")',
        'attemptedAt    DateTime  @map("attempted_at")',
      ]) {
        expect(schema).toContain(field);
      }
    });

    it('defines QuarantineEvidence with unique outbox_event_id', () => {
      expect(schema).toContain('model QuarantineEvidence');
      expect(schema).toContain('quarantine_evidence');
      expect(schema).toContain('@@unique([outboxEventId])');
    });

    it('defines ConsumerInbox with composite primary key', () => {
      expect(schema).toContain('model ConsumerInbox');
      expect(schema).toContain('consumer_inbox');
      expect(schema).toContain('@@id([consumerId, outboxEventId])');
      expect(schema).toContain('@@unique([consumerId, outboxEventId])');
    });

    it('TaskOutboxEvent has relations to Task, Attempt, Transition, Lease, DeliveryAttempts, Quarantines, Inbox', () => {
      const model = schema.match(
        /model TaskOutboxEvent \{[\s\S]*?\n\}/,
      );
      expect(model).not.toBeNull();
      expect(model![0]).toContain('task       Task');
      expect(model![0]).toContain('attempt    TaskExecutionAttempt');
      expect(model![0]).toContain('transition TaskExecutionTransition');
      expect(model![0]).toContain('lease      OutboxLease?');
      expect(model![0]).toContain('deliveryAttempts DeliveryAttemptEvidence[]');
      expect(model![0]).toContain('quarantines      QuarantineEvidence[]');
      expect(model![0]).toContain('inboxEntries     ConsumerInbox[]');
    });

    it('retains existing Task model fields without replacement', () => {
      // The outbox migration must be additive — no existing model is altered.
      expect(schema).toContain('status        String   @default("todo")');
      expect(schema).toContain('model TaskExecutionState');
      expect(schema).toContain('model TaskExecutionAttempt');
      expect(schema).toContain('model TaskExecutionTransition');
    });
  });

  // -------------------------------------------------------------------------
  // Migration SQL: table creation
  // -------------------------------------------------------------------------

  describe('Migration SQL — table creation', () => {
    it('creates all five outbox-relay tables', () => {
      expect(migration).toContain(
        'CREATE TABLE public.task_outbox_events',
      );
      expect(migration).toContain(
        'CREATE TABLE public.outbox_leases',
      );
      expect(migration).toContain(
        'CREATE TABLE public.delivery_attempt_evidence',
      );
      expect(migration).toContain(
        'CREATE TABLE public.quarantine_evidence',
      );
      expect(migration).toContain(
        'CREATE TABLE public.consumer_inbox',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Migration SQL: CHECK constraints
  // -------------------------------------------------------------------------

  describe('Migration SQL — CHECK constraints', () => {
    it('enforces aggregate_version > 0 on task_outbox_events', () => {
      expect(migration).toMatch(
        /task_outbox_events_version_check\s+CHECK \(aggregate_version > 0\)/,
      );
    });

    it('enforces valid event_type values on task_outbox_events', () => {
      expect(migration).toContain("'task:completed'");
      expect(migration).toContain("'task:failed'");
      expect(migration).toContain("'task:terminal_failed'");
      expect(migration).toContain("'task:cancelled'");
    });

    it('enforces delivery_status values on outbox_leases', () => {
      expect(migration).toMatch(
        /outbox_leases_status_check[\s\S]*CHECK \(delivery_status IN \('pending', 'leased', 'delivered', 'quarantined'\)\)/,
      );
    });

    it('enforces delivery_ordinal >= 0 on outbox_leases', () => {
      expect(migration).toMatch(
        /outbox_leases_ordinal_check\s+CHECK \(delivery_ordinal >= 0\)/,
      );
    });

    it('enforces failure_count >= 0 on outbox_leases', () => {
      expect(migration).toMatch(
        /outbox_leases_failure_count_check\s+CHECK \(failure_count >= 0\)/,
      );
    });

    it('enforces lease_expires_at > lease_acquired_at on outbox_leases', () => {
      expect(migration).toMatch(
        /outbox_leases_expiry_order_check[\s\S]*lease_expires_at > lease_acquired_at/,
      );
    });

    it('enforces disposition values on delivery_attempt_evidence', () => {
      expect(migration).toMatch(
        /delivery_attempt_evidence_disposition_check[\s\S]*CHECK \(disposition IN \('delivered', 'quarantined', 'expired'\)\)/,
      );
    });

    it('enforces delivery_ordinal >= 0 on delivery_attempt_evidence', () => {
      expect(migration).toMatch(
        /delivery_attempt_evidence_ordinal_check\s+CHECK \(delivery_ordinal >= 0\)/,
      );
    });

    it('enforces failure_count >= 1 on quarantine_evidence', () => {
      expect(migration).toMatch(
        /quarantine_evidence_failure_count_check\s+CHECK \(failure_count >= 1\)/,
      );
    });

    it('enforces delivery_ordinal >= 0 on quarantine_evidence', () => {
      expect(migration).toMatch(
        /quarantine_evidence_ordinal_check\s+CHECK \(delivery_ordinal >= 0\)/,
      );
    });

    it('enforces outbox_event_id uniqueness on quarantine_evidence', () => {
      expect(migration).toMatch(
        /quarantine_evidence_outbox_unique\s+UNIQUE \(outbox_event_id\)/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Migration SQL: foreign keys (RESTRICT — no silent cascade-delete)
  // -------------------------------------------------------------------------

  describe('Migration SQL — foreign keys', () => {
    it('adds FK from task_outbox_events to tasks with RESTRICT', () => {
      expect(migration).toMatch(
        /task_outbox_events_task_id_fkey[\s\S]*FOREIGN KEY \(task_id\)[\s\S]*REFERENCES public\.tasks\(id\)[\s\S]*ON DELETE RESTRICT/,
      );
    });

    it('adds composite FK from task_outbox_events to task_execution_attempts with RESTRICT', () => {
      expect(migration).toMatch(
        /task_outbox_events_attempt_task_fkey[\s\S]*FOREIGN KEY \(attempt_id, task_id\)[\s\S]*REFERENCES public\.task_execution_attempts\(attempt_id, task_id\)[\s\S]*ON DELETE RESTRICT/,
      );
    });

    it('adds FK from task_outbox_events to task_execution_transitions with RESTRICT', () => {
      expect(migration).toMatch(
        /task_outbox_events_transition_fkey[\s\S]*FOREIGN KEY \(transition_id\)[\s\S]*REFERENCES public\.task_execution_transitions\(id\)[\s\S]*ON DELETE RESTRICT/,
      );
    });

    it('adds FK from outbox_leases to task_outbox_events with RESTRICT', () => {
      expect(migration).toMatch(
        /outbox_leases_outbox_fkey[\s\S]*FOREIGN KEY \(outbox_event_id\)[\s\S]*REFERENCES public\.task_outbox_events\(id\)[\s\S]*ON DELETE RESTRICT/,
      );
    });

    it('adds FK from delivery_attempt_evidence to task_outbox_events with RESTRICT', () => {
      expect(migration).toMatch(
        /delivery_attempt_evidence_outbox_fkey[\s\S]*FOREIGN KEY \(outbox_event_id\)[\s\S]*REFERENCES public\.task_outbox_events\(id\)[\s\S]*ON DELETE RESTRICT/,
      );
    });

    it('adds FK from quarantine_evidence to task_outbox_events with RESTRICT', () => {
      expect(migration).toMatch(
        /quarantine_evidence_outbox_fkey[\s\S]*FOREIGN KEY \(outbox_event_id\)[\s\S]*REFERENCES public\.task_outbox_events\(id\)[\s\S]*ON DELETE RESTRICT/,
      );
    });

    it('adds FK from consumer_inbox to task_outbox_events with RESTRICT', () => {
      expect(migration).toMatch(
        /consumer_inbox_outbox_fkey[\s\S]*FOREIGN KEY \(outbox_event_id\)[\s\S]*REFERENCES public\.task_outbox_events\(id\)[\s\S]*ON DELETE RESTRICT/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Migration SQL: indexes
  // -------------------------------------------------------------------------

  describe('Migration SQL — indexes', () => {
    it('creates index on task_outbox_events(task_id)', () => {
      expect(migration).toMatch(
        /idx_task_outbox_events_task_id[\s\S]*ON public\.task_outbox_events\(task_id\)/,
      );
    });

    it('creates index on task_outbox_events(attempt_id)', () => {
      expect(migration).toMatch(
        /idx_task_outbox_events_attempt_id[\s\S]*ON public\.task_outbox_events\(attempt_id\)/,
      );
    });

    it('creates index on task_outbox_events(recorded_at)', () => {
      expect(migration).toMatch(
        /idx_task_outbox_events_recorded_at[\s\S]*ON public\.task_outbox_events\(recorded_at\)/,
      );
    });

    it('creates index on delivery_attempt_evidence(outbox_event_id)', () => {
      expect(migration).toMatch(
        /idx_delivery_attempt_evidence_outbox[\s\S]*ON public\.delivery_attempt_evidence\(outbox_event_id\)/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Migration SQL: append-only trigger guards
  // -------------------------------------------------------------------------

  describe('Migration SQL — append-only trigger guards', () => {
    const appendOnlyTables = [
      'task_outbox_events',
      'delivery_attempt_evidence',
      'quarantine_evidence',
      'consumer_inbox',
    ];

    for (const table of appendOnlyTables) {
      it(`creates an append-only guard function for ${table}`, () => {
        const funcName = `${table}_guard`;
        expect(migration).toContain(
          `CREATE FUNCTION public.${funcName}()`,
        );
      });

      it(`${table} guard rejects UPDATE with MUN00 errcode`, () => {
        expect(migration).toContain(
          `${table} is append-only: UPDATE rejected`,
        );
      });

      it(`${table} guard rejects DELETE with MUN00 errcode`, () => {
        expect(migration).toContain(
          `${table} is append-only: DELETE rejected`,
        );
      });

      it(`creates BEFORE UPDATE OR DELETE trigger on ${table}`, () => {
        const triggerName = `${table}_append_only`;
        expect(migration).toContain(
          `CREATE TRIGGER ${triggerName}`,
        );
        expect(migration).toMatch(
          new RegExp(
            `BEFORE UPDATE OR DELETE ON public\\.${table.replace(/_/g, '\\_')}[\\s\\S]*EXECUTE FUNCTION public\\.${table.replace(/_/g, '\\_')}_guard\\(\\)`,
          ),
        );
      });

      it(`${table} guard is hardened with SECURITY DEFINER and pg_catalog search_path`, () => {
        const tableBlock = migration.split(
          `CREATE FUNCTION public.${table}_guard()`,
        )[1]?.split('$function$')[0] ?? '';
        expect(tableBlock).toContain('SECURITY DEFINER');
        expect(tableBlock).toContain("SET search_path = pg_catalog");
      });

      it(`revokes public access to ${table} guard function`, () => {
        expect(migration).toContain(
          `REVOKE ALL ON FUNCTION public.${table}_guard() FROM PUBLIC;`,
        );
      });
    }

    it('outbox_leases does NOT have an append-only trigger (it is mutable)', () => {
      expect(migration).not.toMatch(/outbox_leases_append_only/);
      expect(migration).not.toContain('CREATE FUNCTION public.outbox_leases_guard()');
    });
  });

  // -------------------------------------------------------------------------
  // Migration SQL: additive-only — no backfill or existing-row mutation
  // -------------------------------------------------------------------------

  describe('Migration SQL — additive-only', () => {
    it('does not backfill or mutate existing rows', () => {
      expect(migration).not.toMatch(/INSERT INTO|UPDATE public\.\w+\b/i);
    });

    it('does not drop any existing tables or constraints', () => {
      expect(migration).not.toMatch(/\bDROP\s+(TABLE|TRIGGER|FUNCTION|INDEX|CONSTRAINT)\b/i);
    });
  });

  // -------------------------------------------------------------------------
  // Rollback: forward-only refusal
  // -------------------------------------------------------------------------

  describe('Rollback — forward-only refusal fingerprint', () => {
    it('is an unconditional forward-only refusal', () => {
      expect(rollback).toContain('MUN-0021 migration is forward-only');
      expect(rollback).toContain('cannot be rolled back');
    });

    it('mentions append-only tables as the reason', () => {
      expect(rollback).toContain('append-only outbox');
      expect(rollback).toContain('delivery-evidence');
      expect(rollback).toContain('quarantine tables');
    });

    it('advises database drop for disposable test environments', () => {
      expect(rollback).toContain('Drop the database');
    });

    it('has no DROP statements of any kind', () => {
      expect(rollback).not.toMatch(/\bDROP\s+(TABLE|TRIGGER|FUNCTION|INDEX|CONSTRAINT|SCHEMA)\b/i);
    });

    it('uses a DO block that unconditionally RAISEs', () => {
      expect(rollback).toContain('DO $$');
      expect(rollback).toContain('RAISE EXCEPTION');
    });
  });

  // -------------------------------------------------------------------------
  // Uniqueness constraints on task_outbox_events
  // -------------------------------------------------------------------------

  describe('Migration SQL — uniqueness constraints', () => {
    it('enforces transition_id uniqueness on task_outbox_events', () => {
      expect(migration).toMatch(
        /task_outbox_events_transition_unique\s+UNIQUE \(transition_id\)/,
      );
    });

    it('enforces (task_id, transition_id) uniqueness on task_outbox_events', () => {
      expect(migration).toMatch(
        /task_outbox_events_task_transition_unique\s+UNIQUE \(task_id, transition_id\)/,
      );
    });

    it('enforces (consumer_id, outbox_event_id) uniqueness on consumer_inbox', () => {
      expect(migration).toMatch(
        /consumer_inbox_consumer_event_unique\s+UNIQUE \(consumer_id, outbox_event_id\)/,
      );
    });
  });
});
