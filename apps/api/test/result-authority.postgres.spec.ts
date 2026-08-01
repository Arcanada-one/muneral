// MUN-0021 adoption gate: committed-result authority — real PostgreSQL proofs.
//
// Falsifier 15 of the ARCA-0194 result consilium: disposable PostgreSQL proves
// uniqueness, restrictive deletion, append-only behaviour, deterministic
// readback and complete cleanup. Falsifiers 5, 6, 9 and 12 and acceptance
// criteria 7, 8, 11 and 12 of the task description are exercised here against
// the real constraints rather than against mocks.
//
// Run with: npx jest --no-coverage --runInBand --testPathPattern='result-authority.postgres'
// Requires: Docker daemon, psql, sudo (for docker)
//
// Tests invoke the production ResultAuthorityService — no reimplementation of
// the commit seam.

import { randomUUID } from 'node:crypto';

import { ExecutionAuthorityService } from '../src/execution-authority/execution-authority.service';
import type { TransactionalClient } from '../src/execution-authority/execution-authority.service';
import type {
  Clock,
  IdSource,
} from '../src/execution-authority/execution-authority.types';
import { ResultAuthorityService } from '../src/result-authority/result-authority.service';
import type { CommittedResultOutcome } from '../src/result-authority/result-authority.service';
import {
  cardDigest,
  computeReceiptId,
  computeResultRefId,
  projectionDigest,
  resultNodeDigest,
} from '../src/result-authority/result-authority.canonical';
import {
  validateCommittedResultRefV0,
  validateCompletionReceiptV0,
} from '../src/result-authority/result-authority.guards';
import { ResultBindingError } from '../src/result-authority/result-authority.errors';
import { createDisposablePostgres } from './support/disposable-postgres';

const pg = createDisposablePostgres('result-authority');

beforeAll(async () => {
  await pg.start();
}, 120_000);

afterAll(async () => {
  await pg.stop();
}, 30_000);

// ---------------------------------------------------------------------------

const CARD = { schemaVersion: 'v0', cardId: 'card-1', instructions: 'do it' };
const PROJECTION = {
  schemaVersion: 'v0',
  projectionId: 'proj-1',
  cardId: 'card-1',
  nodes: ['node-1'],
};
const CARD_DIGEST = cardDigest(CARD);
const PROJECTION_DIGEST = projectionDigest(PROJECTION);
const PRINCIPAL = 'agent-arcana:executor-1';

describe('Committed-result authority — PostgreSQL proofs', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let projectId: string;
  let workspaceId: string;
  let ownerId: string;

  const clock: Clock = { now: () => new Date() };
  const idSource: IdSource = { generate: () => randomUUID() };
  const authority = new ExecutionAuthorityService(clock, idSource);
  const service = new ResultAuthorityService(clock, idSource, authority);

  beforeAll(async () => {
    const { PrismaClient } = require('@prisma/client');
    const { PrismaPg } = require('@prisma/adapter-pg');
    const adapter = new PrismaPg({ connectionString: pg.url() });
    prisma = new PrismaClient({ adapter });
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  // -- seeding ---------------------------------------------------------------

  async function seedWorkspaceAndProject(): Promise<void> {
    ownerId = randomUUID();
    workspaceId = randomUUID();
    projectId = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.users (id, name, created_at, updated_at)
       VALUES ($1, 'test-user', NOW(), NOW()) ON CONFLICT DO NOTHING`,
      ownerId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.workspaces (id, slug, name, owner_id, created_at)
       VALUES ($1, $2, 'test-ws', $3, NOW()) ON CONFLICT DO NOTHING`,
      workspaceId, `ws-${randomUUID().slice(0, 6)}`, ownerId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.projects (id, workspace_id, slug, name, created_at)
       VALUES ($1, $2, $3, 'test-project', NOW()) ON CONFLICT DO NOTHING`,
      projectId, workspaceId, `prj-${randomUUID().slice(0, 6)}`,
    );
  }

  /** Seed a task and issue its initial attempt through the real seam. */
  async function seedTaskWithAttempt(bindResult = true): Promise<{
    taskId: string;
    attemptId: string;
  }> {
    if (!projectId) await seedWorkspaceAndProject();
    const taskId = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.tasks (id, project_id, title, status, created_at, updated_at)
       VALUES ($1, $2, 'result-authority-task', 'todo', NOW(), NOW())`,
      taskId, projectId,
    );
    const issued = await authority.executeCommand(prisma, {
      kind: 'issue_initial_attempt',
      taskId,
      expectedVersion: 0,
      idempotencyKey: `issue-${randomUUID()}`,
      causationId: 'cause-1',
      correlationId: 'corr-1',
      retryBudget: 3,
      retryBackoffMs: 1_000,
      evidenceRefs: [],
    });
    if (issued instanceof Error) throw issued;
    const attemptId = (issued as { state: { currentAttemptId: string | null } })
      .state.currentAttemptId;
    if (!attemptId) throw new Error('seed failed: no attempt issued');

    // A result may only be committed from a running attempt — the MUN-0020
    // reducer permits attempt:succeeded from `running` alone.
    const started = await authority.executeCommand(prisma, {
      kind: 'transition_attempt',
      taskId,
      attemptId,
      expectedVersion: 1,
      eventType: 'attempt:started',
      idempotencyKey: `start-${randomUUID()}`,
      causationId: 'cause-1',
      correlationId: 'corr-1',
      evidenceRefs: [],
      payload: {},
      committedResult: {},
    });
    if (started instanceof Error) throw started;
    if (bindResult) {
      await prisma.taskResultBinding.create({
        data: {
          taskId,
          attemptId,
          cardId: 'card-1',
          cardDigest: CARD_DIGEST,
          projectionId: 'proj-1',
          projectionDigest: PROJECTION_DIGEST,
          principalId: PRINCIPAL,
          recordedAt: new Date(),
        },
      });
    }
    return { taskId, attemptId };
  }

  function proposal(
    taskId: string,
    attemptId: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      schemaVersion: 'v0',
      kind: 'owned-result-mutation',
      mutationId: `mut-${randomUUID()}`,
      taskId,
      attemptId,
      cardId: 'card-1',
      cardDigest: CARD_DIGEST,
      projectionId: 'proj-1',
      projectionDigest: PROJECTION_DIGEST,
      nodeId: 'node-1',
      expectedNodeVersion: 0,
      principalId: PRINCIPAL,
      resultNode: { nodeId: 'node-1', kind: 'task-card-result-node', value: { summary: 'done' } },
      idempotencyKey: `idem-${randomUUID()}`,
      causationId: 'cause-1',
      correlationId: 'corr-1',
      ...overrides,
    };
  }

  // -- 1. schema -------------------------------------------------------------

  it('1. all committed-result authority relations exist after migration', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('task_result_bindings', 'task_result_nodes', 'task_committed_result_refs')
       ORDER BY table_name`,
    );
    expect((rows as Array<{ table_name: string }>).map((r) => r.table_name)).toEqual([
      'task_committed_result_refs',
      'task_result_bindings',
      'task_result_nodes',
    ]);
  });

  it('2. every foreign key on both relations is ON DELETE RESTRICT', async () => {
    const rows = await prisma.$queryRawUnsafe(
      // pg's "char" columns are cast to text: Prisma cannot deserialize the
      // internal single-byte type.
      `SELECT c.conname, c.confdeltype::text AS confdeltype,
              c.confupdtype::text AS confupdtype
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE c.contype = 'f'
          AND t.relname IN ('task_result_nodes', 'task_committed_result_refs')`,
    );
    const fks = rows as Array<{
      conname: string;
      confdeltype: string;
      confupdtype: string;
    }>;
    // Six original task/attempt/transition/node relations plus the exact
    // committed-reference -> pre-existing binding relation.
    expect(fks.length).toBe(7);
    for (const fk of fks) {
      // 'r' = RESTRICT in pg_constraint
      expect(fk.confdeltype).toBe('r');
      expect(fk.confupdtype).toBe('r');
    }
  });

  it('3. the three ratified uniqueness constraints exist in the catalog', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT c.conname
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE c.contype = 'u' AND t.relname = 'task_committed_result_refs'`,
    );
    const names = (rows as Array<{ conname: string }>).map((r) => r.conname);
    expect(names).toEqual(
      expect.arrayContaining([
        'task_committed_result_refs_transition_unique',
        'task_committed_result_refs_semantic_unique',
        'task_committed_result_refs_mutation_unique',
        'task_committed_result_refs_receipt_unique',
      ]),
    );
  });

  // -- 4-7. the real service path -------------------------------------------

  it('4. the service commits node, transition, reference, receipt and outbox atomically', async () => {
    const { taskId, attemptId } = await seedTaskWithAttempt();
    const outcome = await service.commitOwnedResult(
      prisma,
      proposal(taskId, attemptId),
    );
    expect(outcome).not.toBeInstanceOf(Error);
    const committed = outcome as CommittedResultOutcome;

    const nodes = await prisma.taskResultNode.findMany({ where: { taskId } });
    expect(nodes).toHaveLength(1);
    expect(nodes[0].nodeVersion).toBe(1);
    expect(nodes[0].resultDigest).toBe(
      resultNodeDigest({
        nodeId: 'node-1',
        kind: 'task-card-result-node',
        value: { summary: 'done' },
      }),
    );

    const refs = await prisma.taskCommittedResultRef.findMany({ where: { taskId } });
    expect(refs).toHaveLength(1);
    expect(refs[0].resultRefId).toBe(committed.resultRef.resultRefId);
    expect(refs[0].receiptId).toBe(committed.receipt.receiptId);
    expect(refs[0].transitionId).toBe(committed.resultRef.transitionId);
    expect(refs[0].resultNodeId).toBe(nodes[0].id);

    const outbox = await prisma.taskOutboxEvent.findUnique({
      where: { transitionId: committed.resultRef.transitionId },
    });
    expect(outbox).not.toBeNull();
    expect(outbox.eventType).toBe('task:completed');
  });

  it('4b. a first result without a pre-existing binding fails with zero writes', async () => {
    const { taskId, attemptId } = await seedTaskWithAttempt(false);
    const transitionsBefore = await prisma.taskExecutionTransition.count({
      where: { taskId },
    });
    const outboxBefore = await prisma.taskOutboxEvent.count({ where: { taskId } });

    const outcome = await service.commitOwnedResult(
      prisma,
      proposal(taskId, attemptId),
    );

    expect(outcome).toBeInstanceOf(ResultBindingError);
    expect(await prisma.taskResultNode.count({ where: { taskId } })).toBe(0);
    expect(await prisma.taskCommittedResultRef.count({ where: { taskId } })).toBe(0);
    expect(await prisma.taskExecutionTransition.count({ where: { taskId } })).toBe(
      transitionsBefore,
    );
    expect(await prisma.taskOutboxEvent.count({ where: { taskId } })).toBe(
      outboxBefore,
    );
  });

  it('5. the reference regenerates byte-identically from its stored columns', async () => {
    const { taskId, attemptId } = await seedTaskWithAttempt();
    const outcome = await service.commitOwnedResult(
      prisma,
      proposal(taskId, attemptId),
    );
    const committed = outcome as CommittedResultOutcome;

    const row = await prisma.taskCommittedResultRef.findUnique({
      where: { resultRefId: committed.resultRef.resultRefId },
    });
    const regenerated = computeResultRefId({
      schemaVersion: 'v0',
      kind: 'task-card-result',
      taskId: row.taskId,
      attemptId: row.attemptId,
      cardId: row.cardId,
      cardDigest: row.cardDigest,
      projectionId: row.projectionId,
      projectionDigest: row.projectionDigest,
      nodeId: row.nodeId,
      nodeVersion: row.nodeVersion,
      resultDigest: row.resultDigest,
      mutationId: row.mutationId,
      principalId: row.principalId,
      transitionId: row.transitionId,
      aggregateVersion: Number(row.aggregateVersion),
    });
    expect(regenerated).toBe(row.resultRefId);

    const ref = validateCommittedResultRefV0({
      schemaVersion: 'v0',
      kind: 'task-card-result',
      resultRefId: row.resultRefId,
      taskId: row.taskId,
      attemptId: row.attemptId,
      cardId: row.cardId,
      cardDigest: row.cardDigest,
      projectionId: row.projectionId,
      projectionDigest: row.projectionDigest,
      nodeId: row.nodeId,
      nodeVersion: row.nodeVersion,
      resultDigest: row.resultDigest,
      mutationId: row.mutationId,
      principalId: row.principalId,
      transitionId: row.transitionId,
      aggregateVersion: Number(row.aggregateVersion),
    });
    expect(ref).not.toBeInstanceOf(Error);

    const receipt = validateCompletionReceiptV0({
      schemaVersion: 'v0',
      kind: 'completion-receipt',
      receiptId: row.receiptId,
      outcome: 'committed',
      resultRef: ref,
      causationId: row.causationId,
      correlationId: row.correlationId,
    });
    expect(receipt).not.toBeInstanceOf(Error);
    expect(computeReceiptId({
      schemaVersion: 'v0',
      kind: 'completion-receipt',
      outcome: 'committed',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resultRef: ref as any,
      causationId: row.causationId,
      correlationId: row.correlationId,
    })).toBe(row.receiptId);
  });

  it('6. the outbox event carries the closed reference and no result body', async () => {
    const { taskId, attemptId } = await seedTaskWithAttempt();
    const outcome = await service.commitOwnedResult(
      prisma,
      proposal(taskId, attemptId, {
        resultNode: {
          nodeId: 'node-1',
          kind: 'task-card-result-node',
          value: { secretSummary: 'UNIQUE-BODY-MARKER' },
        },
      }),
    );
    const committed = outcome as CommittedResultOutcome;
    const outbox = await prisma.taskOutboxEvent.findUnique({
      where: { transitionId: committed.resultRef.transitionId },
    });
    const serialised = JSON.stringify(outbox.eventPayload);
    expect(serialised).toContain('muneral-committed-result-v0');
    expect(serialised).toContain(committed.resultRef.resultRefId);
    expect(serialised).not.toContain('UNIQUE-BODY-MARKER');

    // The body itself is durable, but only on the node relation.
    const node = await prisma.taskResultNode.findFirst({ where: { taskId } });
    expect(JSON.stringify(node.nodePayload)).toContain('UNIQUE-BODY-MARKER');
  });

  it('7. F6: repeating the same mutation replays with zero new rows', async () => {
    const { taskId, attemptId } = await seedTaskWithAttempt();
    const p = proposal(taskId, attemptId);
    const first = (await service.commitOwnedResult(prisma, p)) as CommittedResultOutcome;
    expect(first.replayed).toBe(false);

    const second = (await service.commitOwnedResult(prisma, p)) as CommittedResultOutcome;
    expect(second.replayed).toBe(true);
    expect(second.resultRef).toEqual(first.resultRef);
    expect(second.receipt).toEqual(first.receipt);

    expect(await prisma.taskCommittedResultRef.count({ where: { taskId } })).toBe(1);
    expect(await prisma.taskResultNode.count({ where: { taskId } })).toBe(1);
    // issue + start + commit — the replay added none.
    expect(await prisma.taskOutboxEvent.count({ where: { taskId } })).toBe(3);
  });

  // -- 8-10. uniqueness under real constraints ------------------------------

  it('8. F5: two concurrent writers at one node version produce one reference; the loser produces none', async () => {
    const { taskId, attemptId } = await seedTaskWithAttempt();

    // Both proposals read node version 0 and race to claim version 1.
    const [a, b] = await Promise.all([
      service.commitOwnedResult(prisma, proposal(taskId, attemptId)),
      service.commitOwnedResult(prisma, proposal(taskId, attemptId)),
    ]);

    const winners = [a, b].filter((o) => !(o instanceof Error));
    const losers = [a, b].filter((o) => o instanceof Error);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toBeInstanceOf(ResultBindingError);

    expect(await prisma.taskCommittedResultRef.count({ where: { taskId } })).toBe(1);
    expect(await prisma.taskResultNode.count({ where: { taskId } })).toBe(1);
  });

  it('9. the semantic uniqueness constraint rejects a duplicate at the database', async () => {
    const { taskId, attemptId } = await seedTaskWithAttempt();
    const outcome = (await service.commitOwnedResult(
      prisma,
      proposal(taskId, attemptId),
    )) as CommittedResultOutcome;
    const row = await prisma.taskCommittedResultRef.findUnique({
      where: { resultRefId: outcome.resultRef.resultRefId },
    });

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO public.task_committed_result_refs
           (result_ref_id, task_id, attempt_id, card_id, card_digest,
            projection_id, projection_digest, node_id, node_version,
            result_digest, mutation_id, mutation_digest, principal_id, transition_id,
            aggregate_version, result_node_id, receipt_id, causation_id,
            correlation_id, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 $15, $16, $17, $18, $19, NOW())`,
        'f'.repeat(64), row.taskId, row.attemptId, row.cardId, row.cardDigest,
        row.projectionId, row.projectionDigest, row.nodeId, row.nodeVersion,
        row.resultDigest, `mut-${randomUUID()}`, row.mutationDigest, row.principalId,
        row.transitionId, row.aggregateVersion, row.resultNodeId,
        'e'.repeat(64), row.causationId, row.correlationId,
      ),
    ).rejects.toThrow();
  });

  it('9b. a direct reference with forged binding fields fails the composite FK atomically', async () => {
    const { taskId, attemptId } = await seedTaskWithAttempt();
    const resultNodeId = randomUUID();
    const transitionId = randomUUID();
    const mutationId = `mut-fk-${randomUUID()}`;
    const resultDigest = 'f'.repeat(64);
    const nodesBefore = await prisma.taskResultNode.count({ where: { taskId } });
    const transitionsBefore = await prisma.taskExecutionTransition.count({
      where: { taskId },
    });

    await expect(
      prisma.$transaction(async (tx: typeof prisma) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO public.task_result_nodes
             (id, task_id, attempt_id, card_id, node_id, node_version,
              mutation_id, principal_id, node_payload, result_digest, recorded_at)
           VALUES ($1, $2, $3, 'card-1', 'node-fk', 1,
                   $4, 'forged-principal', '{}'::jsonb, $5, NOW())`,
          resultNodeId,
          taskId,
          attemptId,
          mutationId,
          resultDigest,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO public.task_execution_transitions
             (id, task_id, attempt_id, aggregate_version, event_type,
              idempotency_key, command_digest, transition_payload,
              committed_result, evidence_refs, causation_id, correlation_id,
              recorded_at)
           VALUES ($1, $2, $3, 3, 'attempt:succeeded', $4, $5,
                   '{}'::jsonb, '{}'::jsonb, '[]'::jsonb,
                   'cause-fk', 'corr-fk', NOW())`,
          transitionId,
          taskId,
          attemptId,
          `idem-fk-${randomUUID()}`,
          'b'.repeat(64),
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO public.task_committed_result_refs
             (result_ref_id, task_id, attempt_id, card_id, card_digest,
              projection_id, projection_digest, node_id, node_version,
              result_digest, mutation_id, mutation_digest, principal_id,
              transition_id, aggregate_version, result_node_id, receipt_id,
              causation_id, correlation_id, recorded_at)
           VALUES ($1, $2, $3, 'card-1', $4, 'proj-1', $5,
                   'node-fk', 1, $6, $7, $8, 'forged-principal',
                   $9, 3, $10, $11, 'cause-fk', 'corr-fk', NOW())`,
          'd'.repeat(64),
          taskId,
          attemptId,
          CARD_DIGEST,
          PROJECTION_DIGEST,
          resultDigest,
          mutationId,
          'c'.repeat(64),
          transitionId,
          resultNodeId,
          'e'.repeat(64),
        );
      }),
    ).rejects.toThrow(/task_committed_result_refs_binding_fkey/);

    expect(await prisma.taskResultNode.count({ where: { taskId } })).toBe(nodesBefore);
    expect(
      await prisma.taskExecutionTransition.count({ where: { taskId } }),
    ).toBe(transitionsBefore);
    expect(await prisma.taskCommittedResultRef.count({ where: { taskId } })).toBe(0);
  });

  it('10. the domain-separation check rejects a result digest equal to the card digest', async () => {
    const { taskId, attemptId } = await seedTaskWithAttempt();
    const outcome = (await service.commitOwnedResult(
      prisma,
      proposal(taskId, attemptId),
    )) as CommittedResultOutcome;
    const row = await prisma.taskCommittedResultRef.findUnique({
      where: { resultRefId: outcome.resultRef.resultRefId },
    });

    let raised = '';
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO public.task_committed_result_refs
           (result_ref_id, task_id, attempt_id, card_id, card_digest,
            projection_id, projection_digest, node_id, node_version,
            result_digest, mutation_id, mutation_digest, principal_id, transition_id,
            aggregate_version, result_node_id, receipt_id, causation_id,
            correlation_id, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 $15, $16, $17, $18, $19, NOW())`,
        'a'.repeat(64), row.taskId, row.attemptId, row.cardId, row.cardDigest,
        row.projectionId, row.projectionDigest, 'node-other', 1,
        // result_digest deliberately conflated with the instruction digest
        row.cardDigest, `mut-${randomUUID()}`, row.mutationDigest, row.principalId,
        row.transitionId, row.aggregateVersion, row.resultNodeId,
        'b'.repeat(64), row.causationId, row.correlationId,
      );
    } catch (err) {
      raised = err instanceof Error ? err.message : String(err);
    }
    expect(raised).toContain('domain_separation');
  });

  // -- 11-13. append-only and restrictive deletion ---------------------------

  it('11. the committed-result reference is append-only', async () => {
    const { taskId, attemptId } = await seedTaskWithAttempt();
    const outcome = (await service.commitOwnedResult(
      prisma,
      proposal(taskId, attemptId),
    )) as CommittedResultOutcome;

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE public.task_committed_result_refs SET principal_id = 'tampered'
          WHERE result_ref_id = $1`,
        outcome.resultRef.resultRefId,
      ),
    ).rejects.toThrow(/append-only/);

    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM public.task_committed_result_refs WHERE result_ref_id = $1`,
        outcome.resultRef.resultRefId,
      ),
    ).rejects.toThrow(/append-only/);
  });

  it('12. the result node is append-only', async () => {
    const { taskId, attemptId } = await seedTaskWithAttempt();
    await service.commitOwnedResult(prisma, proposal(taskId, attemptId));
    const node = await prisma.taskResultNode.findFirst({ where: { taskId } });

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE public.task_result_nodes SET result_digest = $2 WHERE id = $1`,
        node.id, 'c'.repeat(64),
      ),
    ).rejects.toThrow(/append-only/);

    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM public.task_result_nodes WHERE id = $1`,
        node.id,
      ),
    ).rejects.toThrow(/append-only/);
  });

  it('13. deleting a task with a committed result is refused', async () => {
    const { taskId, attemptId } = await seedTaskWithAttempt();
    await service.commitOwnedResult(prisma, proposal(taskId, attemptId));

    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM public.tasks WHERE id = $1`, taskId),
    ).rejects.toThrow();

    expect(await prisma.taskCommittedResultRef.count({ where: { taskId } })).toBe(1);
  });

  it('13b. result bindings and committed facts reject UPDATE, DELETE and TRUNCATE', async () => {
    const { taskId, attemptId } = await seedTaskWithAttempt();
    await service.commitOwnedResult(prisma, proposal(taskId, attemptId));

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE public.task_result_bindings SET principal_id = 'tampered'
          WHERE task_id = $1 AND attempt_id = $2 AND card_id = 'card-1'`,
        taskId,
        attemptId,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM public.task_result_bindings
          WHERE task_id = $1 AND attempt_id = $2 AND card_id = 'card-1'`,
        taskId,
        attemptId,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRawUnsafe(
        `TRUNCATE public.task_result_bindings CASCADE`,
      ),
    ).rejects.toThrow(/TRUNCATE rejected/);
    await expect(
      prisma.$executeRawUnsafe(
        `TRUNCATE public.task_committed_result_refs CASCADE`,
      ),
    ).rejects.toThrow(/TRUNCATE rejected/);
  });

  // -- 14-15. crash prefixes -------------------------------------------------

  it('14. F9/AC12: a crash before commit leaves zero rows in every relation', async () => {
    const { taskId, attemptId } = await seedTaskWithAttempt();
    const versionBefore = Number(
      (await prisma.taskExecutionState.findUnique({ where: { taskId } }))
        .aggregateVersion,
    );
    const before = {
      nodes: await prisma.taskResultNode.count({ where: { taskId } }),
      refs: await prisma.taskCommittedResultRef.count({ where: { taskId } }),
      transitions: await prisma.taskExecutionTransition.count({ where: { taskId } }),
      outbox: await prisma.taskOutboxEvent.count({ where: { taskId } }),
    };

    // A client whose transaction always aborts after the callback completes.
    // Every write the seam performed is inside that transaction.
    const crashing: TransactionalClient = {
      $transaction: (
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fn: (tx: any) => Promise<unknown>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        options?: Record<string, any>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ): Promise<any> =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        prisma.$transaction(async (tx: any) => {
          await fn(tx);
          throw new Error('crash before commit');
        }, options),
    };

    await expect(
      service.commitOwnedResult(crashing, proposal(taskId, attemptId)),
    ).rejects.toThrow('crash before commit');

    expect(await prisma.taskResultNode.count({ where: { taskId } })).toBe(before.nodes);
    expect(await prisma.taskCommittedResultRef.count({ where: { taskId } })).toBe(before.refs);
    expect(await prisma.taskExecutionTransition.count({ where: { taskId } })).toBe(
      before.transitions,
    );
    expect(await prisma.taskOutboxEvent.count({ where: { taskId } })).toBe(before.outbox);

    const state = await prisma.taskExecutionState.findUnique({ where: { taskId } });
    expect(Number(state.aggregateVersion)).toBe(versionBefore);
  });

  it('15. F4: a refused proposal writes nothing at all', async () => {
    const { taskId, attemptId } = await seedTaskWithAttempt();
    for (const bad of [
      { principalId: 'supervisor:fleet-controller' },
      { principalId: 'agent-arcana:forged' },
      { cardDigest: 'a'.repeat(64) },
      { projectionId: 'proj-forged' },
      { projectionDigest: 'b'.repeat(64) },
      { attemptId: randomUUID() },
      { expectedNodeVersion: 7 },
      { resultNode: { nodeId: 'node-1', desiredState: 'running' } },
    ]) {
      const outcome = await service.commitOwnedResult(
        prisma,
        proposal(taskId, attemptId, bad),
      );
      expect(outcome).toBeInstanceOf(Error);
    }
    expect(await prisma.taskResultNode.count({ where: { taskId } })).toBe(0);
    expect(await prisma.taskCommittedResultRef.count({ where: { taskId } })).toBe(0);
  });

  // -- 16. negative control --------------------------------------------------

  it('16. NEGATIVE CONTROL: only the disposable instance is reachable', () => {
    const url = pg.url();
    expect(url).toContain('localhost');
    expect(url).toContain(String(pg.port()));
    expect(url).toContain('muneral_result_authority_test');
    // The suite never reads an ambient DATABASE_URL.
    expect(url).not.toBe(process.env.DATABASE_URL);
    expect(pg.containerName).toMatch(/^muneral-result-authority-test-[0-9a-f]{8}$/);
  });
});
