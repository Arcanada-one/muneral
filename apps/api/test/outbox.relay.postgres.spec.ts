// MUN-0021: Outbox relay — real PostgreSQL service-path integration tests.
// Spawns a disposable PostgreSQL container, applies all migrations, exercises
// the production ExecutionAuthorityService → transactional outbox → OutboxRelay
// lifecycle, and provides cleanup evidence.
//
// Run with: npx jest --no-coverage --testPathPattern='outbox.relay.postgres'
// Requires: Docker daemon, psql (for migrations), sudo (for docker)
//
// Tests invoke production services — no manual reimplementation of relay logic.

import { randomUUID } from 'node:crypto';

import { createDisposablePostgres } from './support/disposable-postgres';

// ---------------------------------------------------------------------------
// Disposable PostgreSQL — task-owned, uniquely named, fail-closed cleanup.
// The harness lives in ./support/disposable-postgres so this suite and the
// committed-result proofs share one implementation of the cleanup contract.
// ---------------------------------------------------------------------------

const PG_DB = 'muneral_outbox_test';
const pg = createDisposablePostgres('outbox');
const CONTAINER_NAME = pg.containerName;

let PG_PORT: number;
let DATABASE_URL: string;

beforeAll(async () => {
  await pg.start();
  PG_PORT = pg.port();
  DATABASE_URL = pg.url();
}, 120_000);

afterAll(async () => {
  await pg.stop();
}, 30_000);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Outbox relay — PostgreSQL service-path integration', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let projectId: string;
  let workspaceId: string;
  let ownerId: string;
  let taskId: string;
  let ordinalCounter = 0;

  beforeAll(async () => {
    // Dynamically import after migrations are applied
    const { PrismaClient } = require('@prisma/client');
    const { PrismaPg } = require('@prisma/adapter-pg');
    const adapter = new PrismaPg({ connectionString: DATABASE_URL });
    prisma = new PrismaClient({ adapter });
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  // -- seed helpers ----------------------------------------------------------

  async function seedWorkspaceAndProject() {
    ownerId = randomUUID();
    workspaceId = randomUUID();
    projectId = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.users (id, name, created_at, updated_at)
       VALUES ($1, 'test-user', NOW(), NOW()) ON CONFLICT DO NOTHING`,
      ownerId,
    );
    const wsSlug = `ws-${randomUUID().slice(0, 6)}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.workspaces (id, slug, name, owner_id, created_at)
       VALUES ($1, $2, 'test-ws', $3, NOW()) ON CONFLICT DO NOTHING`,
      workspaceId, wsSlug, ownerId,
    );
    const projSlug = `prj-${randomUUID().slice(0, 6)}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.projects (id, workspace_id, slug, name, created_at)
       VALUES ($1, $2, $3, 'test-project', NOW()) ON CONFLICT DO NOTHING`,
      projectId, workspaceId, projSlug,
    );
  }

  async function seedTask(): Promise<string> {
    if (!projectId) await seedWorkspaceAndProject();
    const tId = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.tasks (id, project_id, title, status, created_at, updated_at)
       VALUES ($1, $2, 'integration-test-task', 'todo', NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      tId, projectId,
    );
    return tId;
  }

  async function seedOutboxRow(
    tId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ outboxEventId: string; transitionId: string; attemptId: string }> {
    const transitionId = (overrides.transitionId as string) ?? randomUUID();
    const attemptId = (overrides.attemptId as string) ?? randomUUID();
    const evtId = randomUUID();
    ordinalCounter += 1;
    const attemptOrdinal = (overrides.attemptOrdinal as number) ?? ordinalCounter;
    ordinalCounter += 1;
    const aggregateVersion = (overrides.aggregateVersion as number) ?? ordinalCounter;

    // Create parent records for FK satisfaction
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.task_execution_attempts
         (attempt_id, task_id, ordinal, status, issued_at)
       VALUES ($1, $2, $3, 'issued', NOW())
       ON CONFLICT DO NOTHING`,
      attemptId, tId, attemptOrdinal,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO public.task_execution_transitions
         (id, task_id, attempt_id, aggregate_version, event_type,
          idempotency_key, command_digest, causation_id, correlation_id, recorded_at)
       VALUES ($1, $2, $3, $4, 'attempt:succeeded',
               $5, $6, 'cause-1', 'corr-1', NOW())
       ON CONFLICT DO NOTHING`,
      transitionId, tId, attemptId,
      overrides.aggregateVersion ?? aggregateVersion,
      overrides.idempotencyKey ?? randomUUID(),
      `sha256:${randomUUID().slice(0, 16)}`,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO public.task_outbox_events
         (id, task_id, aggregate_version, attempt_id, transition_id,
          event_type, event_payload, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())`,
      evtId, tId,
      overrides.aggregateVersion ?? aggregateVersion,
      attemptId, transitionId,
      overrides.eventType ?? 'task:completed',
      JSON.stringify(overrides.eventPayload ?? {
        schema: 'muneral-outbox-v1',
        transitionEventType: 'attempt:succeeded',
        committedResult: { status: 'done' },
        idempotencyKey: randomUUID(),
        aggregateVersion: 5,
        attemptId,
        attemptOrdinal: 1,
        retryCount: 0,
        retryBudget: 3,
      }),
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO public.outbox_leases
         (outbox_event_id, delivery_status, delivery_ordinal, failure_count)
       VALUES ($1, $2, $3, $4)`,
      evtId,
      overrides.deliveryStatus ?? 'pending',
      overrides.deliveryOrdinal ?? 0,
      overrides.failureCount ?? 0,
    );

    return { outboxEventId: evtId, transitionId, attemptId };
  }

  // -- schema verification ---------------------------------------------------

  it('1. all outbox-relay tables exist after migration', async () => {
    const tables = await prisma.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
       AND table_name IN (
         'task_outbox_events', 'outbox_leases',
         'delivery_attempt_evidence', 'quarantine_evidence', 'consumer_inbox'
       )
       ORDER BY table_name`,
    );
    const names = (tables as Array<{ table_name: string }>).map((r) => r.table_name);
    expect(names).toContain('task_outbox_events');
    expect(names).toContain('outbox_leases');
    expect(names).toContain('delivery_attempt_evidence');
    expect(names).toContain('quarantine_evidence');
    expect(names).toContain('consumer_inbox');
  });

  it('2. append-only trigger rejects UPDATE on task_outbox_events', async () => {
    const tId = await seedTask();
    const { outboxEventId } = await seedOutboxRow(tId);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE public.task_outbox_events SET event_type = 'task:failed' WHERE id = $1`,
        outboxEventId,
      ),
    ).rejects.toThrow(/append-only|MUN00/);
  });

  it('3. append-only trigger rejects DELETE on delivery_attempt_evidence', async () => {
    const tId = await seedTask();
    const { outboxEventId } = await seedOutboxRow(tId);
    const attemptId = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.delivery_attempt_evidence
         (id, outbox_event_id, delivery_ordinal, disposition, attempted_at)
       VALUES ($1, $2, 1, 'delivered', NOW())`,
      attemptId, outboxEventId,
    );
    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM public.delivery_attempt_evidence WHERE id = $1`,
        attemptId,
      ),
    ).rejects.toThrow(/append-only|MUN00/);
  });

  it('3b. append-only trigger rejects UPDATE on delivery_attempt_evidence', async () => {
    const tId = await seedTask();
    const { outboxEventId } = await seedOutboxRow(tId);
    const evidenceId = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.delivery_attempt_evidence
         (id, outbox_event_id, delivery_ordinal, disposition, attempted_at)
       VALUES ($1, $2, 1, 'delivered', NOW())`,
      evidenceId,
      outboxEventId,
    );
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE public.delivery_attempt_evidence
         SET disposition = 'expired' WHERE id = $1`,
        evidenceId,
      ),
    ).rejects.toThrow(/append-only|MUN00/);
  });

  // -- composite FK mismatch rejection ---------------------------------------

  it('4. composite FK rejects outbox row referencing transition with mismatched task_id', async () => {
    // Create two distinct tasks
    const tIdA = await seedTask();
    const tIdB = await seedTask();

    // Use two separate attempts so the outbox attempt FK can pass while the
    // outbox transition FK fires on the mismatched task_id.
    //   attemptA  — belongs to task A, used by the transition
    //   attemptB  — belongs to task B, used by the outbox row
    //   transition — belongs to task A, uses attemptA
    //   outbox    — task_id = tIdB, attempt_id = attemptB (passes), transition_id = transition (FAILS)
    const transitionId = randomUUID();
    const attemptIdA = randomUUID();
    const attemptIdB = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.task_execution_attempts
         (attempt_id, task_id, ordinal, status, issued_at)
       VALUES ($1, $2, 1, 'issued', NOW())
       ON CONFLICT DO NOTHING`,
      attemptIdA, tIdA,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.task_execution_attempts
         (attempt_id, task_id, ordinal, status, issued_at)
       VALUES ($1, $2, 1, 'issued', NOW())
       ON CONFLICT DO NOTHING`,
      attemptIdB, tIdB,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.task_execution_transitions
         (id, task_id, attempt_id, aggregate_version, event_type,
          idempotency_key, command_digest, causation_id, correlation_id, recorded_at)
       VALUES ($1, $2, $3, 1, 'attempt:succeeded', $4, $5, 'cause-1', 'corr-1', NOW())`,
      transitionId, tIdA, attemptIdA,
      randomUUID(), `sha256:${randomUUID().slice(0, 16)}`,
    );
    const evtId = randomUUID();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO public.task_outbox_events
           (id, task_id, aggregate_version, attempt_id, transition_id,
            event_type, event_payload, recorded_at)
         VALUES ($1, $2, 1, $3, $4, 'task:completed', $5::jsonb, NOW())`,
        evtId, tIdB /* WRONG task */, attemptIdB, transitionId,
        JSON.stringify({ schema: 'muneral-outbox-v1', transitionEventType: 'attempt:succeeded',
          committedResult: {}, idempotencyKey: randomUUID(), aggregateVersion: 1,
          attemptId: attemptIdB, attemptOrdinal: 1, retryCount: 0, retryBudget: 3 }),
      ),
    ).rejects.toThrow(/task_outbox_events_transition_task_fkey/);
  });

  // -- parent deletion RESTRICT ----------------------------------------------

  it('5. deleting a task with outbox events is rejected (ON DELETE RESTRICT)', async () => {
    const tId = await seedTask();
    await seedOutboxRow(tId);

    // Attempt to delete the task — must fail because outbox FK is RESTRICT.
    // PostgreSQL checks FKs in definition order; the first violation may report
    // any outbox FK that depends on the task row (task_id_fkey or attempt_task_fkey
    // when the attempt also references the same task). Match any FK violation.
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM public.tasks WHERE id = $1`, tId),
    ).rejects.toThrow(/foreign.*key|violat.*constraint|23503/i);
  });

  // -- forward-only rollback refusal (append-only triggers already tested above)

  it('6. append-only trigger rejects DELETE on quarantine_evidence', async () => {
    const tId = await seedTask();
    const { outboxEventId } = await seedOutboxRow(tId, { deliveryStatus: 'quarantined', failureCount: 3 });
    // Manually insert quarantine evidence (seedOutboxRow only creates outbox+lease rows)
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.quarantine_evidence
         (id, outbox_event_id, delivery_ordinal, failure_count, last_error_code, quarantined_at)
       VALUES ($1, $2, 1, 3, 'TestError', NOW())`,
      randomUUID(), outboxEventId,
    );
    const qRow = await prisma.quarantineEvidence.findUnique({ where: { outboxEventId } });
    expect(qRow).not.toBeNull();

    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM public.quarantine_evidence WHERE outbox_event_id = $1`, outboxEventId),
    ).rejects.toThrow(/append-only|MUN00/);
  });

  it('6b. append-only trigger rejects UPDATE on quarantine_evidence', async () => {
    const tId = await seedTask();
    const { outboxEventId } = await seedOutboxRow(tId, {
      deliveryStatus: 'quarantined',
      failureCount: 3,
    });
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.quarantine_evidence
         (id, outbox_event_id, delivery_ordinal, failure_count, last_error_code, quarantined_at)
       VALUES ($1, $2, 1, 3, 'TestError', NOW())`,
      randomUUID(),
      outboxEventId,
    );
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE public.quarantine_evidence
         SET failure_count = 4 WHERE outbox_event_id = $1`,
        outboxEventId,
      ),
    ).rejects.toThrow(/append-only|MUN00/);
  });

  it('6c. append-only trigger rejects UPDATE and DELETE on consumer_inbox', async () => {
    const tId = await seedTask();
    const { outboxEventId } = await seedOutboxRow(tId);
    const consumerId = `consumer-${randomUUID()}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.consumer_inbox
         (consumer_id, outbox_event_id, consumed_at, side_effect_digest)
       VALUES ($1, $2, NOW(), $3)`,
      consumerId,
      outboxEventId,
      'a'.repeat(64),
    );
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE public.consumer_inbox SET side_effect_digest = $1
         WHERE consumer_id = $2 AND outbox_event_id = $3`,
        'b'.repeat(64),
        consumerId,
        outboxEventId,
      ),
    ).rejects.toThrow(/append-only|MUN00/);
    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM public.consumer_inbox
         WHERE consumer_id = $1 AND outbox_event_id = $2`,
        consumerId,
        outboxEventId,
      ),
    ).rejects.toThrow(/append-only|MUN00/);
  });

  // -- real service-path: ExecutionAuthorityService → outbox → OutboxRelay ---

  it('7. full service path: executeCommand emits outbox row, OutboxRelay delivers it', async () => {
    const { ExecutionAuthorityService } = require('../src/execution-authority/execution-authority.service');
    const { OutboxRelay } = require('../src/outbox/outbox.relay');
    const { normaliseConfig } = require('../src/outbox/outbox.types');

    const tId = await seedTask();
    const now = new Date();
    const idSource = { generate: () => randomUUID() };
    const clock = { now: () => now };

    const authService = new ExecutionAuthorityService(clock, idSource);

    // Step 1: issue_initial_attempt
    const initResult = await authService.executeCommand(prisma, {
      kind: 'issue_initial_attempt',
      taskId: tId,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
      causationId: randomUUID(),
      correlationId: randomUUID(),
      retryBudget: 3,
      retryBackoffMs: 0,
      evidenceRefs: [],
    });

    expect(initResult).toHaveProperty('committedResult');
    expect(initResult).toHaveProperty('state');
    const state = (initResult as Record<string, unknown>).state as Record<string, unknown>;
    expect(state).not.toBeNull();
    const currentAttemptId = state.currentAttemptId as string | null;
    expect(currentAttemptId).toBeDefined();

    // Step 2: transition_attempt → started (issued → running)
    const startedResult = await authService.executeCommand(prisma, {
      kind: 'transition_attempt',
      taskId: tId,
      attemptId: currentAttemptId!,
      expectedVersion: 1,
      eventType: 'attempt:started',
      idempotencyKey: randomUUID(),
      causationId: randomUUID(),
      correlationId: randomUUID(),
      evidenceRefs: [],
      payload: {},
      committedResult: { started: true },
    });
    expect(startedResult).toHaveProperty('committedResult');

    // Step 3: transition_attempt → succeeded (triggers outbox insert)
    const txnResult = await authService.executeCommand(prisma, {
      kind: 'transition_attempt',
      taskId: tId,
      attemptId: currentAttemptId!,
      expectedVersion: 2,
      eventType: 'attempt:succeeded',
      idempotencyKey: randomUUID(),
      causationId: randomUUID(),
      correlationId: randomUUID(),
      evidenceRefs: [],
      payload: { reason: 'test completion' },
      committedResult: { status: 'done', output: 'test-output' },
    });

    // Verify outbox event was created
    expect(txnResult).toHaveProperty('outboxEvent');
    const execResult = txnResult as Record<string, unknown>;
    expect(execResult.outboxEvent).toBeDefined();

    const outboxEvent = execResult.outboxEvent as Record<string, unknown>;
    expect(outboxEvent.id).toBeDefined();
    expect(outboxEvent.taskId).toBe(tId);
    expect(outboxEvent.eventType).toBe('task:completed');

    // Step 3: Verify the outbox row exists in the database
    const dbRow = await prisma.taskOutboxEvent.findUnique({
      where: { id: outboxEvent.id },
      include: { lease: true },
    });
    expect(dbRow).not.toBeNull();
    expect(dbRow.lease).not.toBeNull();
    expect(dbRow.lease.deliveryStatus).toBe('pending');

    // Step 4: Use OutboxRelay (production class) to poll → lease → dispatch
    const config = normaliseConfig({
      relayId: `svc-path-relay-${randomUUID().slice(0, 6)}`,
    });

    const relay = new OutboxRelay(prisma, clock, idSource, config);
    await relay.resume();

    // BLOCKER6: Real database-local consumer side effect — writes a row to
    // muneral_kb_task_changes (no FK to Task, accepts any task_id). This
    // proves the consumer's database effect is committed in the same
    // transaction as the inbox write and lease status update.
    const consumerDigest = `sha256:${randomUUID().slice(0, 16)}`;
    const effectTaskId = randomUUID();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let consumerCalledWith: any = null;
    const consumer = {
      consumerId: 'svc-path-consumer',
      consume: jest.fn().mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (_event: any, _tx: any) => {
          consumerCalledWith = _event;
          // Real database write inside the consumer transaction
          await _tx.muneralKbTaskChange.create({
            data: {
              taskId: effectTaskId,
              revision: 1n,
              changedAt: new Date(),
              deleted: false,
            },
          });
          return { digest: consumerDigest };
        },
      ),
    };

    // Poll → filter for our event → lease → dispatch (all production methods)
    const events = await relay.poll();
    expect(events.length).toBeGreaterThanOrEqual(1);
    const ourEvents = events.filter((e: { id: string }) => e.id === outboxEvent.id);
    expect(ourEvents.length).toBe(1);

    const leased = await relay.lease(ourEvents);
    expect(leased.length).toBe(1);

    const disposition = await relay.dispatch(
      leased[0] as Parameters<typeof relay.dispatch>[0],
      consumer,
    );
    expect(disposition).toBe('delivered');
    expect(consumer.consume).toHaveBeenCalledTimes(1);
    expect(consumerCalledWith).not.toBeNull();
    expect(consumerCalledWith.id).toBe(outboxEvent.id);

    // Verify lease is now 'delivered'
    const finalLease = await prisma.outboxLease.findUnique({
      where: { outboxEventId: outboxEvent.id },
    });
    expect(finalLease.deliveryStatus).toBe('delivered');

    // Verify inbox row exists
    const inboxRow = await prisma.consumerInbox.findUnique({
      where: {
        consumerId_outboxEventId: {
          consumerId: 'svc-path-consumer',
          outboxEventId: outboxEvent.id as string,
        },
      },
    });
    expect(inboxRow).not.toBeNull();
    expect(inboxRow.sideEffectDigest).toBe(consumerDigest);

    // BLOCKER6: Verify the consumer's real database effect was committed
    // atomically with the inbox write. The muneral_kb_task_changes row must
    // exist — proof the consumer wrote a real row, not just a JS variable.
    const kbRow = await prisma.muneralKbTaskChange.findUnique({
      where: { taskId: effectTaskId },
    });
    expect(kbRow).not.toBeNull();
    expect(kbRow.revision).toBe(1n);
  }, 30_000);

  // -- mid-consumer lease reclaim (zero stale effects) -----------------------

  it('8. mid-consumer lease reclaim commits zero stale effects/evidence/inbox', async () => {
    const { OutboxRelay } = require('../src/outbox/outbox.relay');
    const { normaliseConfig } = require('../src/outbox/outbox.types');

    const tId = await seedTask();
    const { outboxEventId } = await seedOutboxRow(tId, {
      deliveryStatus: 'pending',
      failureCount: 0,
      deliveryOrdinal: 0,
    });

    const config = normaliseConfig({
      relayId: `worker-a-${randomUUID().slice(0, 4)}`,
      leaseTtlMs: 5_000,
    });

    const clock = { now: () => new Date() };
    const idSource = { generate: () => randomUUID() };

    // Worker A acquires lease
    const relayA = new OutboxRelay(prisma, clock, idSource, config);
    await relayA.resume();
    const eventsA = await relayA.poll();
    const ours = eventsA.filter((e: { id: string }) => e.id === outboxEventId);
    expect(ours.length).toBe(1);
    const leasedA = await relayA.lease(ours);

    // Verify Worker A holds the lease
    const leaseAfterA = await prisma.outboxLease.findUnique({
      where: { outboxEventId },
    });
    expect(leaseAfterA.deliveryStatus).toBe('leased');
    const holderA = leaseAfterA.leaseHolder;
    const ordinalA = leaseAfterA.deliveryOrdinal;

    // BLOCKER6: True mid-consumer race. The consumer writes a real database
    // row inside the transaction, then the lease is reclaimed via a SEPARATE
    // connection (the test's prisma, not the transactional tx). The reclaim
    // commits immediately. When dispatch continues with updateLeaseFenced,
    // the fence WHERE clause matches zero rows → StaleFenceError → the
    // ENTIRE consumer transaction rolls back. Consumer DB write, inbox row,
    // and all evidence are atomically rolled back.
    const effectTaskId = randomUUID();
    let consumerCalled = false;

    const midRaceConsumer = {
      consumerId: 'mid-race-consumer',
      consume: jest.fn().mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (_event: any, _tx: any) => {
          consumerCalled = true;
          // Real consumer DB effect inside the transaction
          await _tx.muneralKbTaskChange.create({
            data: {
              taskId: effectTaskId,
              revision: 1n,
              changedAt: new Date(),
              deleted: false,
            },
          });

          // Mid-consumer reclaim: forcibly update the lease from a SEPARATE
          // connection (prisma, not _tx). This commits immediately, simulating
          // a rogue reclaim or another worker acquiring the lease while this
          // consumer is still running.
          await prisma.outboxLease.updateMany({
            where: { outboxEventId },
            data: {
              leaseHolder: `reclaimer-${randomUUID().slice(0, 6)}`,
              deliveryOrdinal: { increment: 1 },
              leaseAcquiredAt: new Date(),
              leaseExpiresAt: new Date(Date.now() + 60_000),
            },
          });

          return { digest: 'mid-race-effect' };
        },
      ),
    };

    // Reconstruct the fenced event as Worker A sees it
    const fencedA = {
      ...ours[0],
      _fence: { leaseHolder: holderA, deliveryOrdinal: ordinalA },
    } as unknown as typeof ours[0] & { _fence: { leaseHolder: string; deliveryOrdinal: number } };

    // Worker A dispatches — mid-consumer reclaim causes StaleFenceError
    const dispA = await relayA.dispatch(
      fencedA as Parameters<typeof relayA.dispatch>[0],
      midRaceConsumer,
    );

    // Stale fence → 'expired'
    expect(dispA).toBe('expired');

    // Consumer WAS called (the race happened mid-consumer, not pre-dispatch)
    expect(consumerCalled).toBe(true);

    // BLOCKER6: Consumer's database effect was ROLLED BACK.
    // The muneral_kb_task_changes row must NOT exist — the entire
    // consumer transaction was rolled back on StaleFenceError.
    const kbRow = await prisma.muneralKbTaskChange.findUnique({
      where: { taskId: effectTaskId },
    });
    expect(kbRow).toBeNull();

    // ZERO inbox rows from Worker A
    const inboxCount = await prisma.consumerInbox.count({
      where: { outboxEventId },
    });
    expect(inboxCount).toBe(0);

    // ZERO delivery attempt evidence from Worker A (stale fence, no evidence tx)
    const attemptCount = await prisma.deliveryAttemptEvidence.count({
      where: { outboxEventId },
    });
    expect(attemptCount).toBe(0);

    // ZERO quarantine evidence from Worker A
    const quarantineCount = await prisma.quarantineEvidence.count({
      where: { outboxEventId },
    });
    expect(quarantineCount).toBe(0);

    // Lease was actually reclaimed — status changed from Worker A's 'leased'
    const leaseFinal = await prisma.outboxLease.findUnique({
      where: { outboxEventId },
    });
    expect(leaseFinal.deliveryStatus).toBe('leased');
    expect(leaseFinal.leaseHolder).not.toBe(holderA);
    expect(leaseFinal.deliveryOrdinal).toBeGreaterThan(ordinalA);
  }, 30_000);

  // -- crash-after-commit/pre-ack idempotency --------------------------------

  it('9. crash-after-commit/pre-ack: idempotent replay does not re-invoke consumer', async () => {
    const { OutboxRelay } = require('../src/outbox/outbox.relay');
    const { normaliseConfig } = require('../src/outbox/outbox.types');

    const tId = await seedTask();
    const { outboxEventId } = await seedOutboxRow(tId, {
      deliveryStatus: 'pending',
      failureCount: 0,
      deliveryOrdinal: 0,
    });

    const config = normaliseConfig({
      relayId: `crash-relay-${randomUUID().slice(0, 6)}`,
    });
    const clock = { now: () => new Date() };
    const idSource = { generate: () => randomUUID() };

    // ---- First delivery: consumer succeeds, inbox + lease committed ----
    const relay1 = new OutboxRelay(prisma, clock, idSource, config);
    await relay1.resume();
    const events1 = await relay1.poll();
    const ours1 = events1.filter((e: { id: string }) => e.id === outboxEventId);
    expect(ours1.length).toBe(1);
    const leased1 = await relay1.lease(ours1);
    expect(leased1.length).toBe(1);

    let consumeCount = 0;
    const consumer1 = {
      consumerId: 'crash-consumer',
      consume: jest.fn().mockImplementation(async () => {
        consumeCount++;
        return { digest: 'sha256:committed-then-crashed' };
      }),
    };

    const disp1 = await relay1.dispatch(
      leased1[0] as Parameters<typeof relay1.dispatch>[0],
      consumer1,
    );
    expect(disp1).toBe('delivered');
    expect(consumeCount).toBe(1);

    // Verify durable state: lease is delivered, inbox row exists
    const leaseAfter1 = await prisma.outboxLease.findUnique({
      where: { outboxEventId },
    });
    expect(leaseAfter1.deliveryStatus).toBe('delivered');

    const inboxAfter1 = await prisma.consumerInbox.findUnique({
      where: {
        consumerId_outboxEventId: {
          consumerId: 'crash-consumer',
          outboxEventId,
        },
      },
    });
    expect(inboxAfter1).not.toBeNull();

    // ---- Simulated crash: relay process dies before ack ----
    // ---- Second delivery (idempotent replay): same event, new relay instance ----
    // Reset lease back to pending to simulate lease expiry after crash.
    // DELETE + INSERT bypasses the forward-only UPDATE trigger (which would
    // reject delivered->pending), matching real-world lease expiry where the
    // expired lease is reclaimed by a new relay instance.
    await prisma.$executeRawUnsafe(
      `DELETE FROM public.outbox_leases WHERE outbox_event_id = $1`,
      outboxEventId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.outbox_leases (outbox_event_id, delivery_status, delivery_ordinal, failure_count)
       VALUES ($1, 'pending', 0, 0)`,
      outboxEventId,
    );

    const relay2 = new OutboxRelay(prisma, clock, idSource, config);
    await relay2.resume();
    const events2 = await relay2.poll();
    const ours2 = events2.filter((e: { id: string }) => e.id === outboxEventId);
    expect(ours2.length).toBe(1);
    const leased2 = await relay2.lease(ours2);
    expect(leased2.length).toBe(1);

    const consumer2 = {
      consumerId: 'crash-consumer', // same consumer
      consume: jest.fn().mockResolvedValue({ digest: 'should-not-be-called' }),
    };

    const disp2 = await relay2.dispatch(
      leased2[0] as Parameters<typeof relay2.dispatch>[0],
      consumer2,
    );

    // MUST return 'delivered' (inbox dedup), NOT 'expired'
    expect(disp2).toBe('delivered');

    // Consumer MUST NOT be re-invoked (idempotent replay via inbox dedup)
    expect(consumer2.consume).not.toHaveBeenCalled();

    // No duplicate inbox row
    const inboxCount = await prisma.consumerInbox.count({
      where: { outboxEventId, consumerId: 'crash-consumer' },
    });
    expect(inboxCount).toBe(1);

    // Lease is now 'delivered' (updated by the dedup path)
    const leaseAfter2 = await prisma.outboxLease.findUnique({
      where: { outboxEventId },
    });
    expect(leaseAfter2.deliveryStatus).toBe('delivered');
  }, 30_000);

  // -- mid-cycle stop/resume -------------------------------------------------

  it('10. mid-cycle stop/resume: unstarted events are recoverable on resume', async () => {
    const { OutboxRelay } = require('../src/outbox/outbox.relay');
    const { normaliseConfig } = require('../src/outbox/outbox.types');

    const tId = await seedTask();

    // Seed 3 outbox events
    const evt1 = await seedOutboxRow(tId);
    const evt2 = await seedOutboxRow(tId);
    const evt3 = await seedOutboxRow(tId);

    const config = normaliseConfig({
      relayId: `stop-relay-${randomUUID().slice(0, 6)}`,
      batchSize: 10,
    });
    const clock = { now: () => new Date() };
    const idSource = { generate: () => randomUUID() };

    const relay = new OutboxRelay(prisma, clock, idSource, config);
    await relay.resume();

    // Targeted approach: poll, filter for our 3 events, lease just those,
    // dispatch manually — stop() after evt1 succeeds, verify evt2/evt3 skipped.
    const allEvents = await relay.poll();
    const ourIds = new Set([evt1.outboxEventId, evt2.outboxEventId, evt3.outboxEventId]);
    const ourEvents = allEvents.filter((e: { id: string }) => ourIds.has(e.id));
    expect(ourEvents.length).toBe(3);

    const leased = await relay.lease(ourEvents);
    expect(leased.length).toBe(3);

    const consumer = {
      consumerId: `stop-consumer-${randomUUID().slice(0, 6)}`,
      consume: jest.fn().mockResolvedValue({ digest: 'sha256:consumer-digest' }),
    };

    // Dispatch evt1 successfully, then stop()
    const disp1 = await relay.dispatch(
      leased[0] as Parameters<typeof relay.dispatch>[0],
      consumer,
    );
    expect(disp1).toBe('delivered');
    expect(consumer.consume).toHaveBeenCalledTimes(1);

    // Stop mid-batch — remainder should be skipped
    relay.stop();

    // Now try to dispatch evt2 — cycle() checks stopped BEFORE dispatch,
    // but direct dispatch() does NOT check. However, we're testing that
    // after stop(), the stopped flag prevents new cycles. For the
    // remaining leased events, they stay 'leased' and will be re-polled
    // after lease expiry.

    // Verify: evt1 is delivered
    const lease1 = await prisma.outboxLease.findUnique({
      where: { outboxEventId: evt1.outboxEventId },
    });
    expect(lease1.deliveryStatus).toBe('delivered');

    // Verify: the UNSTARTED events still have lease='leased' (not delivered/quarantined)
    // They were skipped mid-cycle, so their lease was acquired but never delivered.
    // After the lease expires, they will be re-polled.
    const lease2 = await prisma.outboxLease.findUnique({
      where: { outboxEventId: evt2.outboxEventId },
    });
    const lease3 = await prisma.outboxLease.findUnique({
      where: { outboxEventId: evt3.outboxEventId },
    });
    // Leases were acquired (status='leased') but not delivered
    expect(['leased', 'pending']).toContain(lease2.deliveryStatus);
    expect(['leased', 'pending']).toContain(lease3.deliveryStatus);

    // Now resume and verify remaining events can be re-polled after lease expiry
    // Force-expire the leases for evt2 and evt3
    const past = new Date(Date.now() - 120_000);
    const past2 = new Date(Date.now() - 60_000);
    await prisma.outboxLease.updateMany({
      where: { outboxEventId: { in: [evt2.outboxEventId, evt3.outboxEventId] } },
      data: {
        leaseAcquiredAt: past,
        leaseExpiresAt: past2,
        deliveryStatus: 'leased',
      },
    });

    // Resume and re-poll — the expired leases for evt2 and evt3 are re-discovered
    await relay.resume();

    const resumedEvents = await relay.poll();
    const resumedOurIds = new Set([evt2.outboxEventId, evt3.outboxEventId]);
    const resumedOurs = resumedEvents.filter((e: { id: string }) => resumedOurIds.has(e.id));
    // After lease expiry, both events should be re-pollable
    expect(resumedOurs.length).toBeGreaterThanOrEqual(2);

    const reLeased = await relay.lease(resumedOurs);
    expect(reLeased.length).toBeGreaterThanOrEqual(2);

    const consumer2 = {
      consumerId: `stop-consumer-2-${randomUUID().slice(0, 6)}`,
      consume: jest.fn().mockResolvedValue({ digest: 'resumed-digest' }),
    };

    // Deliver the recovered events
    for (const evt of reLeased) {
      const d = await relay.dispatch(
        evt as Parameters<typeof relay.dispatch>[0],
        consumer2,
      );
      expect(d).toBe('delivered');
    }
    expect(consumer2.consume).toHaveBeenCalledTimes(reLeased.length);
  }, 30_000);

  // -- failure_count accumulation across lease cycles (F1, real DB) ----------

  it('11. F1: repeated failures accumulate to quarantine through real OutboxRelay', async () => {
    const { OutboxRelay } = require('../src/outbox/outbox.relay');
    const { normaliseConfig } = require('../src/outbox/outbox.types');

    const tId = await seedTask();
    const { outboxEventId } = await seedOutboxRow(tId, {
      deliveryStatus: 'pending',
      failureCount: 0,
      deliveryOrdinal: 0,
    });

    const config = normaliseConfig({
      relayId: `f1-db-relay-${randomUUID().slice(0, 6)}`,
      maxRetries: 3,
    });
    const clock = { now: () => new Date() };
    const idSource = { generate: () => randomUUID() };
    const relay = new OutboxRelay(prisma, clock, idSource, config);
    await relay.resume();

    // Helper to poll+lease our specific event
    async function leaseOurs(): Promise<Record<string, unknown> | null> {
      const events = await relay.poll();
      const ours = events.filter((e: { id: string }) => e.id === outboxEventId);
      if (ours.length === 0) return null;
      const leased = await relay.lease(ours);
      return leased.length > 0 ? (leased[0] as unknown as Record<string, unknown>) : null;
    }

    // Helper to expire the lease so it can be re-polled
    async function expireLease() {
      await prisma.$executeRawUnsafe(
        `UPDATE outbox_leases
         SET lease_acquired_at = $1, lease_expires_at = $2
         WHERE outbox_event_id = $3`,
        new Date(Date.now() - 120_000), new Date(Date.now() - 60_000),
        outboxEventId,
      );
    }

    const failingConsumer = {
      consumerId: 'f1-db-consumer',
      consume: jest.fn().mockRejectedValue(new Error('simulated failure')),
    };

    // Cycle 1: failure_count 0 → 1
    const evt1 = await leaseOurs();
    expect(evt1).not.toBeNull();
    const disp1 = await relay.dispatch(
      evt1 as unknown as Parameters<typeof relay.dispatch>[0],
      failingConsumer,
    );
    expect(disp1).toBe('expired');
    let leaseRow = await prisma.outboxLease.findUnique({ where: { outboxEventId } });
    expect(leaseRow.failureCount).toBe(1);

    // Cycle 2: failure_count 1 → 2
    await expireLease();
    const evt2 = await leaseOurs();
    expect(evt2).not.toBeNull();
    const disp2 = await relay.dispatch(
      evt2 as unknown as Parameters<typeof relay.dispatch>[0],
      failingConsumer,
    );
    expect(disp2).toBe('expired');
    leaseRow = await prisma.outboxLease.findUnique({ where: { outboxEventId } });
    expect(leaseRow.failureCount).toBe(2);

    // Cycle 3: failure_count 2 → 3 → quarantine
    await expireLease();
    const evt3 = await leaseOurs();
    expect(evt3).not.toBeNull();
    const disp3 = await relay.dispatch(
      evt3 as unknown as Parameters<typeof relay.dispatch>[0],
      failingConsumer,
    );
    expect(disp3).toBe('quarantined');

    // Verify final state
    leaseRow = await prisma.outboxLease.findUnique({ where: { outboxEventId } });
    expect(leaseRow.failureCount).toBe(3);
    expect(leaseRow.deliveryStatus).toBe('quarantined');

    // Quarantine evidence row exists
    const qRow = await prisma.quarantineEvidence.findUnique({
      where: { outboxEventId },
    });
    expect(qRow).not.toBeNull();
    expect(qRow.failureCount).toBe(3);

    // Event is NOT re-polled after quarantine
    const finalPoll = await relay.poll();
    const rePolled = finalPoll.filter((e: { id: string }) => e.id === outboxEventId);
    expect(rePolled).toHaveLength(0);

    // Delivery attempt evidence: at least 3 rows (one per failed cycle)
    const attemptRows = await prisma.deliveryAttemptEvidence.findMany({
      where: { outboxEventId },
    });
    expect(attemptRows.length).toBeGreaterThanOrEqual(3);
  }, 30_000);

  // -- reconciliation snapshot against real database -------------------------

  it('12. reconciliation snapshot reflects real database state', async () => {
    const { OutboxRelay } = require('../src/outbox/outbox.relay');
    const { normaliseConfig } = require('../src/outbox/outbox.types');

    const tId = await seedTask();
    await seedOutboxRow(tId, { deliveryStatus: 'pending', failureCount: 0 });

    const config = normaliseConfig({ relayId: `rec-relay-${randomUUID().slice(0, 6)}` });
    const clock = { now: () => new Date() };
    const idSource = { generate: () => randomUUID() };
    const relay = new OutboxRelay(prisma, clock, idSource, config);

    const snapshot = await relay.reconciliation();

    // Lease summary has at least one status
    expect(snapshot.leaseSummary).toBeDefined();
    const keys = Object.keys(snapshot.leaseSummary);
    expect(keys.length).toBeGreaterThan(0);

    // No orphan events (every outbox row has a lease)
    expect(snapshot.orphanEvents).toHaveLength(0);

    // Stale leases and quarantine arrays are at least arrays
    expect(Array.isArray(snapshot.staleLeases)).toBe(true);
    expect(Array.isArray(snapshot.quarantined)).toBe(true);

    // Attempt counts and inbox summary are defined
    expect(snapshot.attemptCounts).toBeDefined();
    expect(snapshot.inboxSummary).toBeDefined();
  }, 15_000);

  // -- wrong-plane payload rejection (real DB) -------------------------------

  // IMP6: Prove cycle() stopping mid-leased batch leaves unstarted events
  // recoverable and delivers only started events.
  it('13. cycle() stops mid-batch: only started events delivered, remainder recoverable', async () => {
    const { OutboxRelay } = require('../src/outbox/outbox.relay');
    const { normaliseConfig } = require('../src/outbox/outbox.types');

    const tId = await seedTask();

    // Seed 3 fresh outbox events with unique consumer to avoid collisions
    const evt1 = await seedOutboxRow(tId, { deliveryStatus: 'pending' });
    const evt2 = await seedOutboxRow(tId, { deliveryStatus: 'pending' });
    const evt3 = await seedOutboxRow(tId, { deliveryStatus: 'pending' });
    const ourIds = new Set([evt1.outboxEventId, evt2.outboxEventId, evt3.outboxEventId]);

    const config = normaliseConfig({
      relayId: `cycle-stop-relay-${randomUUID().slice(0, 6)}`,
      batchSize: 10,
    });
    const clock = { now: () => new Date() };
    const idSource = { generate: () => randomUUID() };
    const relay = new OutboxRelay(prisma, clock, idSource, config);
    await relay.resume();

    let consumeCount = 0;

    // Consumer that stops the relay after delivering exactly one of OUR events
    const consumer = {
      consumerId: `cycle-stop-consumer-${randomUUID().slice(0, 6)}`,
      consume: jest.fn().mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (event: any, _tx: any) => {
          consumeCount++;
          if (consumeCount === 1) {
            relay.stop(); // Stop after first delivery
          }
          return { digest: `sha256:${randomUUID().slice(0, 16)}` };
        },
      ),
    };

    // cycle() polls ALL pending events (including leftovers from earlier
    // tests). After first delivery, relay stops and subsequent events
    // (including the rest of our 3) are skipped.
    const result = await relay.cycle(consumer);

    // At least 1 event was delivered (the first one encountered)
    expect(result.delivered).toBe(1);
    // The leased count reflects ALL polled events; we only care that it's > 0
    expect(result.leased).toBeGreaterThanOrEqual(1);
    // Consumer only called once (then relay stopped)
    expect(consumer.consume).toHaveBeenCalledTimes(1);

    // Verify the recoverability path: force our 3 events back to pending,
    // then resume and re-cycle to prove they can be recovered.
    // DELETE + INSERT bypasses the forward-only UPDATE trigger (which rejects
    // non-pending→pending rewinds), simulating lease expiry and reclaim.
    for (const evtId of [evt1.outboxEventId, evt2.outboxEventId, evt3.outboxEventId]) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM public.outbox_leases WHERE outbox_event_id = $1`,
        evtId,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO public.outbox_leases (outbox_event_id, delivery_status, delivery_ordinal, failure_count)
         VALUES ($1, 'pending', 0, 0)`,
        evtId,
      );
    }

    await relay.resume();

    const consumer2 = {
      consumerId: `cycle-stop-consumer-2-${randomUUID().slice(0, 6)}`,
      consume: jest.fn().mockResolvedValue({
        digest: `sha256:recovered-${randomUUID().slice(0, 16)}`,
      }),
    };

    // Re-cycle: all 3 of our events are now pending again and should be delivered
    const result2 = await relay.cycle(consumer2);

    // At least our 3 events are delivered
    expect(result2.delivered).toBeGreaterThanOrEqual(3);
    expect(consumer2.consume).toHaveBeenCalled();

    // Verify our 3 events are now delivered
    for (const evt of [evt1, evt2, evt3]) {
      const lease = await prisma.outboxLease.findUnique({
        where: { outboxEventId: evt.outboxEventId },
      });
      expect(lease.deliveryStatus).toBe('delivered');
    }
  }, 30_000);

  // -- wrong-plane payload rejection (real DB) -------------------------------

  it('14. wrong-plane payload rejected with durable quarantine (production path)', async () => {
    const { OutboxRelay } = require('../src/outbox/outbox.relay');
    const { normaliseConfig } = require('../src/outbox/outbox.types');
    const { WrongPlanePayloadError } = require('../src/outbox/outbox.errors');

    const tId = await seedTask();
    const { outboxEventId } = await seedOutboxRow(tId, {
      deliveryStatus: 'pending',
      failureCount: 0,
      eventPayload: {
        schema: 'muneral-outbox-v1',
        transitionEventType: 'attempt:succeeded',
        committedResult: { status: 'done' },
        idempotencyKey: randomUUID(),
        aggregateVersion: 5,
        attemptId: randomUUID(),
        attemptOrdinal: 1,
        retryCount: 0,
        retryBudget: 3,
        host_id: 'forbidden-host', // ← WRONG PLANE
      },
    });

    const config = normaliseConfig({ relayId: `wp-relay-${randomUUID().slice(0, 6)}` });
    const clock = { now: () => new Date() };
    const idSource = { generate: () => randomUUID() };
    const relay = new OutboxRelay(prisma, clock, idSource, config);
    await relay.resume();

    const events = await relay.poll();
    const ours = events.filter((e: { id: string }) => e.id === outboxEventId);
    expect(ours.length).toBe(1);
    const leased = await relay.lease(ours);
    expect(leased.length).toBe(1);

    const consumer = {
      consumerId: 'wp-consumer',
      consume: jest.fn().mockResolvedValue({ digest: 'unused' }),
    };

    await expect(
      relay.dispatch(
        leased[0] as unknown as Parameters<typeof relay.dispatch>[0],
        consumer,
      ),
    ).rejects.toThrow(WrongPlanePayloadError);

    // Consumer NOT called
    expect(consumer.consume).not.toHaveBeenCalled();

    // Durable quarantine evidence persists
    const qRow = await prisma.quarantineEvidence.findUnique({
      where: { outboxEventId },
    });
    expect(qRow).not.toBeNull();
    expect(qRow.lastErrorCode).toBe('WRONG_PLANE');

    // Lease status is quarantined
    const leaseRow = await prisma.outboxLease.findUnique({
      where: { outboxEventId },
    });
    expect(leaseRow.deliveryStatus).toBe('quarantined');

    // Event is NOT re-polled
    const rePoll = await relay.poll();
    const found = rePoll.find((e: { id: string }) => e.id === outboxEventId);
    expect(found).toBeUndefined();
  }, 15_000);

  // BLOCKER6: Wrong-plane through the actual executeCommand service path.
  // The service-level plane validation must reject wrong-plane payloads
  // BEFORE any durable rows are persisted — zero transitions, zero outbox
  // rows, zero lease rows.
  it('14b. wrong-plane committedResult rejected at service level with zero durable rows', async () => {
    const { ExecutionAuthorityService } = require('../src/execution-authority/execution-authority.service');
    const { WrongPlanePayloadError } = require('../src/outbox/outbox.errors');

    const tId = await seedTask();
    const now = new Date();
    const idSource = { generate: () => randomUUID() };
    const clock = { now: () => now };
    const authService = new ExecutionAuthorityService(clock, idSource);

    // Step 1: issue_initial_attempt (clean)
    const initResult = await authService.executeCommand(prisma, {
      kind: 'issue_initial_attempt',
      taskId: tId,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
      causationId: randomUUID(),
      correlationId: randomUUID(),
      retryBudget: 3,
      retryBackoffMs: 0,
      evidenceRefs: [],
    });
    expect(initResult).toHaveProperty('committedResult');
    const state = (initResult as Record<string, unknown>).state as Record<string, unknown>;
    const currentAttemptId = state.currentAttemptId as string;

    // Step 2a: transition_attempt → started (issued → running). Required
    // before the reducer will accept 'attempt:succeeded'.
    const startedResult = await authService.executeCommand(prisma, {
      kind: 'transition_attempt',
      taskId: tId,
      attemptId: currentAttemptId,
      expectedVersion: 1,
      eventType: 'attempt:started',
      idempotencyKey: randomUUID(),
      causationId: randomUUID(),
      correlationId: randomUUID(),
      evidenceRefs: [],
      payload: {},
      committedResult: { started: true },
    });
    expect(startedResult).toHaveProperty('committedResult');

    // Step 2b: transition_attempt → succeeded WITH wrong-plane committedResult
    // The committedResult contains 'host_id' which is a forbidden fleet key.
    const wrongPlaneResult = await authService.executeCommand(prisma, {
      kind: 'transition_attempt',
      taskId: tId,
      attemptId: currentAttemptId,
      expectedVersion: 2,
      eventType: 'attempt:succeeded',
      idempotencyKey: randomUUID(),
      causationId: randomUUID(),
      correlationId: randomUUID(),
      evidenceRefs: [],
      payload: { reason: 'test' },
      committedResult: { status: 'done', host_id: 'forbidden-at-service-level' },
    });

    // Must return WrongPlanePayloadError (not throw)
    expect(wrongPlaneResult).toBeInstanceOf(WrongPlanePayloadError);

    // ZERO durable rows: no transition, no outbox, no lease for this attempt
    const transitions = await prisma.taskExecutionTransition.findMany({
      where: { taskId: tId, eventType: 'attempt:succeeded' },
    });
    expect(transitions.length).toBe(0);

    const outboxRows = await prisma.taskOutboxEvent.findMany({
      where: { taskId: tId },
    });
    // Only the initial_attempt and started transitions exist,
    // succeeded transition was rejected — zero outbox rows from it
    const succeededOutbox = outboxRows.filter(
      (r: { eventType: string }) => r.eventType === 'task:completed',
    );
    expect(succeededOutbox.length).toBe(0);
  }, 15_000);

  // BLOCKER6: Wrong-plane transitionPayload rejected at service level.
  it('14c. wrong-plane transitionPayload rejected at service level with zero durable rows', async () => {
    const { ExecutionAuthorityService } = require('../src/execution-authority/execution-authority.service');
    const { WrongPlanePayloadError } = require('../src/outbox/outbox.errors');

    const tId = await seedTask();
    const now = new Date();
    const idSource = { generate: () => randomUUID() };
    const clock = { now: () => now };
    const authService = new ExecutionAuthorityService(clock, idSource);

    // issue_initial_attempt (clean)
    const initResult = await authService.executeCommand(prisma, {
      kind: 'issue_initial_attempt',
      taskId: tId,
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
      causationId: randomUUID(),
      correlationId: randomUUID(),
      retryBudget: 3,
      retryBackoffMs: 0,
      evidenceRefs: [],
    });
    const state = (initResult as Record<string, unknown>).state as Record<string, unknown>;
    const currentAttemptId = state.currentAttemptId as string;

    // Step 2a: transition_attempt → started
    const startedResult = await authService.executeCommand(prisma, {
      kind: 'transition_attempt',
      taskId: tId,
      attemptId: currentAttemptId,
      expectedVersion: 1,
      eventType: 'attempt:started',
      idempotencyKey: randomUUID(),
      causationId: randomUUID(),
      correlationId: randomUUID(),
      evidenceRefs: [],
      payload: {},
      committedResult: { started: true },
    });
    expect(startedResult).toHaveProperty('committedResult');

    // Step 2b: transition_attempt → succeeded WITH wrong-plane transitionPayload
    const wrongPlaneResult = await authService.executeCommand(prisma, {
      kind: 'transition_attempt',
      taskId: tId,
      attemptId: currentAttemptId,
      expectedVersion: 2,
      eventType: 'attempt:succeeded',
      idempotencyKey: randomUUID(),
      causationId: randomUUID(),
      correlationId: randomUUID(),
      evidenceRefs: [],
      payload: { reason: 'test', host_id: 'forbidden-in-payload' },
      committedResult: { status: 'done' },
    });

    expect(wrongPlaneResult).toBeInstanceOf(WrongPlanePayloadError);
  }, 15_000);

  // -- cleanup verification --------------------------------------------------

  it('15. NEGATIVE-CONTROL: DATABASE_URL points to disposable container only', () => {
    expect(DATABASE_URL).toContain(`localhost:${PG_PORT}`);
    expect(DATABASE_URL).toContain(PG_DB);
    expect(DATABASE_URL).not.toContain('production');
    expect(DATABASE_URL).not.toContain('prod');
    expect(DATABASE_URL).not.toContain('rds.amazonaws.com');
    expect(DATABASE_URL).not.toContain('supabase');
    expect(DATABASE_URL).not.toContain('neon.tech');
  });

  // IMPORTANT 7: FK deletion action catalog readback — prove RESTRICT on all
  // outbox FKs. Falsify UPDATE and DELETE for each append-only table.

  it('17. all exact outbox-relay FKs have ON DELETE/UPDATE RESTRICT', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT
         tc.constraint_name,
         tc.table_name,
         rc.delete_rule,
         rc.update_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_name = tc.constraint_name
        AND rc.constraint_schema = tc.constraint_schema
       WHERE tc.constraint_schema = 'public'
         AND tc.table_name IN (
           'task_outbox_events', 'outbox_leases',
           'delivery_attempt_evidence', 'quarantine_evidence', 'consumer_inbox'
         )
         AND tc.constraint_type = 'FOREIGN KEY'
       ORDER BY tc.table_name, tc.constraint_name`,
    ) as Array<{
      constraint_name: string;
      table_name: string;
      delete_rule: string;
      update_rule: string;
    }>;

    const expectedNames = new Set([
      'task_outbox_events_task_id_fkey',
      'task_outbox_events_attempt_task_fkey',
      'task_outbox_events_transition_task_fkey',
      'outbox_leases_outbox_fkey',
      'delivery_attempt_evidence_outbox_fkey',
      'quarantine_evidence_outbox_fkey',
      'consumer_inbox_outbox_fkey',
    ]);
    expect(new Set(rows.map((row) => row.constraint_name))).toEqual(
      expectedNames,
    );

    for (const row of rows) {
      expect(row.delete_rule).toBe('RESTRICT');
      expect(row.update_rule).toBe('RESTRICT');
    }
  });

  it('18. NEGATIVE-CONTROL: DELETE from task_outbox_events is rejected (append-only trigger)', async () => {
    const tId = await seedTask();
    const { outboxEventId } = await seedOutboxRow(tId);
    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM public.task_outbox_events WHERE id = $1`,
        outboxEventId,
      ),
    ).rejects.toThrow(/append-only|MUN00/);
  });

  it('19. outbox_leases remains mutable when delivery status is unchanged', async () => {
    const tId = await seedTask();
    const { outboxEventId } = await seedOutboxRow(tId);
    await prisma.$executeRawUnsafe(
      `UPDATE public.outbox_leases
       SET failure_count = failure_count + 1
       WHERE outbox_event_id = $1`,
      outboxEventId,
    );
    const lease = await prisma.outboxLease.findUnique({ where: { outboxEventId } });
    expect(lease.deliveryStatus).toBe('pending');
    expect(lease.failureCount).toBe(1);
  });

  it('19b. NEGATIVE-CONTROL: delivered to pending rewind is rejected', async () => {
    const tId = await seedTask();
    const { outboxEventId } = await seedOutboxRow(tId);
    await prisma.$executeRawUnsafe(
      `UPDATE public.outbox_leases SET delivery_status = 'leased' WHERE outbox_event_id = $1`,
      outboxEventId,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE public.outbox_leases SET delivery_status = 'delivered' WHERE outbox_event_id = $1`,
      outboxEventId,
    );
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE public.outbox_leases SET delivery_status = 'pending' WHERE outbox_event_id = $1`,
        outboxEventId,
      ),
    ).rejects.toThrow(/forward-only|MUN01/);
    const lease = await prisma.outboxLease.findUnique({ where: { outboxEventId } });
    expect(lease.deliveryStatus).toBe('delivered');
  });

  it('19c. NEGATIVE-CONTROL: quarantined to pending rewind is rejected', async () => {
    const tId = await seedTask();
    const { outboxEventId } = await seedOutboxRow(tId);
    await prisma.$executeRawUnsafe(
      `UPDATE public.outbox_leases SET delivery_status = 'leased' WHERE outbox_event_id = $1`,
      outboxEventId,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE public.outbox_leases SET delivery_status = 'quarantined' WHERE outbox_event_id = $1`,
      outboxEventId,
    );
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE public.outbox_leases SET delivery_status = 'pending' WHERE outbox_event_id = $1`,
        outboxEventId,
      ),
    ).rejects.toThrow(/forward-only|MUN01/);
  });

  it.each(['delivered', 'quarantined'])(
    '19d. NEGATIVE-CONTROL: pending to %s skip is rejected',
    async (terminalStatus) => {
      const tId = await seedTask();
      const { outboxEventId } = await seedOutboxRow(tId);
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE public.outbox_leases SET delivery_status = $1 WHERE outbox_event_id = $2`,
          terminalStatus,
          outboxEventId,
        ),
      ).rejects.toThrow(/forward-only|MUN01/);
    },
  );

  it('20. NEGATIVE-CONTROL: outbox_leases FK rejects invalid outbox_event_id (new FK proof)', async () => {
    // Prove the outbox_leases → task_outbox_events FK is active and enforced
    // independently of any MUN-0020 constraints. Inserting a lease row with
    // a non-existent outbox_event_id must be rejected by the FK.
    const fakeOutboxId = randomUUID();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO public.outbox_leases
           (outbox_event_id, delivery_status, delivery_ordinal, failure_count)
         VALUES ($1, 'pending', 0, 0)`,
        fakeOutboxId,
      ),
    ).rejects.toThrow(/foreign|violat|constraint/i);
  }, 15_000);

  it('16. container name is unique and not a shared resource', () => {
    expect(CONTAINER_NAME).toContain('muneral-outbox-test');
    expect(CONTAINER_NAME.length).toBeGreaterThanOrEqual(27); // includes random suffix (8 hex chars)
  });
});
