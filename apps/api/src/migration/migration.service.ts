// MUN-0040 (AUP-DAT-002 identity / AUP-DAT-003 minimal Muneral path).
//
// The one job of this service is to keep four things that the legacy
// `POST /sync/datarim/:projectId/import` collapses into "created/updated
// counts" separable and readable back:
//
//   source occurrence  — a sighting, append-only, one row per receipt
//   logical task       — the LegacyIdentity behind (namespace, legacy id)
//   task revision      — tasks.revision, moved only by an explicit CAS
//   artifact reference — evidence refs on the transition's activity entry
//
// It is NOT a second task store. Every work item it creates is an ordinary
// row in `tasks`, reachable by every existing Muneral endpoint.
//
// Why this does not reuse ExecutionAuthorityService for the transition path:
// that aggregate versions the ATTEMPT lifecycle (issued/running/succeeded),
// keyed to a TaskExecutionAttempt with a retry budget and content-addressed
// evidence refs. A migration status move has no attempt, no retry budget and
// no execution. Routing it through that aggregate would mint a synthetic
// attempt per imported card — inventing execution history for work that was
// finished years ago in another tracker, which is exactly the "historical time
// is not execution time" confusion AUP-DAT-003 exists to prevent. The CAS here
// is therefore a single optimistic column on `tasks`, not a second state
// machine: it has no states of its own and defers every legality question to
// the shared TASK_TRANSITIONS table in @muneral/types.

import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { isValidTransition, type Actor, type TaskStatus } from '@muneral/types';
import { ActivityService } from '../activity/activity.service';
import {
  canonicalJson,
  CanonicalJsonError,
  jsonDigest,
  type JsonValue,
} from '../execution-authority/canonical-json';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateBatchDto } from './dto/create-batch.dto';
import type { CreateDecisionDto } from './dto/create-decision.dto';
import type { CreateTransitionDto } from './dto/create-transition.dto';
import type { CreateWorkItemDto } from './dto/create-work-item.dto';
import {
  batchKeyConflict,
  batchNotFound,
  batchNotOpen,
  bootstrapStampImmutable,
  bootstrapStampInvalid,
  idempotencyKeyConflict,
  identityNotFound,
  invalidIdentityDecision,
  invalidStatusTransition,
  mappingRevisionStale,
  projectNotFound,
  rawExcerptTooLarge,
  staleRevision,
  workItemNotFound,
} from './migration.errors';
import { mapHistoricalStatus, NOT_REVALIDATED } from './migration.status';

/** PostgreSQL unique-violation code as surfaced by Prisma. */
const UNIQUE_VIOLATION = 'P2002';

/**
 * An interactive-transaction client: the root client minus the methods that
 * cannot be called inside a transaction.
 *
 * Everything that must be exactly-once runs through one of these. PostgreSQL
 * aborts the whole transaction on a constraint violation and Prisma opens no
 * per-statement savepoint, so a caught unique violation leaves the session
 * unusable: `catch (P2002) { re-read }` inside a transaction is dead code that
 * turns into a 500. Every insert that can legitimately collide is therefore
 * written as `INSERT ... ON CONFLICT DO NOTHING` followed by a read, which
 * never raises in the first place.
 */
type PrismaTx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * MIG-003: the stamp is a BOUNDED receipt.
 *
 * The database CHECK is deliberately looser (16 KiB) than this service bound
 * (8 KiB), because the two measure different bytes: this measures compact
 * canonical JSON, while PostgreSQL renders `jsonb::text` with a space after
 * every `:` and `,`. Equal numbers would leave a window where the service
 * accepted a stamp and the CHECK rejected it as an untyped 500 — the exact
 * outcome the service-side guard exists to prevent. Looser-at-the-database
 * means the typed 400 always wins, and the CHECK stays a real backstop for any
 * other writer.
 */
const MAX_BOOTSTRAP_STAMP_BYTES = 8192;

/** AUP-X01: the excerpt is bounded at 16 KiB — BYTES, matching the CHECK.
 *  A character bound would let ~9 000 characters of Cyrillic (18 000 bytes)
 *  past validation and into an untyped constraint failure, which is precisely
 *  the content this surface exists to import. */
const MAX_RAW_EXCERPT_BYTES = 16384;

const TX_OPTS = {
  maxWait: 10_000,
  timeout: 30_000,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
};

type IdempotencyScope = 'work_item' | 'transition';

@Injectable()
export class MigrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
  ) {}

  // -------------------------------------------------------------------------
  // Batches
  // -------------------------------------------------------------------------

  /**
   * Create (or re-return) a migration batch.
   *
   * `created` distinguishes the 201 from the 200 replay for the controller;
   * the batch body itself is identical either way, so a caller that lost the
   * first response cannot tell — and does not need to tell — which it got.
   */
  async createBatch(
    dto: CreateBatchDto,
  ): Promise<{ created: boolean; batch: Record<string, unknown> }> {
    const project = await this.prisma.project.findUnique({
      where: { id: dto.projectId },
      select: { id: true },
    });
    if (!project) throw projectNotFound(dto.projectId);

    const requestDigest = jsonDigest({
      batchKey: dto.batchKey,
      sourceSetEpoch: dto.sourceSetEpoch,
      producer: dto.producer,
      projectId: dto.projectId,
    });

    const existing = await this.prisma.migrationBatch.findUnique({
      where: { batchKey: dto.batchKey },
    });
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw batchKeyConflict(dto.batchKey);
      return { created: false, batch: presentBatch(existing) };
    }

    try {
      const batch = await this.prisma.migrationBatch.create({
        data: {
          batchKey: dto.batchKey,
          sourceSetEpoch: dto.sourceSetEpoch,
          producer: dto.producer,
          projectId: dto.projectId,
          requestDigest,
          status: 'open',
        },
      });
      return { created: true, batch: presentBatch(batch) };
    } catch (err) {
      // Lost the create race against a concurrent request for the same key.
      // The winner's row is authoritative; re-read and treat it as a replay.
      if (!isUniqueViolation(err)) throw err;
      const winner = await this.prisma.migrationBatch.findUnique({
        where: { batchKey: dto.batchKey },
      });
      if (!winner) throw err;
      if (winner.requestDigest !== requestDigest) throw batchKeyConflict(dto.batchKey);
      return { created: false, batch: presentBatch(winner) };
    }
  }

  async getBatch(batchId: string): Promise<Record<string, unknown>> {
    const batch = await this.prisma.migrationBatch.findUnique({ where: { id: batchId } });
    if (!batch) throw batchNotFound(batchId);
    return presentBatch(batch);
  }

  /**
   * Close a batch with a deterministic receipt.
   *
   * The digest covers the sorted `(source_locator, content_digest)` pairs of
   * every occurrence in the batch, so two importers that recorded the same
   * receipts agree on the digest regardless of insertion order. Committing an
   * already-committed batch returns the stored receipt verbatim rather than
   * minting a second one — the receipt is write-once, at the database too.
   */
  async commitBatch(batchId: string): Promise<Record<string, unknown>> {
    return this.prisma.$transaction(async (tx) => {
      // Lock the batch row first. Two concurrent commits would otherwise both
      // read `open`, compute receipts over different occurrence sets if one
      // lands between their reads, and the loser's UPDATE would trip the
      // write-once receipt trigger as an untyped 500.
      const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status FROM public.migration_batches WHERE id = ${batchId}::uuid FOR UPDATE
      `;
      if (locked.length === 0) throw batchNotFound(batchId);

      const batch = await tx.migrationBatch.findUniqueOrThrow({ where: { id: batchId } });
      if (batch.status === 'committed') return presentBatch(batch);

      const occurrences = await tx.sourceOccurrence.findMany({
        where: { batchId },
        select: {
          sourceLocator: true,
          contentDigest: true,
          legacyIdentityId: true,
          identity: { select: { taskId: true } },
        },
      });

      const pairs = occurrences
        .map((o) => [o.sourceLocator, o.contentDigest] as [string, string])
        .sort((a, b) => (a[0] === b[0] ? compare(a[1], b[1]) : compare(a[0], b[0])));

      const receipt = {
        batchKey: batch.batchKey,
        sourceSetEpoch: batch.sourceSetEpoch,
        producer: batch.producer,
        counts: {
          occurrences: occurrences.length,
          identities: new Set(occurrences.map((o) => o.legacyIdentityId)).size,
          workItems: new Set(
            occurrences.map((o) => o.identity.taskId).filter((id): id is string => id !== null),
          ).size,
        },
        occurrenceDigest: jsonDigest(pairs as unknown as JsonValue),
      };

      const committed = await tx.migrationBatch.update({
        where: { id: batchId },
        data: {
          status: 'committed',
          committedAt: new Date(),
          receipt: receipt as unknown as Prisma.InputJsonValue,
        },
      });
      return presentBatch(committed);
    }, TX_OPTS);
  }

  // -------------------------------------------------------------------------
  // Work items
  // -------------------------------------------------------------------------

  /**
   * Import one historical card as a Muneral work item.
   *
   * Concurrency contract (AUP-DAT-002 acceptance): N concurrent requests for
   * one (namespace, legacy id) produce ONE identity, ONE task and N source
   * receipts. The serialization point is a `SELECT ... FOR UPDATE` on the
   * identity row: the insert is attempted with ON CONFLICT DO NOTHING so
   * neither racer fails, and whichever transaction takes the row lock first
   * binds the task while the other waits and then observes the binding.
   */
  async createWorkItem(
    dto: CreateWorkItemDto,
    actor: Actor,
  ): Promise<{ replayed: boolean; body: Record<string, unknown> }> {
    const requestDigest = jsonDigest(workItemRequestShape(dto));

    const batch = await this.prisma.migrationBatch.findUnique({
      where: { id: dto.batchId },
      select: { id: true, projectId: true, status: true },
    });
    if (!batch) throw batchNotFound(dto.batchId);
    if (batch.status !== 'open') throw batchNotOpen(dto.batchId, batch.status);

    if (dto.bootstrapStamp) assertBoundedBootstrapStamp(dto.bootstrapStamp);
    assertBoundedExcerpt(dto.occurrence.rawExcerpt);

    const mapped = mapHistoricalStatus(dto.historicalStatus);

    const outcome = await this.prisma.$transaction(async (tx) => {
      // 0. Claim the idempotency key FIRST, inside the same transaction as the
      //    write it guards. A concurrent request for the same key blocks here
      //    until this transaction ends, then reads the stored response instead
      //    of performing a second write. Claiming it afterwards — or outside a
      //    transaction — lets N racers all write under one key.
      const claimed = await this.claimIdempotencyKey(
        tx,
        'work_item',
        dto.idempotencyKey,
        requestDigest,
      );
      if (claimed !== null) return { replayed: true, body: claimed };

      // 1. Ensure the identity row exists without either racer erroring.
      //    Schema-qualified: `search_path` is `"$user", public`, so an
      //    unqualified name could resolve to a same-named table in a schema
      //    matching the role while every Prisma-generated query kept using
      //    public — a split brain that would be very hard to see.
      await tx.$executeRaw`
        INSERT INTO public.legacy_identities (source_namespace, legacy_id)
        VALUES (${dto.sourceNamespace}, ${dto.legacyId})
        ON CONFLICT (source_namespace, legacy_id) DO NOTHING
      `;

      // 2. Take the row lock. This is what makes step 3 exactly-once.
      const locked = await tx.$queryRaw<Array<{ id: string; task_id: string | null }>>`
        SELECT id, task_id FROM public.legacy_identities
        WHERE source_namespace = ${dto.sourceNamespace} AND legacy_id = ${dto.legacyId}
        FOR UPDATE
      `;
      if (locked.length === 0) {
        // Unreachable: the insert above guarantees the row, and the FOR UPDATE
        // read runs in the same transaction. Fail loudly rather than crash on
        // an undefined index if that ever stops being true.
        throw new Error(
          `legacy identity row vanished for ("${dto.sourceNamespace}", "${dto.legacyId}")`,
        );
      }
      const identityId = locked[0].id;
      let taskId = locked[0].task_id;

      // 3. Bind the work item once. A second importer of the same identity
      //    adds a receipt to the existing task; it never forks a new one, and
      //    a changed title on its own never creates one either.
      if (taskId === null) {
        const task = await tx.task.create({
          data: {
            projectId: batch.projectId,
            title: dto.title,
            description: dto.description ?? null,
            status: mapped.taskStatus,
            priority: dto.priority ?? 'medium',
            actorType: actor.type,
            createdById: actor.type === 'human' ? actor.id : null,
            // The import time. The HISTORICAL time stays on the occurrence.
            importedAt: new Date(),
            ...(dto.bootstrapStamp
              ? { bootstrapStamp: dto.bootstrapStamp as Prisma.InputJsonValue }
              : {}),
          },
        });
        taskId = task.id;
        await tx.legacyIdentity.update({
          where: { id: identityId },
          data: { taskId, updatedAt: new Date() },
        });
      } else if (dto.bootstrapStamp) {
        // MIG-003: the stamp belongs to the FIRST revision of the work item.
        // Offering one to an already-bootstrapped item is rejected rather
        // than silently dropped, so a caller cannot believe it took effect.
        const current = await tx.task.findUnique({
          where: { id: taskId },
          select: { bootstrapStamp: true },
        });
        if (current?.bootstrapStamp != null) throw bootstrapStampImmutable(taskId);
        await tx.task.update({
          where: { id: taskId },
          data: { bootstrapStamp: dto.bootstrapStamp as Prisma.InputJsonValue },
        });
      }

      // 4. Record the source receipt. An exact repeat of the same receipt
      //    (same locator, same content) is the same sighting, not a new one —
      //    written as ON CONFLICT DO NOTHING so the repeat costs a no-op
      //    instead of aborting the transaction.
      const occurrenceId = await this.recordOccurrence(tx, {
        legacyIdentityId: identityId,
        batchId: dto.batchId,
        sourceRoot: dto.occurrence.sourceRoot,
        sourceLocator: dto.occurrence.sourceLocator,
        sourceKey: dto.occurrence.sourceKey,
        contentDigest: dto.occurrence.contentDigest,
        capturedAt: new Date(dto.occurrence.capturedAt),
        historicalStatus: mapped.historicalStatus,
        historicalAssertedDone: mapped.historicalAssertedDone,
        currentVerification: NOT_REVALIDATED,
        historicalAt: dto.occurrence.historicalAt
          ? new Date(dto.occurrence.historicalAt)
          : null,
        rawExcerpt: dto.occurrence.rawExcerpt ?? null,
      });

      const occurrence = await tx.sourceOccurrence.findUniqueOrThrow({
        where: { id: occurrenceId },
      });
      const identity = await tx.legacyIdentity.findUniqueOrThrow({ where: { id: identityId } });
      const task = await tx.task.findUniqueOrThrow({ where: { id: taskId } });

      const body: Record<string, unknown> = {
        workItem: presentTask(task),
        identity: presentIdentity(identity),
        occurrence: presentOccurrence(occurrence),
        statusMapping: {
          historicalStatus: mapped.historicalStatus,
          taskStatus: mapped.taskStatus,
          unmapped: mapped.unmapped,
        },
      };

      await this.storeIdempotentResponse(tx, 'work_item', dto.idempotencyKey, body);
      return { replayed: false, body };
    }, TX_OPTS);

    return outcome;
  }

  /** Full readback for a (namespace, legacy id) pair — the answer to a lost
   *  response. Occurrences come back oldest-first. */
  async getWorkItemByLegacy(
    sourceNamespace: string,
    legacyId: string,
  ): Promise<Record<string, unknown>> {
    const identity = await this.prisma.legacyIdentity.findUnique({
      where: { sourceNamespace_legacyId: { sourceNamespace, legacyId } },
      include: { occurrences: { orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }] } },
    });
    if (!identity) throw workItemNotFound({ sourceNamespace, legacyId });

    const task = identity.taskId
      ? await this.prisma.task.findUnique({ where: { id: identity.taskId } })
      : null;

    return {
      identity: presentIdentity(identity),
      workItem: task ? presentTask(task) : null,
      revision: task?.revision ?? null,
      bootstrapStamp: task?.bootstrapStamp ?? null,
      occurrences: identity.occurrences.map(presentOccurrence),
    };
  }

  /**
   * The searchable-alias lookup: every identity carrying this historical ID,
   * in every namespace. The point is that they come back as SEPARATE rows —
   * `ARAS-0001` from a nested tracker and `ARAS-0001` of the root workspace
   * are two answers here, never one merged answer.
   */
  async searchByLegacyId(legacyId: string): Promise<Record<string, unknown>> {
    const identities = await this.prisma.legacyIdentity.findMany({
      where: { legacyId },
      orderBy: [{ sourceNamespace: 'asc' }],
      include: { _count: { select: { occurrences: true } } },
    });
    return {
      legacyId,
      total: identities.length,
      identities: identities.map((i) => ({
        ...presentIdentity(i),
        occurrenceCount: i._count.occurrences,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Transitions — the single CAS path
  // -------------------------------------------------------------------------

  /**
   * Apply ONE compare-and-set transition.
   *
   * The whole operation — claiming the key, the CAS, the audit entry and the
   * stored response — is a single transaction. Split across separate
   * round-trips, a crash after the CAS leaves a work item whose revision has
   * moved, whose audit entry is missing, and whose idempotency key was never
   * recorded: the retry then fails STALE_REVISION forever. The one operation
   * whose purpose is surviving a lost response has to survive its own.
   */
  async transition(
    taskId: string,
    dto: CreateTransitionDto,
    actor: Actor,
  ): Promise<{ replayed: boolean; body: Record<string, unknown> }> {
    const requestDigest = jsonDigest({
      taskId,
      expectedRevision: dto.expectedRevision,
      toStatus: dto.toStatus,
      basis: dto.basis,
      evidenceRefs: [...(dto.evidenceRefs ?? [])].sort(),
    });

    return this.prisma.$transaction(async (tx) => {
      const claimed = await this.claimIdempotencyKey(
        tx,
        'transition',
        dto.idempotencyKey,
        requestDigest,
      );
      if (claimed !== null) return { replayed: true, body: claimed };

      const task = await tx.task.findUnique({
        where: { id: taskId },
        select: { id: true, status: true, revision: true, projectId: true },
      });
      if (!task) throw workItemNotFound({ taskId });
      if (task.revision !== dto.expectedRevision) {
        throw staleRevision(taskId, task.revision, task.status);
      }
      if (!isValidTransition(task.status as TaskStatus, dto.toStatus)) {
        throw invalidStatusTransition(task.status, dto.toStatus);
      }

      const project = await tx.project.findUniqueOrThrow({
        where: { id: task.projectId },
        select: { workspaceId: true },
      });

      // The compare-and-set itself. It guards on the STATUS as well as the
      // revision: `revision` is bumped by this path alone, so an ordinary
      // `PATCH /tasks/:id/status` moves the status while leaving the revision
      // where it was. Guarding on the counter only would let this overwrite an
      // operator's decision — including with a move the state machine forbids.
      const updated = await tx.task.updateMany({
        where: { id: taskId, revision: dto.expectedRevision, status: task.status },
        data: { status: dto.toStatus, revision: { increment: 1 } },
      });
      if (updated.count === 0) {
        const current = await tx.task.findUnique({
          where: { id: taskId },
          select: { revision: true, status: true },
        });
        throw staleRevision(
          taskId,
          current?.revision ?? dto.expectedRevision,
          current?.status ?? task.status,
        );
      }

      const revision = dto.expectedRevision + 1;
      await this.activity.log(
        {
          workspaceId: project.workspaceId,
          taskId,
          actor,
          action: 'migration.transition',
          payload: {
            fromStatus: task.status,
            toStatus: dto.toStatus,
            revision,
            basis: dto.basis,
            evidenceRefs: dto.evidenceRefs ?? [],
            idempotencyKey: dto.idempotencyKey,
          },
        },
        tx,
      );

      const body: Record<string, unknown> = {
        taskId,
        fromStatus: task.status,
        toStatus: dto.toStatus,
        revision,
        basis: dto.basis,
        evidenceRefs: dto.evidenceRefs ?? [],
      };
      await this.storeIdempotentResponse(tx, 'transition', dto.idempotencyKey, body);
      return { replayed: false, body };
    }, TX_OPTS);
  }

  // -------------------------------------------------------------------------
  // Identity decisions
  // -------------------------------------------------------------------------

  /**
   * Record a same/split/merge/candidate_conflict decision and return the full
   * reverse mapping.
   *
   * Direction matters and is stored, not inferred: a `split` writes
   * subject -> target edges, a `merge` writes target -> subject edges. Both
   * directions are returned so the caller can walk the mapping either way,
   * which is what "returns a full reverse mapping" asks for. A
   * `candidate_conflict` records a PROPOSAL: it stores edges and moves no task
   * binding, because a similarity signal may only ask for review.
   */
  async decide(
    identityId: string,
    dto: CreateDecisionDto,
    actor: Actor,
  ): Promise<Record<string, unknown>> {
    const subject = await this.prisma.legacyIdentity.findUnique({ where: { id: identityId } });
    if (!subject) throw identityNotFound(identityId);
    if (subject.mappingRevision !== dto.expectedMappingRevision) {
      throw mappingRevisionStale(identityId, subject.mappingRevision);
    }
    if (dto.targets.includes(identityId)) {
      throw invalidIdentityDecision('an identity cannot be a target of its own decision');
    }

    const targets = await this.prisma.legacyIdentity.findMany({
      where: { id: { in: dto.targets } },
      select: { id: true },
    });
    const found = new Set(targets.map((t) => t.id));
    const missing = dto.targets.find((t) => !found.has(t));
    if (missing) throw identityNotFound(missing);

    const nextRevision = dto.expectedMappingRevision + 1;
    const decidedAt = new Date();

    await this.prisma.$transaction(async (tx) => {
      const bumped = await tx.legacyIdentity.updateMany({
        where: { id: identityId, mappingRevision: dto.expectedMappingRevision },
        data: {
          mappingKind: dto.kind,
          mappingRevision: nextRevision,
          decidedBy: actor.id,
          decidedAt,
          updatedAt: decidedAt,
        },
      });
      if (bumped.count === 0) {
        const current = await tx.legacyIdentity.findUnique({
          where: { id: identityId },
          select: { mappingRevision: true },
        });
        throw mappingRevisionStale(identityId, current?.mappingRevision ?? nextRevision);
      }

      await tx.identityMapping.createMany({
        data: [...new Set(dto.targets)].map((target) => ({
          // merge: the targets fold INTO the subject, so the subject is `to`.
          fromIdentityId: dto.kind === 'merge' ? target : identityId,
          toIdentityId: dto.kind === 'merge' ? identityId : target,
          kind: dto.kind,
          mappingRevision: nextRevision,
          basis: dto.basis,
          decidedBy: actor.id,
          decidedAt,
        })),
      });
    }, TX_OPTS);

    return this.getReverseMapping(identityId);
  }

  async getReverseMapping(identityId: string): Promise<Record<string, unknown>> {
    const identity = await this.prisma.legacyIdentity.findUnique({ where: { id: identityId } });
    if (!identity) throw identityNotFound(identityId);

    const [outgoing, incoming] = await Promise.all([
      this.prisma.identityMapping.findMany({
        where: { fromIdentityId: identityId },
        orderBy: [{ mappingRevision: 'asc' }, { toIdentityId: 'asc' }],
        include: { toIdentity: true },
      }),
      this.prisma.identityMapping.findMany({
        where: { toIdentityId: identityId },
        orderBy: [{ mappingRevision: 'asc' }, { fromIdentityId: 'asc' }],
        include: { fromIdentity: true },
      }),
    ]);

    return {
      identity: presentIdentity(identity),
      mappings: {
        outgoing: outgoing.map((m) => ({
          ...presentMapping(m),
          to: presentIdentity(m.toIdentity),
        })),
        incoming: incoming.map((m) => ({
          ...presentMapping(m),
          from: presentIdentity(m.fromIdentity),
        })),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Idempotency replay store
  // -------------------------------------------------------------------------

  /**
   * Reserve `idempotencyKey` for this transaction, or return the response a
   * previous request already stored under it.
   *
   * `INSERT ... ON CONFLICT DO NOTHING` is the whole mechanism. A concurrent
   * request for the same key blocks on the uncommitted insert until this
   * transaction ends, then inserts nothing and reads the committed response —
   * so N deliveries of one command produce one write and N identical answers.
   * A read-then-write check could not do this: every racer would read "absent"
   * and every racer would write.
   *
   * Returns `null` when this transaction now owns the key.
   */
  private async claimIdempotencyKey(
    tx: PrismaTx,
    scope: IdempotencyScope,
    idempotencyKey: string,
    requestDigest: string,
  ): Promise<Record<string, unknown> | null> {
    const inserted = await tx.$executeRaw`
      INSERT INTO public.migration_idempotency_records
        (scope, idempotency_key, request_digest, response)
      VALUES (${scope}, ${idempotencyKey}, ${requestDigest}, '{}'::jsonb)
      ON CONFLICT (scope, idempotency_key) DO NOTHING
    `;
    if (inserted === 1) return null;

    const existing = await tx.migrationIdempotencyRecord.findUniqueOrThrow({
      where: { scope_idempotencyKey: { scope, idempotencyKey } },
    });
    if (existing.requestDigest !== requestDigest) {
      throw idempotencyKeyConflict(scope, idempotencyKey);
    }
    return existing.response as Record<string, unknown>;
  }

  /** Fill in the response for the key this transaction claimed. Committed with
   *  the write it describes, so a stored response always has a write behind it. */
  private async storeIdempotentResponse(
    tx: PrismaTx,
    scope: IdempotencyScope,
    idempotencyKey: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    await tx.migrationIdempotencyRecord.update({
      where: { scope_idempotencyKey: { scope, idempotencyKey } },
      data: { response: response as unknown as Prisma.InputJsonValue },
    });
  }

  /**
   * Insert a source receipt, or return the id of the identical one already
   * recorded. Written as ON CONFLICT DO NOTHING rather than try/catch: a
   * unique violation aborts the enclosing PostgreSQL transaction, so recovering
   * from one inside `$transaction` is impossible — the recovery statement
   * itself fails with "current transaction is aborted".
   */
  private async recordOccurrence(
    tx: PrismaTx,
    data: {
      legacyIdentityId: string;
      batchId: string;
      sourceRoot: string;
      sourceLocator: string;
      sourceKey: string;
      contentDigest: string;
      capturedAt: Date;
      historicalStatus: string;
      historicalAssertedDone: boolean;
      currentVerification: string;
      historicalAt: Date | null;
      rawExcerpt: string | null;
    },
  ): Promise<string> {
    const inserted = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO public.source_occurrences (
        legacy_identity_id, batch_id, source_root, source_locator, source_key,
        content_digest, captured_at, historical_status, historical_asserted_done,
        current_verification, historical_at, raw_excerpt
      ) VALUES (
        ${data.legacyIdentityId}::uuid, ${data.batchId}::uuid, ${data.sourceRoot},
        ${data.sourceLocator}, ${data.sourceKey}, ${data.contentDigest},
        ${data.capturedAt}, ${data.historicalStatus}, ${data.historicalAssertedDone},
        ${data.currentVerification}, ${data.historicalAt}, ${data.rawExcerpt}
      )
      ON CONFLICT (legacy_identity_id, source_locator, content_digest) DO NOTHING
      RETURNING id
    `;
    if (inserted.length === 1) return inserted[0].id;

    const existing = await tx.sourceOccurrence.findFirstOrThrow({
      where: {
        legacyIdentityId: data.legacyIdentityId,
        sourceLocator: data.sourceLocator,
        contentDigest: data.contentDigest,
      },
      select: { id: true },
    });
    return existing.id;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reject an oversized or non-JSON stamp with a reason, before the database
 *  reduces it to an opaque constraint violation. */
function assertBoundedBootstrapStamp(stamp: Record<string, unknown>): void {
  let serialized: string;
  try {
    serialized = canonicalJson(stamp as JsonValue);
  } catch (err) {
    throw bootstrapStampInvalid(
      err instanceof CanonicalJsonError ? err.message : 'it is not canonical JSON',
    );
  }
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_BOOTSTRAP_STAMP_BYTES) {
    throw bootstrapStampInvalid(
      `it serializes to ${bytes} bytes, over the ${MAX_BOOTSTRAP_STAMP_BYTES}-byte bound`,
    );
  }
}

/** Bound the excerpt in the same units the database counts. */
function assertBoundedExcerpt(rawExcerpt: string | undefined): void {
  if (rawExcerpt === undefined) return;
  const bytes = Buffer.byteLength(rawExcerpt, 'utf8');
  if (bytes > MAX_RAW_EXCERPT_BYTES) {
    throw rawExcerptTooLarge(bytes, MAX_RAW_EXCERPT_BYTES);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === UNIQUE_VIOLATION
  );
}

/** Byte-stable ordering, independent of the runtime's locale. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The fields that make two import requests "the same request". The batch is
 *  included: replaying a key against a different batch is a caller bug. */
function workItemRequestShape(dto: CreateWorkItemDto): JsonValue {
  return {
    batchId: dto.batchId,
    sourceNamespace: dto.sourceNamespace,
    legacyId: dto.legacyId,
    title: dto.title,
    description: dto.description ?? null,
    priority: dto.priority ?? null,
    historicalStatus: dto.historicalStatus,
    occurrence: {
      sourceRoot: dto.occurrence.sourceRoot,
      sourceLocator: dto.occurrence.sourceLocator,
      sourceKey: dto.occurrence.sourceKey,
      contentDigest: dto.occurrence.contentDigest,
      capturedAt: dto.occurrence.capturedAt,
      historicalAt: dto.occurrence.historicalAt ?? null,
      rawExcerpt: dto.occurrence.rawExcerpt ?? null,
    },
    bootstrapStamp: (dto.bootstrapStamp ?? null) as JsonValue,
  };
}

type BatchRow = {
  id: string;
  batchKey: string;
  sourceSetEpoch: string;
  producer: string;
  projectId: string;
  status: string;
  requestDigest: string;
  receipt: unknown;
  createdAt: Date;
  committedAt: Date | null;
};

function presentBatch(batch: BatchRow): Record<string, unknown> {
  return {
    id: batch.id,
    batchKey: batch.batchKey,
    sourceSetEpoch: batch.sourceSetEpoch,
    producer: batch.producer,
    projectId: batch.projectId,
    status: batch.status,
    requestDigest: batch.requestDigest,
    receipt: batch.receipt ?? null,
    createdAt: batch.createdAt.toISOString(),
    committedAt: batch.committedAt ? batch.committedAt.toISOString() : null,
  };
}

type IdentityRow = {
  id: string;
  sourceNamespace: string;
  legacyId: string;
  taskId: string | null;
  mappingKind: string;
  mappingRevision: number;
  decidedBy: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function presentIdentity(identity: IdentityRow): Record<string, unknown> {
  return {
    id: identity.id,
    sourceNamespace: identity.sourceNamespace,
    legacyId: identity.legacyId,
    taskId: identity.taskId,
    mappingKind: identity.mappingKind,
    mappingRevision: identity.mappingRevision,
    decidedBy: identity.decidedBy,
    decidedAt: identity.decidedAt ? identity.decidedAt.toISOString() : null,
    createdAt: identity.createdAt.toISOString(),
    updatedAt: identity.updatedAt.toISOString(),
  };
}

type OccurrenceRow = {
  id: string;
  legacyIdentityId: string;
  batchId: string;
  sourceRoot: string;
  sourceLocator: string;
  sourceKey: string;
  contentDigest: string;
  capturedAt: Date;
  historicalStatus: string;
  historicalAssertedDone: boolean;
  currentVerification: string;
  historicalAt: Date | null;
  rawExcerpt: string | null;
  recordedAt: Date;
};

function presentOccurrence(occurrence: OccurrenceRow): Record<string, unknown> {
  return {
    id: occurrence.id,
    legacyIdentityId: occurrence.legacyIdentityId,
    batchId: occurrence.batchId,
    sourceRoot: occurrence.sourceRoot,
    sourceLocator: occurrence.sourceLocator,
    sourceKey: occurrence.sourceKey,
    contentDigest: occurrence.contentDigest,
    capturedAt: occurrence.capturedAt.toISOString(),
    historicalStatus: occurrence.historicalStatus,
    historicalAssertedDone: occurrence.historicalAssertedDone,
    currentVerification: occurrence.currentVerification,
    historicalAt: occurrence.historicalAt ? occurrence.historicalAt.toISOString() : null,
    rawExcerpt: occurrence.rawExcerpt,
    recordedAt: occurrence.recordedAt.toISOString(),
  };
}

type TaskRow = {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  revision: number;
  importedAt: Date | null;
  bootstrapStamp: unknown;
  createdAt: Date;
};

function presentTask(task: TaskRow): Record<string, unknown> {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    revision: task.revision,
    // Import time, deliberately distinct from any historical date.
    importedAt: task.importedAt ? task.importedAt.toISOString() : null,
    bootstrapStamp: task.bootstrapStamp ?? null,
    createdAt: task.createdAt.toISOString(),
  };
}

type MappingRow = {
  id: string;
  fromIdentityId: string;
  toIdentityId: string;
  kind: string;
  mappingRevision: number;
  basis: string;
  decidedBy: string;
  decidedAt: Date;
};

function presentMapping(mapping: MappingRow): Record<string, unknown> {
  return {
    id: mapping.id,
    fromIdentityId: mapping.fromIdentityId,
    toIdentityId: mapping.toIdentityId,
    kind: mapping.kind,
    mappingRevision: mapping.mappingRevision,
    basis: mapping.basis,
    decidedBy: mapping.decidedBy,
    decidedAt: mapping.decidedAt.toISOString(),
  };
}
