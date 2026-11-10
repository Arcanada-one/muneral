// KCLIVE-10: durable idempotent command→root/run association.
// Rematches migration claim-first + execution-authority digest conflict semantics.

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { Actor } from '@muneral/types';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  digestCreateCommand,
  normalizeCreateCommand,
} from './command-digest.js';
import type {
  CommandOperation,
  NormalizedCreateCommand,
} from './plan-graph.types.js';

export interface AssociateCommandInput {
  operation: CommandOperation;
  projectId: string;
  idempotencyKey: string;
  command: Omit<NormalizedCreateCommand, 'operation' | 'projectId'> & {
    title: string;
  };
  /** When replaying after create, bind the committed root/run. */
  rootTaskId?: string | null;
  runId?: string | null;
  response?: Record<string, unknown>;
}

export interface AssociateCommandResult {
  replayed: boolean;
  commandDigest: string;
  rootTaskId: string | null;
  runId: string | null;
  response: Record<string, unknown>;
}

@Injectable()
export class CommandAssociationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Claim-or-replay. Same key+digest returns the stored association; same key
   * with a different digest conflicts. Caller performs the business write only
   * when replayed=false and then calls `completeAssociation`.
   */
  async claim(
    actor: Actor,
    input: AssociateCommandInput,
  ): Promise<AssociateCommandResult> {
    const project = await this.prisma.project.findUnique({
      where: { id: input.projectId },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('Project not found');

    const normalized = normalizeCreateCommand({
      operation: input.operation,
      projectId: input.projectId,
      ...input.command,
    });
    const commandDigest = digestCreateCommand(normalized);

    return this.prisma.$transaction(async (tx) => {
      const inserted = await tx.$executeRaw`
        INSERT INTO public.task_command_associations
          (id, actor_type, actor_id, project_id, operation, idempotency_key,
           command_digest, root_task_id, run_id, response)
        VALUES (
          ${randomUUID()}::uuid,
          ${actor.type},
          ${actor.id}::uuid,
          ${input.projectId}::uuid,
          ${input.operation},
          ${input.idempotencyKey},
          ${commandDigest},
          ${input.rootTaskId ?? null}::uuid,
          ${input.runId ?? null}::uuid,
          ${JSON.stringify(input.response ?? {})}::jsonb
        )
        ON CONFLICT (actor_type, actor_id, project_id, operation, idempotency_key)
        DO NOTHING
      `;

      if (inserted === 1) {
        return {
          replayed: false,
          commandDigest,
          rootTaskId: input.rootTaskId ?? null,
          runId: input.runId ?? null,
          response: input.response ?? {},
        };
      }

      const existing = await tx.taskCommandAssociation.findFirstOrThrow({
        where: {
          actorType: actor.type,
          actorId: actor.id,
          projectId: input.projectId,
          operation: input.operation,
          idempotencyKey: input.idempotencyKey,
        },
      });

      if (existing.commandDigest !== commandDigest) {
        throw new ConflictException({
          code: 'COMMAND_IDEMPOTENCY_CONFLICT',
          message:
            `Idempotency key "${input.idempotencyKey}" was already used ` +
            `for operation "${input.operation}" with a different command digest.`,
          operation: input.operation,
          idempotencyKey: input.idempotencyKey,
        });
      }

      return {
        replayed: true,
        commandDigest: existing.commandDigest,
        rootTaskId: existing.rootTaskId,
        runId: existing.runId,
        response: existing.response as Record<string, unknown>,
      };
    });
  }

  /** Fill root/run/response after the business write commits under a claimed key. */
  async complete(
    actor: Actor,
    input: {
      operation: CommandOperation;
      projectId: string;
      idempotencyKey: string;
      rootTaskId: string;
      runId?: string | null;
      response: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.prisma.taskCommandAssociation.updateMany({
      where: {
        actorType: actor.type,
        actorId: actor.id,
        projectId: input.projectId,
        operation: input.operation,
        idempotencyKey: input.idempotencyKey,
      },
      data: {
        rootTaskId: input.rootTaskId,
        runId: input.runId ?? null,
        response: input.response as Prisma.InputJsonValue,
      },
    });
  }
}
