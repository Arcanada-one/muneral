import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import type { TaskStatus } from '@muneral/types';
import { PrismaService } from '../prisma/prisma.service.js';
import { agentStatusAuthorityWhere } from '../auth/agent-task-visibility.js';
import { canonicalJson, CanonicalJsonError } from '../execution-authority/canonical-json.js';
import type { JsonValue } from '../execution-authority/canonical-json.js';
import type {
  DispatchIdentitySource,
  DispatchPrincipal,
  DispatchState,
  IssueDispatchRequest,
  PublicDispatchReservation,
  TerminalBindingRequest,
  TerminalDeclarationAuthority,
  VerifiedTerminalDeclaration,
} from './dispatch-authority.types.js';

export const DISPATCH_ID_SOURCE = Symbol('DISPATCH_ID_SOURCE');
export const TERMINAL_DECLARATION_AUTHORITY = Symbol('TERMINAL_DECLARATION_AUTHORITY');
export const MAX_DISPATCH_DOCUMENT_BYTES = 64 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const HUMAN_DISPATCH_ROLES = ['owner', 'manager', 'developer'] as const;
const TRANSACTION_OPTIONS = { timeout: 10_000, isolationLevel: 'Serializable' };

interface TaskSnapshot {
  id: string;
  projectId: string;
  workspaceId: string;
  revision: number;
  status: string;
  updatedAt: Date | string;
}

interface ReservationRow {
  dispatchId: string;
  launchAttemptId: string;
  taskId: string;
  projectId: string;
  actorType: string;
  actorId: string;
  idempotencyKey: string;
  expectedTaskRevision: number;
  expectedTaskStatus: string;
  expectedTaskUpdatedAt: Date | string;
  requestBytes: Uint8Array;
  requestSha256: string;
  executionContextBytes: Uint8Array;
  executionContextSha256: string;
  state: string;
  terminalDeclarationId: string | null;
  terminalDeclarationSha256: string | null;
  terminalContextSha256: string | null;
  terminalAuthorityRef: string | null;
  createdAt: Date | string;
  boundAt: Date | string | null;
  consumedAt: Date | string | null;
  revokedAt: Date | string | null;
}

interface Delegate {
  findUnique(args: unknown): Promise<unknown>;
  create(args: unknown): Promise<unknown>;
  updateMany(args: unknown): Promise<{ count: number }>;
}

interface DispatchTransaction {
  taskDispatchReservation: Delegate;
  task: { findFirst(args: unknown): Promise<unknown> };
  workspaceMember: { findUnique(args: unknown): Promise<unknown> };
  $queryRaw<T = unknown>(query: unknown): Promise<T>;
}

interface DispatchDatabase extends DispatchTransaction {
  $transaction<T>(
    callback: (tx: DispatchTransaction) => Promise<T>,
    options: typeof TRANSACTION_OPTIONS,
  ): Promise<T>;
}

interface SerializedDocument {
  bytes: Buffer;
  sha256: string;
}

@Injectable()
export class DispatchAuthorityService {
  private readonly db: DispatchDatabase;

  constructor(
    prisma: PrismaService,
    @Inject(DISPATCH_ID_SOURCE)
    private readonly idSource: DispatchIdentitySource,
    @Inject(TERMINAL_DECLARATION_AUTHORITY)
    private readonly terminalAuthority: TerminalDeclarationAuthority,
  ) {
    // Kept behind the narrow transaction interface because the Prisma client
    // model is declared in schema.prisma but client generation is an external
    // build step. This source change does not generate or deploy that client.
    this.db = prisma as unknown as DispatchDatabase;
  }

  async issue(
    taskId: string,
    actor: DispatchPrincipal,
    input: IssueDispatchRequest,
  ): Promise<PublicDispatchReservation> {
    assertUuid(taskId, 'task id');
    const request = serializeDocument(input.request, 'request');
    const executionContext = serializeDocument(input.executionContext, 'execution context');
    const expectedUpdatedAt = parseDate(input.expectedTaskUpdatedAt);
    if (!Number.isInteger(input.expectedTaskRevision) || input.expectedTaskRevision < 0) {
      throw new BadRequestException('expectedTaskRevision must be a non-negative integer.');
    }
    if (!input.idempotencyKey || input.idempotencyKey.length > 128) {
      throw new BadRequestException('idempotencyKey is invalid.');
    }

    try {
      const result = await this.db.$transaction(async (tx) => {
        const task = await this.lockTask(tx, taskId);
        await this.assertActorCanDispatch(tx, task, actor);

        const existing = await this.findIdempotent(tx, taskId, actor, input.idempotencyKey);
        if (existing) {
          assertStoredIntegrity(existing);
          if (!sameIssue(existing, input, request.sha256, executionContext.sha256, expectedUpdatedAt)) {
            throw new ConflictException('Idempotency key was already used for different dispatch input.');
          }
          return { row: existing, idempotent: true };
        }

        assertCurrentTask(task, input.expectedTaskRevision, input.expectedTaskStatus, expectedUpdatedAt);
        const [launchAttemptId, dispatchId] = this.issueDistinctIdentities();
        const created = await tx.taskDispatchReservation.create({
          data: {
            dispatchId,
            launchAttemptId,
            taskId: task.id,
            projectId: task.projectId,
            actorType: actor.type,
            actorId: actor.id,
            idempotencyKey: input.idempotencyKey,
            expectedTaskRevision: input.expectedTaskRevision,
            expectedTaskStatus: input.expectedTaskStatus,
            expectedTaskUpdatedAt: expectedUpdatedAt,
            requestBytes: request.bytes,
            requestSha256: request.sha256,
            executionContextBytes: executionContext.bytes,
            executionContextSha256: executionContext.sha256,
            state: 'reserved',
          },
        }) as ReservationRow;
        assertStoredIntegrity(created);
        return { row: created, idempotent: false };
      }, TRANSACTION_OPTIONS);
      return present(result.row, result.idempotent);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findIdempotent(this.db, taskId, actor, input.idempotencyKey);
      if (existing) {
        assertStoredIntegrity(existing);
        if (sameIssue(existing, input, request.sha256, executionContext.sha256, expectedUpdatedAt)) {
          return present(existing, true);
        }
      }
      throw new ConflictException('Dispatch identity or idempotency key collided; no reservation was issued.');
    }
  }

  async bindTerminal(
    taskId: string,
    launchAttemptId: string,
    dispatchId: string,
    actor: DispatchPrincipal,
    terminalDeclarationId: string,
  ): Promise<PublicDispatchReservation> {
    assertPathIds(taskId, launchAttemptId, dispatchId);
    if (!terminalDeclarationId || terminalDeclarationId.length > 256) {
      throw new BadRequestException('terminalDeclarationId is invalid.');
    }

    const current = await this.loadOwned(this.db, taskId, launchAttemptId, dispatchId, actor);
    assertStoredIntegrity(current);
    if (current.state === 'bound' && current.terminalDeclarationId === terminalDeclarationId &&
        current.terminalContextSha256 === current.executionContextSha256 &&
        SHA256.test(current.terminalDeclarationSha256 ?? '') && current.terminalAuthorityRef) {
      return present(current, true);
    }
    if (current.state !== 'reserved') {
      throw new ConflictException('Only an unbound reservation can bind a terminal declaration.');
    }

    // The submitted id is only a selector. No request string is accepted as
    // proof; a configured server-side authority must resolve and bind it.
    const verified = await this.terminalAuthority.verifyBinding({
      taskId,
      launchAttemptId,
      dispatchId,
      actor,
      terminalDeclarationId,
      executionContextBytes: current.executionContextBytes,
      executionContextSha256: current.executionContextSha256,
    });
    validateTerminalBinding(verified, terminalDeclarationId, current.executionContextSha256);

    const row = await this.db.$transaction(async (tx) => {
      const task = await this.lockTask(tx, taskId);
      await this.assertActorCanDispatch(tx, task, actor);
      assertCurrentTask(
        task,
        current.expectedTaskRevision,
        current.expectedTaskStatus as TaskStatus,
        asDate(current.expectedTaskUpdatedAt),
      );
      const result = await tx.taskDispatchReservation.updateMany({
        where: {
          taskId,
          launchAttemptId,
          dispatchId,
          actorType: actor.type,
          actorId: actor.id,
          state: 'reserved',
          requestSha256: current.requestSha256,
          executionContextSha256: current.executionContextSha256,
        },
        data: {
          state: 'bound',
          terminalDeclarationId: verified.terminalDeclarationId,
          terminalDeclarationSha256: verified.terminalDeclarationSha256,
          terminalContextSha256: verified.executionContextSha256,
          terminalAuthorityRef: verified.authorityRef,
          boundAt: new Date(),
        },
      });
      if (result.count !== 1) throw new ConflictException('Reservation changed before terminal binding committed.');
      return this.findByDispatch(tx, taskId, launchAttemptId, dispatchId);
    }, TRANSACTION_OPTIONS);
    return present(row, false);
  }

  async consumeForStart(
    taskId: string,
    launchAttemptId: string,
    dispatchId: string,
    actor: DispatchPrincipal,
  ): Promise<PublicDispatchReservation> {
    assertPathIds(taskId, launchAttemptId, dispatchId);
    const row = await this.db.$transaction(async (tx) => {
      const task = await this.lockTask(tx, taskId);
      await this.assertActorCanDispatch(tx, task, actor);
      const current = await this.findByDispatch(tx, taskId, launchAttemptId, dispatchId);
      assertOwned(current, actor);
      assertStoredIntegrity(current);
      if (current.state !== 'bound') {
        throw new ConflictException('A dispatch must be validly terminal-bound before its single-use start consumption.');
      }
      if (!current.terminalDeclarationId || !current.terminalDeclarationSha256 ||
          !current.terminalAuthorityRef || current.terminalContextSha256 !== current.executionContextSha256) {
        throw new ConflictException('Terminal binding is incomplete or does not match the immutable context.');
      }
      assertCurrentTask(
        task,
        current.expectedTaskRevision,
        current.expectedTaskStatus as TaskStatus,
        asDate(current.expectedTaskUpdatedAt),
      );
      const result = await tx.taskDispatchReservation.updateMany({
        where: {
          taskId,
          launchAttemptId,
          dispatchId,
          actorType: actor.type,
          actorId: actor.id,
          state: 'bound',
          expectedTaskRevision: current.expectedTaskRevision,
          expectedTaskStatus: current.expectedTaskStatus,
          expectedTaskUpdatedAt: asDate(current.expectedTaskUpdatedAt),
          executionContextSha256: current.executionContextSha256,
          terminalContextSha256: current.executionContextSha256,
        },
        data: { state: 'consumed', consumedAt: new Date() },
      });
      if (result.count !== 1) throw new ConflictException('Dispatch start authority was already consumed or changed.');
      return this.findByDispatch(tx, taskId, launchAttemptId, dispatchId);
    }, TRANSACTION_OPTIONS);
    return present(row, false);
  }

  async revoke(
    taskId: string,
    launchAttemptId: string,
    dispatchId: string,
    actor: DispatchPrincipal,
  ): Promise<PublicDispatchReservation> {
    assertPathIds(taskId, launchAttemptId, dispatchId);
    const result = await this.db.$transaction(async (tx) => {
      const task = await this.lockTask(tx, taskId);
      await this.assertActorCanDispatch(tx, task, actor);
      const current = await this.findByDispatch(tx, taskId, launchAttemptId, dispatchId);
      assertOwned(current, actor);
      assertStoredIntegrity(current);
      if (current.state === 'revoked') return { row: current, idempotent: true };
      if (current.state === 'consumed') {
        throw new ConflictException('Consumed dispatch authority cannot be revoked retroactively.');
      }
      const changed = await tx.taskDispatchReservation.updateMany({
        where: {
          taskId,
          launchAttemptId,
          dispatchId,
          actorType: actor.type,
          actorId: actor.id,
          state: { in: ['reserved', 'bound'] },
        },
        data: { state: 'revoked', revokedAt: new Date() },
      });
      if (changed.count !== 1) throw new ConflictException('Dispatch state changed before revocation committed.');
      return { row: await this.findByDispatch(tx, taskId, launchAttemptId, dispatchId), idempotent: false };
    }, TRANSACTION_OPTIONS);
    return present(result.row, result.idempotent);
  }

  private issueDistinctIdentities(): [string, string] {
    const launchAttemptId = this.idSource.generate();
    const dispatchId = this.idSource.generate();
    if (!UUID.test(launchAttemptId) || !UUID.test(dispatchId) || launchAttemptId === dispatchId) {
      throw new ServiceUnavailableException('Server could not issue distinct dispatch identities.');
    }
    return [launchAttemptId, dispatchId];
  }

  private async lockTask(tx: DispatchTransaction, taskId: string): Promise<TaskSnapshot> {
    const rows = await tx.$queryRaw<TaskSnapshot[]>(Prisma.sql`
      SELECT t.id, t.project_id AS "projectId", p.workspace_id AS "workspaceId",
             t.revision, t.status, t.updated_at AS "updatedAt"
      FROM tasks AS t
      INNER JOIN projects AS p ON p.id = t.project_id
      WHERE t.id = ${taskId}::uuid
      FOR UPDATE OF t
    `);
    const task = rows[0];
    if (!task) throw new NotFoundException('Task not found.');
    return task;
  }

  private async assertActorCanDispatch(
    tx: DispatchTransaction,
    task: TaskSnapshot,
    actor: DispatchPrincipal,
  ): Promise<void> {
    if (!actor.id || (actor.type !== 'human' && actor.type !== 'agent')) {
      throw new ForbiddenException('Task dispatch is not authorized.');
    }
    if (actor.type === 'human') {
      const member = await tx.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: task.workspaceId, userId: actor.id } },
        select: { role: true },
      }) as { role?: string } | null;
      if (!member || !HUMAN_DISPATCH_ROLES.includes(member.role as typeof HUMAN_DISPATCH_ROLES[number])) {
        throw new ForbiddenException('Task dispatch is not authorized.');
      }
      return;
    }

    if (actor.workspaceId !== task.workspaceId) {
      throw new ForbiddenException('Task dispatch is not authorized.');
    }
    const entitled = await tx.task.findFirst({
      where: {
        id: task.id,
        project: { workspaceId: task.workspaceId },
        ...agentStatusAuthorityWhere(actor.id),
      },
      select: { id: true },
    });
    if (!entitled) throw new ForbiddenException('Task dispatch is not authorized.');
  }

  private async findIdempotent(
    client: DispatchTransaction,
    taskId: string,
    actor: DispatchPrincipal,
    idempotencyKey: string,
  ): Promise<ReservationRow | null> {
    return await client.taskDispatchReservation.findUnique({
      where: {
        taskDispatchIdempotency: {
          taskId,
          actorType: actor.type,
          actorId: actor.id,
          idempotencyKey,
        },
      },
    }) as ReservationRow | null;
  }

  private async findByDispatch(
    client: DispatchTransaction,
    taskId: string,
    launchAttemptId: string,
    dispatchId: string,
  ): Promise<ReservationRow> {
    const row = await client.taskDispatchReservation.findUnique({
      where: { dispatchId },
    }) as ReservationRow | null;
    if (!row || row.taskId !== taskId || row.launchAttemptId !== launchAttemptId) {
      throw new NotFoundException('Dispatch reservation not found.');
    }
    return row;
  }

  private async loadOwned(
    client: DispatchTransaction,
    taskId: string,
    launchAttemptId: string,
    dispatchId: string,
    actor: DispatchPrincipal,
  ): Promise<ReservationRow> {
    const row = await this.findByDispatch(client, taskId, launchAttemptId, dispatchId);
    assertOwned(row, actor);
    return row;
  }
}

export class TerminalAuthorityUnavailableException extends ServiceUnavailableException {
  constructor() {
    super('No authenticated terminal declaration authority is configured.');
  }
}

/** Production default: issuing/revoking Muneral reservations remains available,
 * while binding/start consumption refuses until a real authenticated adapter is
 * implemented and configured. No terminal identifier supplied by a caller is
 * promoted to authority.
 */
export class UnavailableTerminalDeclarationAuthority implements TerminalDeclarationAuthority {
  async verifyBinding(_request: TerminalBindingRequest): Promise<VerifiedTerminalDeclaration> {
    throw new TerminalAuthorityUnavailableException();
  }
}

function serializeDocument(value: unknown, label: string): SerializedDocument {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException(`${label} must be a JSON object.`);
  }
  let text: string;
  try {
    text = canonicalJson(value as JsonValue);
  } catch (error) {
    if (error instanceof CanonicalJsonError) throw new BadRequestException(`${label} is not canonical JSON.`);
    throw error;
  }
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength > MAX_DISPATCH_DOCUMENT_BYTES) {
    throw new BadRequestException(`${label} exceeds ${MAX_DISPATCH_DOCUMENT_BYTES} bytes.`);
  }
  return { bytes, sha256: sha256(bytes) };
}

function assertStoredIntegrity(row: ReservationRow): void {
  const requestBytes = Buffer.from(row.requestBytes);
  const contextBytes = Buffer.from(row.executionContextBytes);
  if (sha256(requestBytes) !== row.requestSha256 || sha256(contextBytes) !== row.executionContextSha256) {
    throw new ConflictException('Persisted dispatch input integrity check failed.');
  }
}

function sameIssue(
  row: ReservationRow,
  input: IssueDispatchRequest,
  requestSha256: string,
  contextSha256: string,
  expectedUpdatedAt: Date,
): boolean {
  return row.expectedTaskRevision === input.expectedTaskRevision &&
    row.expectedTaskStatus === input.expectedTaskStatus &&
    asDate(row.expectedTaskUpdatedAt).getTime() === expectedUpdatedAt.getTime() &&
    row.requestSha256 === requestSha256 &&
    row.executionContextSha256 === contextSha256;
}

function assertCurrentTask(
  task: TaskSnapshot,
  expectedRevision: number | undefined,
  expectedStatus: string | undefined,
  expectedUpdatedAt: Date | undefined,
): void {
  if ((expectedRevision !== undefined && task.revision !== expectedRevision) ||
      (expectedStatus !== undefined && task.status !== expectedStatus) ||
      (expectedUpdatedAt !== undefined && asDate(task.updatedAt).getTime() !== expectedUpdatedAt.getTime())) {
    throw new ConflictException('Task state/version changed; issue a new dispatch request against the current task.');
  }
  if (task.status === 'done' || task.status === 'cancelled' || task.status === 'archived') {
    throw new ConflictException('A completed, cancelled, or archived task cannot authorize a dispatch.');
  }
}

function validateTerminalBinding(
  binding: VerifiedTerminalDeclaration,
  requestedDeclarationId: string,
  expectedContextSha256: string,
): void {
  if (!binding || binding.terminalDeclarationId !== requestedDeclarationId ||
      binding.executionContextSha256 !== expectedContextSha256 ||
      !SHA256.test(binding.terminalDeclarationSha256 ?? '') ||
      typeof binding.authorityRef !== 'string' || binding.authorityRef.length === 0 || binding.authorityRef.length > 256) {
    throw new ServiceUnavailableException('Terminal authority returned an invalid or mismatched binding.');
  }
}

function assertOwned(row: ReservationRow, actor: DispatchPrincipal): void {
  if (row.actorType !== actor.type || row.actorId !== actor.id) {
    throw new ForbiddenException('Dispatch reservation is not owned by this authenticated caller.');
  }
}

function present(row: ReservationRow, idempotent: boolean): PublicDispatchReservation {
  return {
    taskId: row.taskId,
    projectId: row.projectId,
    launchAttemptId: row.launchAttemptId,
    dispatchId: row.dispatchId,
    actorType: row.actorType as 'human' | 'agent',
    actorId: row.actorId,
    expectedTaskRevision: row.expectedTaskRevision,
    expectedTaskStatus: row.expectedTaskStatus,
    expectedTaskUpdatedAt: asDate(row.expectedTaskUpdatedAt).toISOString(),
    requestSha256: row.requestSha256,
    executionContextSha256: row.executionContextSha256,
    state: row.state as DispatchState,
    terminalDeclarationId: row.terminalDeclarationId,
    terminalDeclarationSha256: row.terminalDeclarationSha256,
    terminalContextSha256: row.terminalContextSha256,
    createdAt: asDate(row.createdAt).toISOString(),
    boundAt: row.boundAt ? asDate(row.boundAt).toISOString() : null,
    consumedAt: row.consumedAt ? asDate(row.consumedAt).toISOString() : null,
    revokedAt: row.revokedAt ? asDate(row.revokedAt).toISOString() : null,
    idempotent,
  };
}

function parseDate(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new BadRequestException('expectedTaskUpdatedAt is invalid.');
  return date;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) throw new BadRequestException(`${label} must be a UUID.`);
}

function assertPathIds(taskId: string, launchAttemptId: string, dispatchId: string): void {
  assertUuid(taskId, 'task id');
  assertUuid(launchAttemptId, 'launch attempt id');
  assertUuid(dispatchId, 'dispatch id');
  if (launchAttemptId === dispatchId) throw new BadRequestException('Launch attempt and dispatch ids must be distinct.');
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: unknown }).code === 'P2002';
}
