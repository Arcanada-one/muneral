// MUN-0020: Service-path disposable PostgreSQL integration tests.
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { ExecutionAuthorityService } from '../src/execution-authority/execution-authority.service';
import type { Clock, IdSource } from '../src/execution-authority/execution-authority.types';
import {
  StaleVersionError, InvalidTransitionError,
  IdempotencyCollisionError, UnissuedAttemptError,
  RetryBudgetExhaustedError, RetryBackoffError,
} from '../src/execution-authority/execution-authority.errors';
import { replayJournal, decisionHash } from '../src/execution-authority/execution-authority.replay';
import { commandDigest } from '../src/execution-authority/canonical-json';
import { EvidenceRefValidationError } from '../src/execution-authority/evidence-ref.validator';

// Separate task IDs for test isolation
const TID = 'a0000000-0000-0000-0000-000000000002';
const TID_CONC = 'a0000000-0000-0000-0000-000000000004'; // needs own task in preseed
// Use task-2 for sequential tests, task-4 for concurrency (preseed has tasks 1-2 only)
// We'll create task-4 dynamically or use a fresh initial attempt on task-2

let att1: string;
let origAtt1: string;    // original attempt from test 1, never reassigned
let storedResult: any = null;  // stored full result from test 2 for replay comparison

function makeUuid(seq: number): string {
  return `d0000000-0000-0000-0000-${String(seq).padStart(12,'0')}`;
}
let uuidSeq = 0;
const idSrc: IdSource = { generate: () => makeUuid(++uuidSeq) };

const START = new Date('2026-07-30T12:00:00Z');
let ct = START.getTime();
const clk: Clock = { now: () => new Date(ct) };
function tick(ms: number) { ct += ms; }

const describeIf = process.env.MUN0020_DB_URL ? describe : describe.skip;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function must(r: any): any {
  if (r instanceof Error) { throw new Error(`${r.constructor.name}: ${r.message}`); }
  return r;
}

/** Snapshot all three table counts for the task under test */
async function snapCounts(p: any, tid: string) {
  return {
    state: await p.taskExecutionState.count({ where: { taskId: tid } }),
    attempts: await p.taskExecutionAttempt.count({ where: { taskId: tid } }),
    transitions: await p.taskExecutionTransition.count({ where: { taskId: tid } }),
  };
}

async function seedTask(p: any, tid: string, title: string): Promise<void> {
  await p.$executeRawUnsafe(
    `INSERT INTO public.tasks (id, project_id, title, status, priority, updated_at)
     VALUES ($1::uuid, '20000000-0000-0000-0000-000000000001', $2, 'todo', 'medium', now())
     ON CONFLICT DO NOTHING`,
    tid,
    title,
  );
}

function initialCommandWithEvidence(
  taskId: string,
  idempotencyKey: string,
  ref: unknown,
) {
  return {
    kind: 'issue_initial_attempt' as const,
    taskId,
    expectedVersion: 0,
    idempotencyKey,
    causationId: 'cause-structural-validation',
    correlationId: 'corr-structural-validation',
    retryBudget: 3,
    retryBackoffMs: 100,
    evidenceRefs: [ref] as never[],
  };
}

function expectEvidenceValidationError(result: unknown): EvidenceRefValidationError {
  expect(result).toBeInstanceOf(EvidenceRefValidationError);
  const err = result as EvidenceRefValidationError;
  expect(err.reason.length).toBeLessThanOrEqual(128);
  expect(err.message.length).toBeLessThanOrEqual(192);
  return err;
}

describeIf('ExecutionAuthorityService — disposable PostgreSQL', () => {
  let prisma: any;
  let svc: ExecutionAuthorityService;

  beforeAll(() => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.MUN0020_DB_URL! }) });
    svc = new ExecutionAuthorityService(clk, idSrc);
  });
  afterAll(async () => { await prisma.$disconnect(); });

  // =====================================================================
  // EvidenceRef structural boundary — every rejection must leave no rows
  // =====================================================================

  it('0a: non-enumerable uri is rejected with no database residue', async () => {
    const taskId = 'a0000000-0000-0000-0000-000000000020';
    await seedTask(prisma, taskId, 'Hidden URI validation');
    const before = await snapCounts(prisma, taskId);
    const ref = {
      digest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contentType: 'text/plain',
    };
    Object.defineProperty(ref, 'uri', {
      value: 'tasks/task-20/evidence/log.txt',
      enumerable: false,
      configurable: true,
    });

    const result = await svc.executeCommand(
      prisma,
      initialCommandWithEvidence(taskId, 'struct-hidden-uri', ref),
    );

    const err = expectEvidenceValidationError(result);
    expect(err.reason).toBe(
      'evidence reference fields must be own enumerable data properties',
    );
    expect(await snapCounts(prisma, taskId)).toEqual(before);
  });

  it('0b: uri accessor is rejected without invocation or database residue', async () => {
    const taskId = 'a0000000-0000-0000-0000-000000000021';
    await seedTask(prisma, taskId, 'Accessor URI validation');
    const before = await snapCounts(prisma, taskId);
    let getterHits = 0;
    const ref = {
      digest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contentType: 'text/plain',
      get uri() {
        getterHits += 1;
        return 'tasks/task-21/evidence/log.txt';
      },
    };

    const result = await svc.executeCommand(
      prisma,
      initialCommandWithEvidence(taskId, 'struct-accessor-uri', ref),
    );

    const err = expectEvidenceValidationError(result);
    expect(err.reason).toBe(
      'evidence reference fields must be own enumerable data properties',
    );
    expect(getterHits).toBe(0);
    expect(await snapCounts(prisma, taskId)).toEqual(before);
  });

  it('0c: class instance is rejected before canonicalization with no residue', async () => {
    const taskId = 'a0000000-0000-0000-0000-000000000022';
    await seedTask(prisma, taskId, 'Class instance validation');
    const before = await snapCounts(prisma, taskId);

    class EvidenceFixture {
      uri = 'tasks/task-22/evidence/log.txt';
      digest =
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      contentType = 'text/plain';
    }

    const result = await svc.executeCommand(
      prisma,
      initialCommandWithEvidence(
        taskId,
        'struct-class-instance',
        new EvidenceFixture(),
      ),
    );

    const err = expectEvidenceValidationError(result);
    expect(err.reason).toBe('evidence reference must be a plain object');
    expect(await snapCounts(prisma, taskId)).toEqual(before);
  });

  it('0d: Object.prototype evidence pollution is rejected with no residue', async () => {
    const taskId = 'a0000000-0000-0000-0000-000000000023';
    await seedTask(prisma, taskId, 'Prototype pollution validation');
    const before = await snapCounts(prisma, taskId);
    const fieldNames = ['uri', 'digest', 'contentType'] as const;
    const previous = new Map(
      fieldNames.map((field) => [
        field,
        Object.getOwnPropertyDescriptor(Object.prototype, field),
      ]),
    );
    let result: unknown;

    try {
      Object.defineProperties(Object.prototype, {
        uri: {
          value: 'tasks/task-23/evidence/log.txt',
          enumerable: true,
          configurable: true,
        },
        digest: {
          value:
            'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          enumerable: true,
          configurable: true,
        },
        contentType: {
          value: 'text/plain',
          enumerable: true,
          configurable: true,
        },
      });
      result = await svc.executeCommand(
        prisma,
        initialCommandWithEvidence(taskId, 'struct-prototype-pollution', {}),
      );
    } finally {
      for (const field of fieldNames) {
        const descriptor = previous.get(field);
        if (descriptor) {
          Object.defineProperty(Object.prototype, field, descriptor);
        } else {
          delete (Object.prototype as Record<string, unknown>)[field];
        }
      }
    }

    const err = expectEvidenceValidationError(result);
    expect(err.reason).toBe(
      'evidence reference fields must be own enumerable data properties',
    );
    expect(await snapCounts(prisma, taskId)).toEqual(before);
  });

  it('0e: attacker-sized unknown key has bounded diagnostics and no residue', async () => {
    const taskId = 'a0000000-0000-0000-0000-000000000024';
    await seedTask(prisma, taskId, 'Bounded diagnostic validation');
    const before = await snapCounts(prisma, taskId);
    const attackerKey = 'x'.repeat(100_000);
    const ref = {
      uri: 'tasks/task-24/evidence/log.txt',
      digest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contentType: 'text/plain',
      [attackerKey]: true,
    };

    const result = await svc.executeCommand(
      prisma,
      initialCommandWithEvidence(taskId, 'struct-long-key', ref),
    );

    const err = expectEvidenceValidationError(result);
    expect(err.reason).toBe('evidence reference contains unknown fields');
    expect(err.message).not.toContain(attackerKey.slice(0, 100));
    expect(await snapCounts(prisma, taskId)).toEqual(before);
  });

  it('0f: JSON-wire evidence persists completely with the canonical digest', async () => {
    const taskId = 'a0000000-0000-0000-0000-000000000025';
    await seedTask(prisma, taskId, 'JSON wire evidence');
    const command = initialCommandWithEvidence(
      taskId,
      'struct-json-wire',
      {
        uri: 'tasks/task-25/evidence/log.txt',
        digest:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        contentType: 'text/plain',
        label: 'Execution log',
      },
    );
    const wireCommand = JSON.parse(JSON.stringify(command));
    const expectedDigest = commandDigest(command);

    expect(commandDigest(wireCommand)).toBe(expectedDigest);
    must(await svc.executeCommand(prisma, wireCommand));

    const stored = await prisma.taskExecutionTransition.findFirst({
      where: {
        taskId,
        idempotencyKey: 'struct-json-wire',
      },
    });
    expect(stored).not.toBeNull();
    expect(stored.commandDigest).toBe(expectedDigest);
    expect(stored.evidenceRefs).toEqual(command.evidenceRefs);
    expect(await snapCounts(prisma, taskId)).toEqual({
      state: 1,
      attempts: 1,
      transitions: 1,
    });
  });

  // =====================================================================
  // Positive path
  // =====================================================================

  it('1: initial issuance creates state + attempt + transition', async () => {
    const s = must(await svc.executeCommand(prisma, {
      kind: 'issue_initial_attempt', taskId: TID, expectedVersion: 0,
      idempotencyKey: 'k1', causationId: 'c', correlationId: 'c',
      retryBudget: 3, retryBackoffMs: 100, evidenceRefs: [],
    }));
    expect(s.state.aggregateVersion).toBe(1);
    expect(s.state.currentAttemptId).toBeTruthy();
    expect(s.state.retryBudget).toBe(3);
    expect(s.state.retryCount).toBe(0);
    expect(await prisma.taskExecutionTransition.count({ where: { taskId: TID } })).toBe(1);
    expect(await prisma.taskExecutionAttempt.count({ where: { taskId: TID } })).toBe(1);
    origAtt1 = s.state.currentAttemptId;
    att1 = origAtt1;
  });

  it('2: transition issued→running updates attempt status + startedAt', async () => {
    const s = must(await svc.executeCommand(prisma, {
      kind: 'transition_attempt', taskId: TID, attemptId: att1,
      expectedVersion: 1, eventType: 'attempt:started',
      idempotencyKey: 'k2', causationId: 'c', correlationId: 'c',
      evidenceRefs: [], payload: {}, committedResult: {},
    }));
    expect(s.state.aggregateVersion).toBe(2);
    // Store full result for deep-replay comparison later
    storedResult = s;
    const a = await prisma.taskExecutionAttempt.findUnique({ where: { attemptId: att1 } });
    expect(a.status).toBe('running');
    expect(a.startedAt).toBeTruthy();
  });

  // =====================================================================
  // Idempotency
  // =====================================================================

  it('3: same-key same-digest → idempotent replay, no new transitions', async () => {
    const snap = await snapCounts(prisma, TID);
    // Exact same command bytes as test 2
    const cmd = {
      kind: 'transition_attempt', taskId: TID, attemptId: att1,
      expectedVersion: 1, eventType: 'attempt:started',
      idempotencyKey: 'k2', causationId: 'c', correlationId: 'c',
      evidenceRefs: [], payload: {}, committedResult: {},
    } as any;
    must(await svc.executeCommand(prisma, cmd));
    const after = await snapCounts(prisma, TID);
    expect(after).toEqual(snap); // no rows added
  });

  it('4: same-key different-digest → IdempotencyCollisionError, no new rows', async () => {
    const snap = await snapCounts(prisma, TID);
    const r = await svc.executeCommand(prisma, {
      kind: 'transition_attempt', taskId: TID, attemptId: att1,
      expectedVersion: 1, eventType: 'attempt:failed',
      idempotencyKey: 'k2', causationId: 'c', correlationId: 'c',
      evidenceRefs: [], payload: { diff: 1 }, committedResult: {},
    });
    expect(r).toBeInstanceOf(IdempotencyCollisionError);
    expect(await snapCounts(prisma, TID)).toEqual(snap);
  });

  // =====================================================================
  // Negative cases — each asserts zero writes via snapshot comparison
  // =====================================================================

  it('5: stale version → StaleVersionError, all tables unchanged', async () => {
    const snap = await snapCounts(prisma, TID);
    const r = await svc.executeCommand(prisma, {
      kind: 'transition_attempt', taskId: TID, attemptId: att1,
      expectedVersion: 99, eventType: 'attempt:failed',
      idempotencyKey: 'k5', causationId: 'c', correlationId: 'c',
      evidenceRefs: [], payload: {}, committedResult: {},
    });
    expect(r).toBeInstanceOf(StaleVersionError);
    expect(await snapCounts(prisma, TID)).toEqual(snap);
  });

  it('6: invalid transition → InvalidTransitionError, all tables unchanged', async () => {
    const snap = await snapCounts(prisma, TID);
    const r = await svc.executeCommand(prisma, {
      kind: 'transition_attempt', taskId: TID, attemptId: att1,
      expectedVersion: 2, eventType: 'attempt:started', // already running
      idempotencyKey: 'k6', causationId: 'c', correlationId: 'c',
      evidenceRefs: [], payload: {}, committedResult: {},
    });
    expect(r).toBeInstanceOf(InvalidTransitionError);
    expect(await snapCounts(prisma, TID)).toEqual(snap);
  });

  it('7: unissued attempt → UnissuedAttemptError, all tables unchanged', async () => {
    const snap = await snapCounts(prisma, TID);
    const r = await svc.executeCommand(prisma, {
      kind: 'transition_attempt', taskId: TID,
      attemptId: '99999999-9999-9999-9999-999999999999',
      expectedVersion: 2, eventType: 'attempt:failed',
      idempotencyKey: 'k7', causationId: 'c', correlationId: 'c',
      evidenceRefs: [], payload: {}, committedResult: {},
    });
    expect(r).toBeInstanceOf(UnissuedAttemptError);
    expect(await snapCounts(prisma, TID)).toEqual(snap);
  });

  // =====================================================================
  // Current-attempt FK negative
  // =====================================================================

  it('8: foreign current_attempt_id rejected by DEFERRABLE composite FK', async () => {
    // Seed a fresh task that exists in tasks but has NO execution state
    const FK_TID = 'a0000000-0000-0000-0000-000000000010';
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.tasks (id, project_id, title, status, priority, updated_at)
       VALUES ($1::uuid, '20000000-0000-0000-0000-000000000001', 'FK Test', 'todo', 'medium', now())
       ON CONFLICT DO NOTHING`,
      FK_TID,
    );
    // The tasks FK passes (task exists), but the DEFERRABLE composite FK
    // (current_attempt_id, task_id) → task_execution_attempts MUST reject.
    let fkError: any;
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO public.task_execution_state (task_id, aggregate_version, current_attempt_id, retry_budget, retry_count, retry_backoff_ms)
         VALUES ($1::uuid, 1, $2::uuid, 3, 0, 100)`,
        FK_TID,
        '99999999-9999-9999-9999-999999999998',
      );
      throw new Error('expected FK rejection but insert succeeded');
    } catch (e: any) {
      fkError = e;
    }
    // Must name the exact constraint
    expect(fkError.message).toContain('task_execution_state_current_attempt_fkey');

    // Verify no execution-state row exists for the FK task
    const row = await prisma.taskExecutionState.findUnique({ where: { taskId: FK_TID } });
    expect(row).toBeNull();
  });

  // =====================================================================
  // Retry lifecycle
  // =====================================================================

  it('9: fail → advance past backoff → retry succeeds', async () => {
    must(await svc.executeCommand(prisma, {
      kind: 'transition_attempt', taskId: TID, attemptId: att1,
      expectedVersion: 2, eventType: 'attempt:failed',
      idempotencyKey: 'k9a', causationId: 'c', correlationId: 'c',
      evidenceRefs: [], payload: {}, committedResult: {},
    }));
    tick(200); // past 100ms backoff
    const s = must(await svc.executeCommand(prisma, {
      kind: 'issue_retry_attempt', taskId: TID, expectedVersion: 3,
      idempotencyKey: 'k9b', causationId: 'c', correlationId: 'c',
      evidenceRefs: [],
    }));
    expect(s.state.retryCount).toBe(1);
    expect(s.state.aggregateVersion).toBe(4);
    expect(s.state.currentAttemptId).toBeTruthy();
    expect(s.state.currentAttemptId).not.toBe(att1);
    att1 = s.state.currentAttemptId; // update to new current
  });

  it('10: retry before backoff → RetryBackoffError, all tables unchanged', async () => {
    // Fail current attempt
    must(await svc.executeCommand(prisma, {
      kind: 'transition_attempt', taskId: TID, attemptId: att1,
      expectedVersion: 4, eventType: 'attempt:failed',
      idempotencyKey: 'k10a', causationId: 'c', correlationId: 'c',
      evidenceRefs: [], payload: {}, committedResult: {},
    }));
    const snap = await snapCounts(prisma, TID);
    // No tick — backoff not elapsed
    const r = await svc.executeCommand(prisma, {
      kind: 'issue_retry_attempt', taskId: TID, expectedVersion: 5,
      idempotencyKey: 'k10b', causationId: 'c', correlationId: 'c',
      evidenceRefs: [],
    });
    expect(r).toBeInstanceOf(RetryBackoffError);
    expect(await snapCounts(prisma, TID)).toEqual(snap);
  });

  // =====================================================================
  // Retry budget exhaustion
  // =====================================================================

  it('11: budget exhausted → RetryBudgetExhaustedError, all tables unchanged', async () => {
    // Advance past backoff, then spend remaining budget (1 used, need 2 more to reach 3)
    tick(5000);
    for (let i = 0; i < 2; i++) {
      tick(1000);
      const s = must(await svc.executeCommand(prisma, {
        kind: 'issue_retry_attempt', taskId: TID, expectedVersion: 5 + i*2,
        idempotencyKey: `k11r${i}`, causationId: 'c', correlationId: 'c',
        evidenceRefs: [],
      }));
      must(await svc.executeCommand(prisma, {
        kind: 'transition_attempt', taskId: TID, attemptId: s.state.currentAttemptId,
        expectedVersion: s.state.aggregateVersion, eventType: 'attempt:failed',
        idempotencyKey: `k11f${i}`, causationId: 'c', correlationId: 'c',
        evidenceRefs: [], payload: {}, committedResult: {},
      }));
    }
    tick(5000);
    const snap = await snapCounts(prisma, TID);
    const r = await svc.executeCommand(prisma, {
      kind: 'issue_retry_attempt', taskId: TID, expectedVersion: 9,
      idempotencyKey: 'k11final', causationId: 'c', correlationId: 'c',
      evidenceRefs: [],
    });
    expect(r).toBeInstanceOf(RetryBudgetExhaustedError);
    expect(await snapCounts(prisma, TID)).toEqual(snap);
  });

  // =====================================================================
  // Deep idempotent replay after state advancement
  // =====================================================================

  it('11b: deep-replay old key after many later transitions', async () => {
    // Confirm current state has advanced well past version 2
    const curState = await prisma.taskExecutionState.findUnique({ where: { taskId: TID } });
    expect(Number(curState.aggregateVersion)).toBeGreaterThan(4);
    const snap = await snapCounts(prisma, TID);

    // Replay exact same command as test 2 (idempotencyKey 'k2', expectedVersion 1, origAtt1)
    const cmd = {
      kind: 'transition_attempt' as const, taskId: TID, attemptId: origAtt1,
      expectedVersion: 1, eventType: 'attempt:started' as const,
      idempotencyKey: 'k2', causationId: 'c', correlationId: 'c',
      evidenceRefs: [] as any[], payload: {}, committedResult: {},
    };
    const replay = must(await svc.executeCommand(prisma, cmd));

    // Full deep equality: committedResult, transition, and historical state
    // must match the stored original exactly.
    expect(replay).toEqual(storedResult);

    // Live DB current version must be higher (state advanced past version 2)
    const curState2 = await prisma.taskExecutionState.findUnique({ where: { taskId: TID } });
    expect(Number(curState2.aggregateVersion)).toBeGreaterThan(2);

    // No new transition created — table counts unchanged
    const after = await snapCounts(prisma, TID);
    expect(after).toEqual(snap);
  });

  // =====================================================================
  // Concurrent same-expectedVersion race — exactly one wins
  // =====================================================================

  it('12: concurrent same-expectedVersion → exactly one succeeds', async () => {
    // Fresh task with its own initial attempt — avoid budget exhaustion from prior tests
    const CONC_TID = 'a0000000-0000-0000-0000-000000000005';
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.tasks (id, project_id, title, status, priority, updated_at)
       VALUES ($1::uuid, '20000000-0000-0000-0000-000000000001', 'Concurrency', 'todo', 'medium', now())
       ON CONFLICT DO NOTHING`,
      CONC_TID,
    );

    // Issue + start so we have a running attempt to race failed transitions on
    const r1 = must(await svc.executeCommand(prisma, {
      kind: 'issue_initial_attempt', taskId: CONC_TID, expectedVersion: 0,
      idempotencyKey: 'conc-i1', causationId: 'c', correlationId: 'c',
      retryBudget: 3, retryBackoffMs: 100, evidenceRefs: [],
    }));
    const att = r1.state.currentAttemptId;
    const started = must(await svc.executeCommand(prisma, {
      kind: 'transition_attempt', taskId: CONC_TID, attemptId: att,
      expectedVersion: 1, eventType: 'attempt:started',
      idempotencyKey: 'conc-i2', causationId: 'c', correlationId: 'c',
      evidenceRefs: [], payload: {}, committedResult: {},
    }));

    const raceVer = started.state.aggregateVersion; // 2
    const snap = await snapCounts(prisma, CONC_TID);

    const cmd = {
      kind: 'transition_attempt' as const, taskId: CONC_TID, attemptId: att,
      expectedVersion: raceVer, eventType: 'attempt:failed' as const,
      causationId: 'c', correlationId: 'c',
      evidenceRefs: [] as any[], payload: {}, committedResult: {},
    };

    const url = process.env.MUN0020_DB_URL!;
    const p1 = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    const p2 = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

    try {
      const [r1, r2] = await Promise.all([
        svc.executeCommand(p1, { ...cmd, idempotencyKey: 'conc-a' }),
        svc.executeCommand(p2, { ...cmd, idempotencyKey: 'conc-b' }),
      ]);

      const err1 = r1 instanceof Error;
      const err2 = r2 instanceof Error;
      // Exactly one must succeed, the other must fail with StaleVersionError
      if (!err1 && err2) {
        expect(r2).toBeInstanceOf(StaleVersionError);
      } else if (err1 && !err2) {
        expect(r1).toBeInstanceOf(StaleVersionError);
      } else {
        // Both same — report details for diagnosis
        throw new Error(
          `Concurrency invariant violated: r1=${r1 instanceof Error ? r1.constructor.name : 'OK'}, ` +
          `r2=${r2 instanceof Error ? r2.constructor.name : 'OK'}`,
        );
      }

      const after = await snapCounts(prisma, CONC_TID);
      // State and attempt counts unchanged; exactly one new transition
      expect(after.state).toBe(snap.state);
      expect(after.attempts).toBe(snap.attempts);
      expect(after.transitions).toBe(snap.transitions + 1);

      // Read aggregate — version must have advanced by exactly 1
      const cur2 = await prisma.taskExecutionState.findUnique({ where: { taskId: CONC_TID } });
      expect(Number(cur2.aggregateVersion)).toBe(raceVer + 1);
      // Attempt status must be 'failed' (the winning command's eventType)
      const att2 = await prisma.taskExecutionAttempt.findUnique({ where: { attemptId: att } });
      expect(att2.status).toBe('failed');
    } finally {
      await p1.$disconnect();
      await p2.$disconnect();
    }
  });

  // =====================================================================
  // Atomic rollback — trigger-induced post-write crash proves no residue
  // =====================================================================

  it('13: trigger-induced post-write exception → full rollback, no residue', async () => {
    const ROLLBACK_TID = 'a0000000-0000-0000-0000-000000000003';

    // Seed the task row (needed for FK), then verify zero execution rows
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.tasks (id, project_id, title, status, priority, updated_at)
       VALUES ($1::uuid, '20000000-0000-0000-0000-000000000001', 'Rollback Test', 'todo', 'medium', now())
       ON CONFLICT DO NOTHING`,
      ROLLBACK_TID,
    );
    const snap = await snapCounts(prisma, ROLLBACK_TID);
    expect(snap.state).toBe(0);
    expect(snap.attempts).toBe(0);
    expect(snap.transitions).toBe(0);

    // Install trigger on the PUBLIC schema table (pg_temp not visible to Prisma connections)
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION public.mun0020_rollback_test() RETURNS trigger
      LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
      BEGIN
        RAISE EXCEPTION 'MUN0020 injected crash after journal insert';
      END;
      $fn$;
      DROP TRIGGER IF EXISTS mun0020_rollback_trigger ON public.task_execution_transitions;
      CREATE TRIGGER mun0020_rollback_trigger
      AFTER INSERT ON public.task_execution_transitions
      FOR EACH ROW EXECUTE FUNCTION public.mun0020_rollback_test();
    `);

    try {
      await svc.executeCommand(prisma, {
        kind: 'issue_initial_attempt', taskId: ROLLBACK_TID,
        expectedVersion: 0, idempotencyKey: 'rollback-k',
        causationId: 'c', correlationId: 'c',
        retryBudget: 3, retryBackoffMs: 100, evidenceRefs: [],
      });
      throw new Error('expected rollback did not happen');
    } catch (e: any) {
      expect(e.message).toContain('MUN0020 injected crash');
    } finally {
      // Drop the trigger and function even on failure
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS mun0020_rollback_trigger ON public.task_execution_transitions;
        DROP FUNCTION IF EXISTS public.mun0020_rollback_test();
      `);
    }

    // Verify zero rows for this task in all three execution tables
    const after = await snapCounts(prisma, ROLLBACK_TID);
    expect(after).toEqual({ state: 0, attempts: 0, transitions: 0 });
  });

  // =====================================================================
  // Replay — byte-equivalent comparison with independent DB snapshot
  // =====================================================================

  it('14: replay decisionHash matches independently-constructed DB snapshot', async () => {
    // Replay from journal facts only
    const rows = await prisma.taskExecutionTransition.findMany({
      where: { taskId: TID }, orderBy: { aggregateVersion: 'asc' },
    });
    const tx = rows.map((t: any) => ({
      id: t.id, taskId: t.taskId, attemptId: t.attemptId,
      aggregateVersion: Number(t.aggregateVersion), eventType: t.eventType,
      idempotencyKey: t.idempotencyKey, commandDigest: t.commandDigest,
      transitionPayload: t.transitionPayload as Record<string,unknown>,
      committedResult: t.committedResult as Record<string,unknown>,
      evidenceRefs: (t.evidenceRefs as any[]) ?? [],
      causationId: t.causationId, correlationId: t.correlationId,
      recordedAt: new Date(t.recordedAt),
    }));

    const { state: replayed, attempts: replayedAttempts } = replayJournal(tx);
    expect(replayed).not.toBeNull();

    // ---- Independently materialized snapshot from DB tables ----
    const dbSt = await prisma.taskExecutionState.findUnique({ where: { taskId: TID } });
    const dbAttempts = await prisma.taskExecutionAttempt.findMany({
      where: { taskId: TID }, orderBy: { ordinal: 'asc' },
    });

    // Construct domain objects from DB (NOT from replay) for independent hash
    const independentState = {
      taskId: dbSt.taskId,
      aggregateVersion: Number(dbSt.aggregateVersion),
      currentAttemptId: dbSt.currentAttemptId,
      retryBudget: dbSt.retryBudget,
      retryCount: dbSt.retryCount,
      retryBackoffMs: Number(dbSt.retryBackoffMs),
      retryEligibleAt: dbSt.retryEligibleAt,
    };
    const independentAttempts = dbAttempts.map((a: any) => ({
      attemptId: a.attemptId,
      taskId: a.taskId,
      ordinal: a.ordinal,
      status: a.status,
      issuedAt: a.issuedAt,
      startedAt: a.startedAt,
      completedAt: a.completedAt,
    }));

    // Compare decisionHash(replayed) === decisionHash(independent)
    const replayHash = decisionHash(replayed, replayedAttempts);
    const independentHash = decisionHash(
      independentState as any,
      independentAttempts as any,
    );
    expect(replayHash).toBe(independentHash);

    // Also verify raw field-level equivalence for key decision fields
    expect(replayed!.taskId).toBe(independentState.taskId);
    expect(replayed!.aggregateVersion).toBe(independentState.aggregateVersion);
    expect(replayed!.currentAttemptId).toBe(independentState.currentAttemptId);
    expect(replayed!.retryBudget).toBe(independentState.retryBudget);
    expect(replayed!.retryCount).toBe(independentState.retryCount);
    expect(replayed!.retryBackoffMs).toBe(independentState.retryBackoffMs);

    expect(replayedAttempts.length).toBe(independentAttempts.length);
    for (let i = 0; i < replayedAttempts.length; i++) {
      const ra = replayedAttempts[i];
      const ia = independentAttempts[i];
      expect(ra.attemptId).toBe(ia.attemptId);
      expect(ra.ordinal).toBe(ia.ordinal);
      expect(ra.status).toBe(ia.status);
      expect(ra.taskId).toBe(ia.taskId);
    }
  });
});
