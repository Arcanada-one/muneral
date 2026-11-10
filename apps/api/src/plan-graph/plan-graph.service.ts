// KCLIVE-10: owner-managed authoritative plan revision + CAS/lease binding.

import {
  ConflictException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { Actor } from '@muneral/types';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlanCycleError, PlanEdgeMappingError } from './plan-cycle.js';
import type { PlanEdgeV1, PlanNodeV1, PlanSnapshotV1 } from './plan-graph.types.js';
import {
  evaluatePlanReadiness,
  type PlanReadinessResult,
} from './plan-readiness.js';
import type { PlanNodeRuntimeState } from './plan-graph.types.js';
import { buildPlanSnapshot } from './plan-snapshot.js';

export interface PutPlanRevisionInput {
  rootTaskId: string;
  /** CAS: must equal current head revision, or 0 when no head exists yet. */
  expectedRevision: number;
  nodes: PlanNodeV1[];
  edges: PlanEdgeV1[];
  cursor?: string | null;
  sourceBindings?: Record<string, string>;
  leaseHolder?: string | null;
  leaseExpiresAt?: Date | null;
}

@Injectable()
export class PlanGraphService {
  constructor(private readonly prisma: PrismaService) {}

  async getAuthoritativeSnapshot(rootTaskId: string): Promise<{
    head: { revision: number; planDigest: string; leaseHolder: string | null };
    snapshot: PlanSnapshotV1;
  }> {
    const head = await this.prisma.taskPlanHead.findUnique({
      where: { rootTaskId },
    });
    if (!head) {
      throw new NotFoundException({
        code: 'PLAN_HEAD_NOT_FOUND',
        message: `No authoritative plan head for task ${rootTaskId}`,
        rootTaskId,
      });
    }
    const revision = await this.prisma.taskPlanRevision.findUnique({
      where: {
        rootTaskId_revision: {
          rootTaskId,
          revision: head.revision,
        },
      },
    });
    if (!revision) {
      throw new NotFoundException({
        code: 'PLAN_REVISION_MISSING',
        message: `Plan head revision ${head.revision} has no stored snapshot`,
        rootTaskId,
      });
    }
    return {
      head: {
        revision: Number(head.revision),
        planDigest: head.planDigest,
        leaseHolder: head.leaseHolder,
      },
      snapshot: revision.snapshot as unknown as PlanSnapshotV1,
    };
  }

  async putRevision(
    actor: Actor,
    input: PutPlanRevisionInput,
  ): Promise<{ snapshot: PlanSnapshotV1; replayed: false }> {
    const task = await this.prisma.task.findUnique({
      where: { id: input.rootTaskId },
      select: { id: true },
    });
    if (!task) throw new NotFoundException('Task not found');

    const nextRevision = input.expectedRevision + 1;
    let snapshot: PlanSnapshotV1;
    try {
      snapshot = buildPlanSnapshot({
        rootTaskId: input.rootTaskId,
        revision: nextRevision,
        cursor: input.cursor,
        sourceBindings: input.sourceBindings,
        nodes: input.nodes,
        edges: input.edges,
      });
    } catch (error) {
      if (error instanceof PlanCycleError || error instanceof PlanEdgeMappingError) {
        throw new ConflictException({
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const head = await tx.taskPlanHead.findUnique({
          where: { rootTaskId: input.rootTaskId },
        });
        const current = head ? Number(head.revision) : 0;
        if (current !== input.expectedRevision) {
          throw new ConflictException({
            code: 'PLAN_REVISION_CAS_CONFLICT',
            message:
              `expectedRevision=${input.expectedRevision} but authoritative ` +
              `head is ${current}`,
            expectedRevision: input.expectedRevision,
            currentRevision: current,
          });
        }

        await tx.taskPlanRevision.create({
          data: {
            id: randomUUID(),
            rootTaskId: input.rootTaskId,
            revision: BigInt(nextRevision),
            planDigest: snapshot.planDigest,
            snapshot: snapshot as unknown as Prisma.InputJsonValue,
            createdByType: actor.type,
            createdById: actor.id,
          },
        });

        if (head) {
          await tx.taskPlanHead.update({
            where: { rootTaskId: input.rootTaskId },
            data: {
              revision: BigInt(nextRevision),
              planDigest: snapshot.planDigest,
              leaseHolder: input.leaseHolder ?? head.leaseHolder,
              leaseExpiresAt: input.leaseExpiresAt ?? head.leaseExpiresAt,
            },
          });
        } else {
          await tx.taskPlanHead.create({
            data: {
              rootTaskId: input.rootTaskId,
              revision: BigInt(nextRevision),
              planDigest: snapshot.planDigest,
              leaseHolder: input.leaseHolder ?? null,
              leaseExpiresAt: input.leaseExpiresAt ?? null,
            },
          });
        }
      });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw error;
    }

    return { snapshot, replayed: false };
  }

  /**
   * Bind an execution lease to the authoritative plan revision (CAS).
   * Lease identity is the plan revision digest + holder, not Task.revision.
   */
  async bindLease(
    rootTaskId: string,
    input: {
      expectedRevision: number;
      expectedPlanDigest: string;
      leaseHolder: string;
      leaseExpiresAt: Date;
    },
  ): Promise<{ revision: number; planDigest: string; leaseHolder: string }> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const head = await tx.taskPlanHead.findUnique({
        where: { rootTaskId },
      });
      if (!head) {
        throw new NotFoundException({
          code: 'PLAN_HEAD_NOT_FOUND',
          message: `No authoritative plan head for task ${rootTaskId}`,
        });
      }
      if (
        Number(head.revision) !== input.expectedRevision ||
        head.planDigest !== input.expectedPlanDigest
      ) {
        throw new ConflictException({
          code: 'PLAN_LEASE_CAS_CONFLICT',
          message: 'lease bind requires exact authoritative revision+digest',
          expectedRevision: input.expectedRevision,
          currentRevision: Number(head.revision),
        });
      }
      return tx.taskPlanHead.update({
        where: { rootTaskId },
        data: {
          leaseHolder: input.leaseHolder,
          leaseExpiresAt: input.leaseExpiresAt,
        },
      });
    });

    return {
      revision: Number(updated.revision),
      planDigest: updated.planDigest,
      leaseHolder: updated.leaseHolder!,
    };
  }

  async planReadiness(
    rootTaskId: string,
    nodeId: string,
    states: PlanNodeRuntimeState[],
  ): Promise<PlanReadinessResult> {
    const { snapshot } = await this.getAuthoritativeSnapshot(rootTaskId);
    if (!snapshot.nodes.some((n) => n.nodeId === nodeId)) {
      throw new BadRequestException({
        code: 'PLAN_NODE_UNKNOWN',
        message: `nodeId ${nodeId} is not in authoritative plan revision ${snapshot.revision}`,
      });
    }
    const map = new Map(states.map((s) => [s.nodeId, s]));
    return evaluatePlanReadiness(snapshot, map, nodeId);
  }
}
