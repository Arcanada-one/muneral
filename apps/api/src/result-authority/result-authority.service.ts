// MUN-0021 adoption gate: the authoritative committed-result commit seam.
//
//   Agent Arcana execution adapter
//     -> OwnedResultMutationV0 proposal
//     -> Muneral validates projection ownership, principal and expected version
//     -> atomic result node + transition + reference + receipt + outbox commit
//     -> adapter or orchestrator relays the already-authored receipt
//
// The adapter never authors the receipt and never supplies an authoritative
// digest. Every digest is recomputed by the server from the committed
// canonical bytes inside the accepting transaction.
//
// Round-5 boundary: this seam commits immutable Muneral task facts. It owns no
// fleet registry, lifecycle, placement, update, watchdog, telemetry
// aggregation, or direct command routing.

import { StaleVersionError } from '../execution-authority/execution-authority.errors';
import { ExecutionAuthorityService } from '../execution-authority/execution-authority.service';
import type {
  ExecutionResult,
  TransactionalClient,
} from '../execution-authority/execution-authority.service';
import type {
  Clock,
  IdSource,
  TaskExecutionState,
  TaskExecutionTransition,
  TransitionAttemptCommand,
} from '../execution-authority/execution-authority.types';
import type { OutboxEvent } from '../outbox/outbox.types';
import { computeReceiptId, computeResultRefId, resultNodeDigest } from './result-authority.canonical';
import {
  AdapterAuthorityError,
  ResultBindingError,
  ResultContractError,
  ResultPlaneError,
} from './result-authority.errors';
import {
  validateCommittedResultRefV0,
  validateCompletionReceiptV0,
  validateOwnedResultMutationV0,
} from './result-authority.guards';
import type {
  CommittedResultEnvelopeV0,
  CommittedResultRefV0,
  CompletionReceiptV0,
  OwnedResultMutationV0,
} from './result-authority.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrismaTx = any;

const TX_OPTS = {
  maxWait: 10_000,
  timeout: 30_000,
  isolationLevel: 'ReadCommitted' as const,
};

/**
 * Attempt statuses from which a result may be committed. The MUN-0020 reducer
 * permits `attempt:succeeded` only from `running`, so refusing anything else
 * here turns what would otherwise surface as a generic invalid-transition into
 * a typed binding refusal with zero writes.
 */
const COMMITTABLE_ATTEMPT_STATUSES = new Set(['running']);

export interface CommittedResultOutcome {
  resultRef: CommittedResultRefV0;
  receipt: CompletionReceiptV0;
  /** Row id of the committed result node. Absent on idempotent replay. */
  resultNodeId?: string;
  /** True when this call returned an already-committed reference unchanged. */
  replayed: boolean;
  transition?: TaskExecutionTransition;
  state?: TaskExecutionState;
  outboxEvent?: OutboxEvent;
}

export type CommitOwnedResultOutcome =
  | CommittedResultOutcome
  | ResultContractError
  | ResultPlaneError
  | ResultBindingError
  | AdapterAuthorityError
  | Error;

export class ResultAuthorityService {
  private readonly authority: ExecutionAuthorityService;

  constructor(
    private readonly clock: Clock,
    private readonly idSource: IdSource,
    authority?: ExecutionAuthorityService,
  ) {
    this.authority =
      authority ?? new ExecutionAuthorityService(clock, idSource);
  }

  /**
   * Accept an adapter-proposed owned result mutation and commit the node,
   * transition, reference, receipt and outbox fact atomically.
   *
   * Returns a typed error for every refusal. A refusal leaves zero durable
   * rows; a post-mutation failure rolls the whole set back.
   */
  async commitOwnedResult(
    prisma: TransactionalClient,
    proposal: unknown,
  ): Promise<CommitOwnedResultOutcome> {
    try {
      return await prisma.$transaction(
        (tx: PrismaTx) => this.commitInTransaction(tx, proposal),
        TX_OPTS,
      );
    } catch (err) {
      // The uniqueness constraints on (transition), (task, attempt, card,
      // node, node version) and (task, mutation) are the arbiters of a race.
      // The loser's transaction rolled back and produced no reference, no
      // receipt and no outbox row.
      if (isPrismaUniqueViolation(err)) {
        return new ResultBindingError(
          'committed-result reference',
          'an unclaimed node version',
          'a concurrently committed reference for the same semantic result',
        );
      }
      // Two writers at one node version also collide on the aggregate version.
      // The loser's transaction rolled back and produced no node, reference,
      // receipt, transition or outbox row.
      if (err instanceof StaleVersionError) {
        return new ResultBindingError(
          'aggregateVersion',
          String(err.expectedVersion),
          'a concurrently committed transition on the same aggregate',
        );
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------

  private async commitInTransaction(
    tx: PrismaTx,
    proposal: unknown,
  ): Promise<CommitOwnedResultOutcome> {
    // ---- 1. Closed-schema, adapter-authority and plane checks (safe) ----
    const validated = validateOwnedResultMutationV0(proposal);
    if (validated instanceof Error) return validated;
    const mutation: OwnedResultMutationV0 = validated;

    // ---- 2. Card/projection/principal binding (safe) ----
    const binding = await tx.taskCommittedResultRef.findFirst({
      where: { taskId: mutation.taskId, cardId: mutation.cardId },
    });
    if (binding) {
      const bindingErr = this.checkBinding(binding, mutation);
      if (bindingErr !== null) return bindingErr;
    }

    // ---- 3. Mutation-scoped idempotent replay (safe) ----
    const existing = await tx.taskCommittedResultRef.findFirst({
      where: { taskId: mutation.taskId, mutationId: mutation.mutationId },
    });
    if (existing) {
      return this.replayCommittedResult(tx, existing);
    }

    // ---- 4. Aggregate and attempt ownership (safe) ----
    const stateRow = await tx.taskExecutionState.findUnique({
      where: { taskId: mutation.taskId },
    });
    if (!stateRow) {
      return new ResultBindingError(
        'taskId',
        'an existing execution aggregate',
        `no aggregate for task ${mutation.taskId}`,
      );
    }
    const currentAttemptId =
      stateRow.currentAttemptId ?? stateRow.current_attempt_id ?? null;
    if (currentAttemptId !== mutation.attemptId) {
      return new ResultBindingError(
        'attemptId',
        String(currentAttemptId),
        mutation.attemptId,
      );
    }

    const attemptRow = await tx.taskExecutionAttempt.findUnique({
      where: { attemptId: mutation.attemptId },
    });
    if (!attemptRow) {
      return new ResultBindingError(
        'attemptId',
        'an issued attempt',
        `no attempt ${mutation.attemptId}`,
      );
    }
    if ((attemptRow.taskId ?? attemptRow.task_id) !== mutation.taskId) {
      return new ResultBindingError(
        'attemptId',
        `an attempt owned by task ${mutation.taskId}`,
        `an attempt owned by task ${String(attemptRow.taskId ?? attemptRow.task_id)}`,
      );
    }
    if (!COMMITTABLE_ATTEMPT_STATUSES.has(String(attemptRow.status))) {
      return new ResultBindingError(
        'attempt.status',
        'running',
        String(attemptRow.status),
      );
    }

    // ---- 5. Expected node version (safe) ----
    const latestNode = await tx.taskResultNode.findFirst({
      where: { taskId: mutation.taskId, nodeId: mutation.nodeId },
      orderBy: { nodeVersion: 'desc' },
    });
    const currentNodeVersion = latestNode
      ? Number(latestNode.nodeVersion ?? latestNode.node_version)
      : 0;
    if (currentNodeVersion !== mutation.expectedNodeVersion) {
      return new ResultBindingError(
        'expectedNodeVersion',
        String(currentNodeVersion),
        String(mutation.expectedNodeVersion),
      );
    }
    const nodeVersion = currentNodeVersion + 1;

    // ---- 6. Server-authored identity (safe) ----
    const now = this.clock.now();
    const resultDigest = resultNodeDigest(mutation.resultNode);
    const resultNodeId = this.idSource.generate();
    const transitionId = this.idSource.generate();
    const aggregateVersion =
      Number(stateRow.aggregateVersion ?? stateRow.aggregate_version) + 1;

    const refWithoutId: Omit<CommittedResultRefV0, 'resultRefId'> = {
      schemaVersion: 'v0',
      kind: 'task-card-result',
      taskId: mutation.taskId,
      attemptId: mutation.attemptId,
      cardId: mutation.cardId,
      cardDigest: mutation.cardDigest,
      projectionId: mutation.projectionId,
      projectionDigest: mutation.projectionDigest,
      nodeId: mutation.nodeId,
      nodeVersion,
      resultDigest,
      mutationId: mutation.mutationId,
      principalId: mutation.principalId,
      transitionId,
      aggregateVersion,
    };
    const resultRef: CommittedResultRefV0 = {
      ...refWithoutId,
      resultRefId: computeResultRefId(refWithoutId),
    };

    const receiptWithoutId: Omit<CompletionReceiptV0, 'receiptId'> = {
      schemaVersion: 'v0',
      kind: 'completion-receipt',
      outcome: 'committed',
      resultRef,
      causationId: mutation.causationId,
      correlationId: mutation.correlationId,
    };
    const receipt: CompletionReceiptV0 = {
      ...receiptWithoutId,
      receiptId: computeReceiptId(receiptWithoutId),
    };

    // Self-check: what we are about to persist must satisfy the same closed
    // validators an external consumer applies. Fails closed, pre-mutation.
    const refCheck = validateCommittedResultRefV0(resultRef);
    if (refCheck instanceof Error) return refCheck;
    const receiptCheck = validateCompletionReceiptV0(receipt);
    if (receiptCheck instanceof Error) return receiptCheck;

    // ---- 7. Atomic write set (POST-MUTATION: throw to roll back) ----
    // The committed result travels as a closed pointer. The node body stays in
    // the result-node relation; the transition, outbox and receipt carry only
    // identity and digests.
    const envelope: CommittedResultEnvelopeV0 = {
      schema: 'muneral-committed-result-v0',
      resultRefId: resultRef.resultRefId,
      receiptId: receipt.receiptId,
      nodeId: resultRef.nodeId,
      nodeVersion: resultRef.nodeVersion,
      resultDigest: resultRef.resultDigest,
    };

    const command: TransitionAttemptCommand = {
      kind: 'transition_attempt',
      taskId: mutation.taskId,
      attemptId: mutation.attemptId,
      expectedVersion: aggregateVersion - 1,
      eventType: 'attempt:succeeded',
      idempotencyKey: mutation.idempotencyKey,
      causationId: mutation.causationId,
      correlationId: mutation.correlationId,
      evidenceRefs: [],
      payload: {
        schema: 'muneral-result-mutation-v0',
        mutationId: mutation.mutationId,
        cardId: mutation.cardId,
        projectionId: mutation.projectionId,
        nodeId: mutation.nodeId,
        principalId: mutation.principalId,
      },
      committedResult: envelope as unknown as Record<string, unknown>,
    };

    const authorityOutcome = await this.authority.executeWithinTransaction(
      tx,
      command,
      { transitionId },
    );
    if (authorityOutcome instanceof Error) return authorityOutcome;
    const committed = authorityOutcome as ExecutionResult;

    if (committed.state.aggregateVersion !== aggregateVersion) {
      // The reference binds to a specific aggregate version. If the seam
      // committed a different one, the identity we computed is wrong — roll
      // the whole set back rather than persist a reference that cannot be
      // regenerated from the journal.
      throw new Error(
        `Result authority invariant violation: predicted aggregate version ${aggregateVersion}, committed ${committed.state.aggregateVersion}`,
      );
    }

    await tx.taskResultNode.create({
      data: {
        id: resultNodeId,
        taskId: mutation.taskId,
        attemptId: mutation.attemptId,
        cardId: mutation.cardId,
        nodeId: mutation.nodeId,
        nodeVersion,
        mutationId: mutation.mutationId,
        principalId: mutation.principalId,
        nodePayload: mutation.resultNode,
        resultDigest,
        recordedAt: now,
      },
    });

    await tx.taskCommittedResultRef.create({
      data: {
        resultRefId: resultRef.resultRefId,
        taskId: resultRef.taskId,
        attemptId: resultRef.attemptId,
        cardId: resultRef.cardId,
        cardDigest: resultRef.cardDigest,
        projectionId: resultRef.projectionId,
        projectionDigest: resultRef.projectionDigest,
        nodeId: resultRef.nodeId,
        nodeVersion: resultRef.nodeVersion,
        resultDigest: resultRef.resultDigest,
        mutationId: resultRef.mutationId,
        principalId: resultRef.principalId,
        transitionId: resultRef.transitionId,
        aggregateVersion: BigInt(resultRef.aggregateVersion),
        resultNodeId,
        receiptId: receipt.receiptId,
        causationId: receipt.causationId,
        correlationId: receipt.correlationId,
        recordedAt: now,
      },
    });

    return {
      resultRef,
      receipt,
      resultNodeId,
      replayed: false,
      transition: committed.transition,
      state: committed.state,
      outboxEvent: committed.outboxEvent,
    };
  }

  // -------------------------------------------------------------------------

  /**
   * Compare a proposal against the binding established by the first accepted
   * mutation for this (task, card). The binding is immutable: a later proposal
   * with a different card digest, projection or principal is refused before
   * any write.
   */
  private checkBinding(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    binding: any,
    mutation: OwnedResultMutationV0,
  ): ResultBindingError | null {
    const pairs: Array<[string, unknown, string]> = [
      ['cardDigest', binding.cardDigest ?? binding.card_digest, mutation.cardDigest],
      ['projectionId', binding.projectionId ?? binding.projection_id, mutation.projectionId],
      [
        'projectionDigest',
        binding.projectionDigest ?? binding.projection_digest,
        mutation.projectionDigest,
      ],
      ['principalId', binding.principalId ?? binding.principal_id, mutation.principalId],
    ];
    for (const [field, expected, actual] of pairs) {
      if (expected !== undefined && expected !== actual) {
        return new ResultBindingError(field, String(expected), String(actual));
      }
    }
    return null;
  }

  /**
   * Return an already-committed reference and receipt byte-identically. No new
   * node, reference, receipt, transition or outbox row is created.
   */
  private async replayCommittedResult(
    tx: PrismaTx,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    row: any,
  ): Promise<CommittedResultOutcome | ResultContractError> {
    const ref = validateCommittedResultRefV0({
      schemaVersion: 'v0',
      kind: 'task-card-result',
      resultRefId: row.resultRefId ?? row.result_ref_id,
      taskId: row.taskId ?? row.task_id,
      attemptId: row.attemptId ?? row.attempt_id,
      cardId: row.cardId ?? row.card_id,
      cardDigest: row.cardDigest ?? row.card_digest,
      projectionId: row.projectionId ?? row.projection_id,
      projectionDigest: row.projectionDigest ?? row.projection_digest,
      nodeId: row.nodeId ?? row.node_id,
      nodeVersion: Number(row.nodeVersion ?? row.node_version),
      resultDigest: row.resultDigest ?? row.result_digest,
      mutationId: row.mutationId ?? row.mutation_id,
      principalId: row.principalId ?? row.principal_id,
      transitionId: row.transitionId ?? row.transition_id,
      aggregateVersion: Number(row.aggregateVersion ?? row.aggregate_version),
    });
    if (ref instanceof ResultContractError) return ref;

    const receipt = validateCompletionReceiptV0({
      schemaVersion: 'v0',
      kind: 'completion-receipt',
      receiptId: row.receiptId ?? row.receipt_id,
      outcome: 'committed',
      resultRef: ref,
      causationId: row.causationId ?? row.causation_id,
      correlationId: row.correlationId ?? row.correlation_id,
    });
    if (receipt instanceof ResultContractError) return receipt;

    // Best-effort: surface the already-committed outbox identity so a replay
    // caller sees the same delivery fact. Absence is not an error.
    let outboxEvent: OutboxEvent | undefined;
    const outboxRow = await tx.taskOutboxEvent.findUnique({
      where: { transitionId: ref.transitionId },
    });
    if (outboxRow) {
      outboxEvent = {
        id: outboxRow.id,
        taskId: outboxRow.taskId ?? outboxRow.task_id,
        aggregateVersion: Number(
          outboxRow.aggregateVersion ?? outboxRow.aggregate_version,
        ),
        attemptId: outboxRow.attemptId ?? outboxRow.attempt_id,
        transitionId: outboxRow.transitionId ?? outboxRow.transition_id,
        eventType: outboxRow.eventType ?? outboxRow.event_type,
        eventPayload: outboxRow.eventPayload ?? outboxRow.event_payload ?? {},
        recordedAt: new Date(outboxRow.recordedAt ?? outboxRow.recorded_at),
      };
    }

    return {
      resultRef: ref,
      receipt,
      resultNodeId: row.resultNodeId ?? row.result_node_id ?? undefined,
      replayed: true,
      outboxEvent,
    };
  }
}

function isPrismaUniqueViolation(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  if (typeof err !== 'object') return false;
  return (err as { code?: string }).code === 'P2002';
}
