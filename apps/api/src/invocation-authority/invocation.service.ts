import { compileAssembly } from '../assembly/assembly.compiler';
import type { TransactionalClient } from '../execution-authority/execution-authority.service';
import type { Clock } from '../execution-authority/execution-authority.types';
import { cardDigest, projectionDigest } from '../result-authority/result-authority.canonical';
import { createTaskCardInvocation } from './invocation.canonical';
import {
  InvocationAuthorityError,
  type IssueTaskInvocationRequestV0,
  type IssuedTaskInvocationV0,
  type IssuedTaskRouteAuthorityV0,
  NATIVE_FIXTURE_OPERATION,
} from './invocation.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PrismaTx = any;

export interface IssuedTaskInvocationOutcome {
  readonly invocation: IssuedTaskInvocationV0;
  readonly replayed: boolean;
}

export class InvocationAuthorityService {
  constructor(private readonly clock: Clock) {}

  async issue(
    prisma: TransactionalClient,
    request: IssueTaskInvocationRequestV0,
  ): Promise<IssuedTaskInvocationOutcome | InvocationAuthorityError | Error> {
    if (request.schemaVersion !== 'v0') {
      return new InvocationAuthorityError('schemaVersion', 'v0', String(request.schemaVersion));
    }
    if (request.operation !== NATIVE_FIXTURE_OPERATION) {
      return new InvocationAuthorityError(
        'operation',
        NATIVE_FIXTURE_OPERATION,
        String(request.operation),
      );
    }
    if (request.assemblyRequest.taskId !== request.taskId) {
      return new InvocationAuthorityError(
        'assemblyRequest.taskId',
        request.taskId,
        request.assemblyRequest.taskId,
      );
    }
    const compiled = compileAssembly(request.assemblyRequest);
    if (!compiled.ok) return new Error(`${compiled.error.errorCode}: ${compiled.error.message}`);
    const invocation = createTaskCardInvocation({
      taskId: request.taskId,
      attemptId: request.attemptId,
      nodeId: request.nodeId,
      tenantId: request.tenantId,
      principalId: request.principalId,
      assemblyArtifact: compiled.artifact,
    });

    return prisma.$transaction(async (tx: PrismaTx) => {
      const state = await tx.taskExecutionState.findUnique({
        where: { taskId: request.taskId },
      });
      const currentAttemptId = state?.currentAttemptId ?? state?.current_attempt_id ?? null;
      if (currentAttemptId !== request.attemptId) {
        return new InvocationAuthorityError(
          'attemptId',
          String(currentAttemptId),
          request.attemptId,
        );
      }
      const attempt = await tx.taskExecutionAttempt.findUnique({
        where: { attemptId: request.attemptId },
      });
      if (!attempt || (attempt.taskId ?? attempt.task_id) !== request.taskId) {
        return new InvocationAuthorityError(
          'attemptId',
          `an issued attempt owned by task ${request.taskId}`,
          request.attemptId,
        );
      }

      const existing = await tx.taskResultBinding.findUnique({
        where: { invocationId: invocation.taskCard.invocationId },
      });
      if (existing) {
        const fields: Array<[string, unknown, string]> = [
          ['taskId', existing.taskId ?? existing.task_id, request.taskId],
          ['attemptId', existing.attemptId ?? existing.attempt_id, request.attemptId],
          ['cardId', existing.cardId ?? existing.card_id, invocation.taskCard.cardId],
          ['cardDigest', existing.cardDigest ?? existing.card_digest, invocation.taskCardDigest],
          ['projectionId', existing.projectionId ?? existing.projection_id, invocation.taskCard.invocationId],
          ['projectionDigest', existing.projectionDigest ?? existing.projection_digest, invocation.projectionDigest],
          ['nodeId', existing.nodeId ?? existing.node_id, request.nodeId],
          ['tenantId', existing.tenantId ?? existing.tenant_id, request.tenantId],
          ['principalId', existing.principalId ?? existing.principal_id, request.principalId],
        ];
        for (const [field, expected, actual] of fields) {
          if (expected !== actual) {
            return new InvocationAuthorityError(field, String(expected), actual);
          }
        }
        return { invocation, replayed: true };
      }

      await tx.taskResultBinding.create({
        data: {
          taskId: request.taskId,
          attemptId: request.attemptId,
          cardId: invocation.taskCard.cardId,
          cardDigest: invocation.taskCardDigest,
          projectionId: invocation.taskCard.invocationId,
          projectionDigest: invocation.projectionDigest,
          invocationId: invocation.taskCard.invocationId,
          nodeId: request.nodeId,
          tenantId: request.tenantId,
          principalId: request.principalId,
          operation: invocation.taskCard.operation,
          cardCanonicalBytes: invocation.taskCardCanonicalBytes,
          projectionCanonicalBytes: invocation.projectionCanonicalBytes,
          recordedAt: this.clock.now(),
        },
      });
      return { invocation, replayed: false };
    });
  }

  async readRouteAuthority(
    prisma: TransactionalClient,
    invocationId: string,
  ): Promise<IssuedTaskRouteAuthorityV0 | InvocationAuthorityError> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const binding: any = await (prisma as any).taskResultBinding.findUnique({
      where: { invocationId },
    });
    if (!binding) {
      return new InvocationAuthorityError(
        'invocationId',
        'an issued Muneral invocation',
        invocationId,
      );
    }
    const cardBytes = String(
      binding.cardCanonicalBytes ?? binding.card_canonical_bytes ?? '',
    );
    const projectionBytes = String(
      binding.projectionCanonicalBytes ?? binding.projection_canonical_bytes ?? '',
    );
    let card: unknown;
    let projection: unknown;
    try {
      card = JSON.parse(cardBytes);
      projection = JSON.parse(projectionBytes);
    } catch {
      return new InvocationAuthorityError(
        'canonicalBytes',
        'valid canonical Task Card and projection JSON',
        'malformed stored JSON',
      );
    }
    const storedCardDigest = String(binding.cardDigest ?? binding.card_digest);
    const storedProjectionDigest = String(
      binding.projectionDigest ?? binding.projection_digest,
    );
    if (cardDigest(card) !== storedCardDigest) {
      return new InvocationAuthorityError(
        'cardDigest',
        storedCardDigest,
        cardDigest(card),
      );
    }
    if (projectionDigest(projection) !== storedProjectionDigest) {
      return new InvocationAuthorityError(
        'projectionDigest',
        storedProjectionDigest,
        projectionDigest(projection),
      );
    }
    const taskId = String(binding.taskId ?? binding.task_id);
    const attemptId = String(binding.attemptId ?? binding.attempt_id);
    const cardId = String(binding.cardId ?? binding.card_id);
    const nodeId = String(binding.nodeId ?? binding.node_id);
    const tenantId = String(binding.tenantId ?? binding.tenant_id);
    const principalId = String(binding.principalId ?? binding.principal_id);
    const projectionId = String(binding.projectionId ?? binding.projection_id);
    const cardRecord = card as Record<string, unknown>;
    const projectionRecord = projection as Record<string, unknown>;
    const identityPairs: Array<[string, unknown, string]> = [
      ['taskCard.taskId', cardRecord.taskId, taskId],
      ['taskCard.attemptId', cardRecord.attemptId, attemptId],
      ['taskCard.cardId', cardRecord.cardId, cardId],
      ['taskCard.invocationId', cardRecord.invocationId, invocationId],
      ['taskCard.nodeId', cardRecord.nodeId, nodeId],
      ['taskCard.tenantId', cardRecord.tenantId, tenantId],
      ['taskCard.principalId', cardRecord.principalId, principalId],
      ['projection.taskId', projectionRecord.taskId, taskId],
      ['projection.attemptId', projectionRecord.attemptId, attemptId],
      ['projection.cardId', projectionRecord.cardId, cardId],
      ['projection.invocationId', projectionRecord.invocationId, invocationId],
      ['projection.nodeId', projectionRecord.nodeId, nodeId],
      ['projection.tenantId', projectionRecord.tenantId, tenantId],
      ['projection.principalId', projectionRecord.principalId, principalId],
    ];
    for (const [field, actual, expected] of identityPairs) {
      if (actual !== expected) {
        return new InvocationAuthorityError(field, expected, String(actual));
      }
    }
    return {
      schemaVersion: 'v0',
      kind: 'issued-task-route-authority-v0',
      tenantId,
      principalId,
      taskId,
      attemptId,
      invocationId,
      taskCardDigest: storedCardDigest,
      nodeId,
      projectionId,
      projectionCapabilityDigest: storedProjectionDigest,
      projectionCanonicalBytes: projectionBytes,
    };
  }
}
