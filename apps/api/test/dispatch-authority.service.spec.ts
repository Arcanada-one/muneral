import { ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { jest as _jestRuntime } from '@jest/globals';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import {
  DispatchAuthorityService,
  TerminalAuthorityUnavailableException,
  UnavailableTerminalDeclarationAuthority,
} from '../src/dispatch-authority/dispatch-authority.service.js';
import { DispatchPrincipalGuard } from '../src/dispatch-authority/dispatch-principal.guard.js';
import type {
  DispatchPrincipal,
  IssueDispatchRequest,
  TerminalBindingRequest,
  TerminalDeclarationAuthority,
  VerifiedTerminalDeclaration,
} from '../src/dispatch-authority/dispatch-authority.types.js';

const jest = _jestRuntime as unknown as typeof globalThis.jest;
const TASK_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_TASK_ID = '10000000-0000-4000-8000-000000000002';
const ACTOR_ID = '20000000-0000-4000-8000-000000000001';
const OTHER_ACTOR_ID = '20000000-0000-4000-8000-000000000002';
const WORKSPACE_ID = '30000000-0000-4000-8000-000000000001';
const TASK_UPDATED_AT = new Date('2026-10-19T00:00:00.000Z');
const TERMINAL_ID = 'local-model-terminal-1';

const human: DispatchPrincipal = { type: 'human', id: ACTOR_ID };
const agent: DispatchPrincipal = { type: 'agent', id: ACTOR_ID, workspaceId: WORKSPACE_ID };
const issueInput: IssueDispatchRequest = {
  expectedTaskRevision: 3,
  expectedTaskStatus: 'todo',
  expectedTaskUpdatedAt: TASK_UPDATED_AT.toISOString(),
  idempotencyKey: 'request-2026-10-19-0001',
  request: { operation: 'run-checks', args: ['--strict'] },
  executionContext: { project: 'fixture-project', commit: 'a'.repeat(40) },
};

class FixedIds {
  private index = 1;
  generate(): string {
    const value = `40000000-0000-4000-8000-${String(this.index).padStart(12, '0')}`;
    this.index += 1;
    return value;
  }
}

class LocalModeledTerminalAuthority implements TerminalDeclarationAuthority {
  mismatch: 'id' | 'context' | 'malformed' | null = null;
  calls: TerminalBindingRequest[] = [];

  async verifyBinding(request: TerminalBindingRequest): Promise<VerifiedTerminalDeclaration> {
    this.calls.push(request);
    if (this.mismatch === 'malformed') return {} as VerifiedTerminalDeclaration;
    return {
      terminalDeclarationId: this.mismatch === 'id' ? 'other-terminal' : request.terminalDeclarationId,
      terminalDeclarationSha256: 'b'.repeat(64),
      executionContextSha256: this.mismatch === 'context' ? 'c'.repeat(64) : request.executionContextSha256,
      authorityRef: 'local-test-model-only',
    };
  }
}

function makeDatabase() {
  const task = {
    id: TASK_ID,
    projectId: '50000000-0000-4000-8000-000000000001',
    workspaceId: WORKSPACE_ID,
    revision: 3,
    status: 'todo',
    updatedAt: new Date(TASK_UPDATED_AT),
  };
  const rows = new Map<string, Record<string, unknown>>();
  const unique = new Map<string, string>();
  let membershipRole: string | null = 'developer';
  let agentTaskAuthorized = true;

  const reservation = {
    findUnique: jest.fn(async (args: { where: Record<string, unknown> }) => {
      if (typeof args.where['dispatchId'] === 'string') return rows.get(args.where['dispatchId']) ?? null;
      const key = args.where['taskDispatchIdempotency'] as Record<string, string> | undefined;
      if (key) {
        const compound = `${key['taskId']}|${key['actorType']}|${key['actorId']}|${key['idempotencyKey']}`;
        const id = unique.get(compound);
        return id ? rows.get(id) ?? null : null;
      }
      return null;
    }),
    create: jest.fn(async (args: { data: Record<string, unknown> }) => {
      const row: Record<string, unknown> = {
        ...args.data,
        createdAt: new Date(TASK_UPDATED_AT),
        boundAt: null,
        consumedAt: null,
        revokedAt: null,
        terminalDeclarationId: null,
        terminalDeclarationSha256: null,
        terminalContextSha256: null,
        terminalAuthorityRef: null,
      };
      rows.set(String(row['dispatchId']), row);
      const compound = `${row['taskId']}|${row['actorType']}|${row['actorId']}|${row['idempotencyKey']}`;
      unique.set(compound, String(row['dispatchId']));
      return row;
    }),
    updateMany: jest.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const row = rows.get(String(args.where['dispatchId']));
      if (!row) return { count: 0 };
      for (const field of ['taskId', 'launchAttemptId', 'actorType', 'actorId', 'requestSha256', 'executionContextSha256', 'terminalContextSha256']) {
        if (args.where[field] !== undefined && row[field] !== args.where[field]) return { count: 0 };
      }
      const state = args.where['state'];
      if (typeof state === 'string' && row['state'] !== state) return { count: 0 };
      if (state && typeof state === 'object' && 'in' in state) {
        const accepted = (state as { in: string[] }).in;
        if (!accepted.includes(String(row['state']))) return { count: 0 };
      }
      if (args.where['expectedTaskRevision'] !== undefined && row['expectedTaskRevision'] !== args.where['expectedTaskRevision']) return { count: 0 };
      if (args.where['expectedTaskStatus'] !== undefined && row['expectedTaskStatus'] !== args.where['expectedTaskStatus']) return { count: 0 };
      row['state'] = args.data['state'] ?? row['state'];
      Object.assign(row, args.data);
      return { count: 1 };
    }),
  };

  type MockDatabase = {
    taskDispatchReservation: typeof reservation;
    task: { findFirst: ReturnType<typeof jest.fn> };
    workspaceMember: { findUnique: ReturnType<typeof jest.fn> };
    $queryRaw: ReturnType<typeof jest.fn>;
    $transaction: ReturnType<typeof jest.fn>;
    changeTask: (changes: Partial<typeof task>) => void;
    setMembershipRole: (role: string | null) => void;
    setAgentTaskAuthorized: (authorized: boolean) => void;
    getRows: () => Map<string, Record<string, unknown>>;
  };
  const db: MockDatabase = {
    taskDispatchReservation: reservation,
    task: {
      findFirst: jest.fn(async () => agentTaskAuthorized ? { id: TASK_ID } : null),
    },
    workspaceMember: {
      findUnique: jest.fn(async () => membershipRole ? { role: membershipRole } : null),
    },
    $queryRaw: jest.fn(async (query: { values?: unknown[] }) => {
      const queryTaskId = query.values?.[0];
      return queryTaskId === OTHER_TASK_ID ? [] : [{ ...task }];
    }),
    $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    changeTask: (changes: Partial<typeof task>) => Object.assign(task, changes),
    setMembershipRole: (role: string | null) => { membershipRole = role; },
    setAgentTaskAuthorized: (authorized: boolean) => { agentTaskAuthorized = authorized; },
    getRows: () => rows,
  };
  return db;
}

function serviceFor(db: ReturnType<typeof makeDatabase>, terminal = new LocalModeledTerminalAuthority()) {
  return {
    service: new DispatchAuthorityService(db as unknown as PrismaService, new FixedIds(), terminal),
    terminal,
  };
}

async function issueOne(service: DispatchAuthorityService, actor: DispatchPrincipal = human) {
  return service.issue(TASK_ID, actor, issueInput);
}

describe('Muneral per-dispatch authority source controls (repository and terminal adapters are local test doubles)', () => {
  it('issues distinct server identities and replays only byte-identical idempotent requests', async () => {
    const db = makeDatabase();
    const { service } = serviceFor(db);
    const first = await issueOne(service);
    const replay = await issueOne(service);

    expect(first.state).toBe('reserved');
    expect(first.dispatchId).not.toBe(first.launchAttemptId);
    expect(replay).toMatchObject({
      dispatchId: first.dispatchId,
      launchAttemptId: first.launchAttemptId,
      requestSha256: first.requestSha256,
      executionContextSha256: first.executionContextSha256,
      idempotent: true,
    });
    expect(db.taskDispatchReservation.create).toHaveBeenCalledTimes(1);

    await expect(service.issue(TASK_ID, human, {
      ...issueInput,
      request: { operation: 'different' },
    })).rejects.toBeInstanceOf(ConflictException);

    const retry = await service.issue(TASK_ID, human, {
      ...issueInput,
      idempotencyKey: 'request-2026-10-19-0002',
    });
    expect(retry.dispatchId).not.toBe(first.dispatchId);
    expect(retry.launchAttemptId).not.toBe(first.launchAttemptId);
  });

  it('requires verified terminal binding, then consumes a dispatch exactly once', async () => {
    const db = makeDatabase();
    const { service, terminal } = serviceFor(db);
    const reservation = await issueOne(service);
    const path = [TASK_ID, reservation.launchAttemptId, reservation.dispatchId] as const;

    await expect(service.consumeForStart(...path, human)).rejects.toBeInstanceOf(ConflictException);
    const bound = await service.bindTerminal(...path, human, TERMINAL_ID);
    expect(bound.state).toBe('bound');
    expect(bound.terminalDeclarationId).toBe(TERMINAL_ID);
    expect(terminal.calls[0]?.executionContextSha256).toBe(reservation.executionContextSha256);
    const consumed = await service.consumeForStart(...path, human);
    expect(consumed.state).toBe('consumed');
    expect(consumed.consumedAt).not.toBeNull();
    await expect(service.consumeForStart(...path, human)).rejects.toBeInstanceOf(ConflictException);
  });

  it('revokes reservations idempotently and refuses later binding or consumption', async () => {
    const db = makeDatabase();
    const { service } = serviceFor(db);
    const reservation = await issueOne(service);
    const path = [TASK_ID, reservation.launchAttemptId, reservation.dispatchId] as const;
    const revoked = await service.revoke(...path, human);
    const replay = await service.revoke(...path, human);
    expect(revoked.state).toBe('revoked');
    expect(replay.idempotent).toBe(true);
    await expect(service.bindTerminal(...path, human, TERMINAL_ID)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.consumeForStart(...path, human)).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses missing terminal authority and mismatched terminal/context responses', async () => {
    const unavailableDb = makeDatabase();
    const unavailable = new DispatchAuthorityService(
      unavailableDb as unknown as PrismaService,
      new FixedIds(),
      new UnavailableTerminalDeclarationAuthority(),
    );
    const first = await issueOne(unavailable);
    await expect(unavailable.bindTerminal(TASK_ID, first.launchAttemptId, first.dispatchId, human, TERMINAL_ID))
      .rejects.toBeInstanceOf(TerminalAuthorityUnavailableException);
    expect(unavailableDb.getRows().get(first.dispatchId)?.['state']).toBe('reserved');

    for (const mismatch of ['id', 'context', 'malformed'] as const) {
      const db = makeDatabase();
      const localAuthority = new LocalModeledTerminalAuthority();
      localAuthority.mismatch = mismatch;
      const { service } = serviceFor(db, localAuthority);
      const reservation = await issueOne(service);
      await expect(service.bindTerminal(TASK_ID, reservation.launchAttemptId, reservation.dispatchId, human, TERMINAL_ID))
        .rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(db.getRows().get(reservation.dispatchId)?.['state']).toBe('reserved');
    }
  });

  it('refuses stale task versions and modified persisted request/context bytes', async () => {
    const staleDb = makeDatabase();
    const { service } = serviceFor(staleDb);
    const stale = await issueOne(service);
    staleDb.changeTask({ revision: 4 });
    await expect(service.bindTerminal(TASK_ID, stale.launchAttemptId, stale.dispatchId, human, TERMINAL_ID))
      .rejects.toBeInstanceOf(ConflictException);

    const tamperedDb = makeDatabase();
    const tamperedService = serviceFor(tamperedDb).service;
    const tampered = await issueOne(tamperedService);
    const row = tamperedDb.getRows().get(tampered.dispatchId)!;
    row['executionContextBytes'] = Buffer.from('{"project":"different"}', 'utf8');
    await expect(tamperedService.bindTerminal(TASK_ID, tampered.launchAttemptId, tampered.dispatchId, human, TERMINAL_ID))
      .rejects.toBeInstanceOf(ConflictException);

    const cancelledDb = makeDatabase();
    const { service: cancelledService } = serviceFor(cancelledDb);
    const cancellable = await issueOne(cancelledService);
    await cancelledService.bindTerminal(TASK_ID, cancellable.launchAttemptId, cancellable.dispatchId, human, TERMINAL_ID);
    cancelledDb.changeTask({ status: 'cancelled', updatedAt: new Date('2026-10-19T00:00:01.000Z') });
    await expect(cancelledService.consumeForStart(TASK_ID, cancellable.launchAttemptId, cancellable.dispatchId, human))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses wrong task, attempt, dispatch, and authenticated principal identities', async () => {
    const db = makeDatabase();
    const { service } = serviceFor(db);
    const reservation = await issueOne(service);
    await expect(service.consumeForStart(OTHER_TASK_ID, reservation.launchAttemptId, reservation.dispatchId, human))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(service.consumeForStart(TASK_ID, '40000000-0000-4000-8000-000000000099', reservation.dispatchId, human))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(service.consumeForStart(TASK_ID, reservation.launchAttemptId, '40000000-0000-4000-8000-000000000099', human))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(service.revoke(TASK_ID, reservation.launchAttemptId, reservation.dispatchId, {
      type: 'human', id: OTHER_ACTOR_ID,
    })).rejects.toBeInstanceOf(ForbiddenException);

    db.setMembershipRole('viewer');
    await expect(issueOne(service)).rejects.toBeInstanceOf(ForbiddenException);
    db.setMembershipRole('developer');
    db.changeTask({ workspaceId: WORKSPACE_ID });
    db.setAgentTaskAuthorized(false);
    await expect(issueOne(service, agent)).rejects.toBeInstanceOf(ForbiddenException);
    db.setAgentTaskAuthorized(true);
    await expect(issueOne(service, { ...agent, workspaceId: '30000000-0000-4000-8000-000000000099' }))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('derives the HTTP principal only from prior authentication and membership/agent scope', async () => {
    let authorizedTask: { id: string } | null = { id: TASK_ID };
    const prisma = { task: { findFirst: jest.fn(async () => authorizedTask) } };
    const guard = new DispatchPrincipalGuard(prisma as unknown as PrismaService);
    const humanRequest = { params: { taskId: TASK_ID }, user: { id: ACTOR_ID } };
    const humanContext = {
      switchToHttp: () => ({ getRequest: () => humanRequest }),
    } as unknown as ExecutionContext;
    expect(await guard.canActivate(humanContext)).toBe(true);
    expect(humanRequest).toMatchObject({ dispatchPrincipal: { type: 'human', id: ACTOR_ID } });

    const arrayParamContext = {
      switchToHttp: () => ({ getRequest: () => ({ ...humanRequest, params: { taskId: [TASK_ID] } }) }),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(arrayParamContext)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.task.findFirst).toHaveBeenCalledTimes(1);

    authorizedTask = null;
    await expect(guard.canActivate(humanContext)).rejects.toBeInstanceOf(ForbiddenException);

    const unscopedAgentRequest = {
      params: { taskId: TASK_ID },
      apiKeyAgent: { id: ACTOR_ID, workspaceId: WORKSPACE_ID },
    };
    const unscopedAgentContext = {
      switchToHttp: () => ({ getRequest: () => unscopedAgentRequest }),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(unscopedAgentContext)).rejects.toBeInstanceOf(ForbiddenException);

    const arrayAgentContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          ...unscopedAgentRequest,
          params: { taskId: [TASK_ID] },
          agentScope: { kind: 'task-status', agentId: ACTOR_ID },
        }),
      }),
    } as unknown as ExecutionContext;
    await expect(guard.canActivate(arrayAgentContext)).rejects.toBeInstanceOf(ForbiddenException);

    const scopedAgentContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          ...unscopedAgentRequest,
          agentScope: { kind: 'task-status', agentId: ACTOR_ID },
        }),
      }),
    } as unknown as ExecutionContext;
    expect(await guard.canActivate(scopedAgentContext)).toBe(true);
  });
});
