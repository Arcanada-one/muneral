// MUN-0020: Service-path disposable PostgreSQL integration tests.
//
// ISOLATION CONTRACT (QA finding F3 — AC7 "no test relies on shared or
// pre-seeded data"):
//   * Every test creates its own task row with a freshly generated UUID via
//     freshTask(), and builds whatever prior aggregate state it needs from
//     scratch. Nothing is carried between `it` blocks in module-level state.
//   * The injected clock and the ID source are reset in beforeEach, so a test
//     run in isolation with `-t` sees exactly the same clock and IDs it sees in
//     a full run.
//   * The only preseeded value still referenced is the project row that
//     execution_authority_preseed.sql creates, because `tasks.project_id` is a
//     NOT NULL foreign key; it is read through PROJECT_ID and asserted to exist
//     in beforeAll so a missing preseed fails loudly instead of cascading into
//     confusing per-test errors.
// The previous revision kept `att1`, `origAtt1`, `storedResult`, `uuidSeq` and
// `ct` across tests, and test 14 depended on the aggregate built by tests 1-11.
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { ExecutionAuthorityService } from '../src/execution-authority/execution-authority.service';
import type { Clock, IdSource } from '../src/execution-authority/execution-authority.types';
import {
  StaleVersionError, InvalidTransitionError,
  IdempotencyCollisionError, UnissuedAttemptError,
  RetryBudgetExhaustedError, RetryBackoffError,
  UnexpectedUniqueViolationError, ExecutionStateAlreadyExistsError,
} from '../src/execution-authority/execution-authority.errors';
import { replayJournal, decisionHash } from '../src/execution-authority/execution-authority.replay';
import { commandDigest } from '../src/execution-authority/canonical-json';
import { EvidenceRefValidationError } from '../src/execution-authority/evidence-ref.validator';

/** Created by execution_authority_preseed.sql; tasks.project_id is NOT NULL. */
const PROJECT_ID = '20000000-0000-0000-0000-000000000001';

const START = new Date('2026-07-30T12:00:00Z');
let ct = START.getTime();
const clk: Clock = { now: () => new Date(ct) };
function tick(ms: number) { ct += ms; }

const idSrc: IdSource = { generate: () => randomUUID() };

const describeIf = process.env.MUN0020_DB_URL ? describe : describe.skip;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function must(r: any): any {
  if (r instanceof Error) { throw new Error(`${r.constructor.name}: ${r.message}`); }
  return r;
}

/** Snapshot all three table counts for the task under test */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function snapCounts(p: any, tid: string) {
  return {
    state: await p.taskExecutionState.count({ where: { taskId: tid } }),
    attempts: await p.taskExecutionAttempt.count({ where: { taskId: tid } }),
    transitions: await p.taskExecutionTransition.count({ where: { taskId: tid } }),
  };
}

/** Create a brand-new task row with a fresh UUID and return its id. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function freshTask(p: any, title: string): Promise<string> {
  const taskId = randomUUID();
  await p.$executeRawUnsafe(
    `INSERT INTO public.tasks (id, project_id, title, status, priority, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, 'todo', 'medium', now())`,
    taskId,
    PROJECT_ID,
    title,
  );
  return taskId;
}

/** Mutable cursor over one task's aggregate, advanced by the helpers below. */
interface Aggregate {
  taskId: string;
  version: number;
  attemptId: string;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let svc: ExecutionAuthorityService;

  // -- per-task aggregate builders (each starts from a brand-new task) --------

  async function seedAggregate(opts?: {
    title?: string;
    retryBudget?: number;
    retryBackoffMs?: number;
  }): Promise<Aggregate> {
    const taskId = await freshTask(prisma, opts?.title ?? 'Execution authority test');
    const r = must(await svc.executeCommand(prisma, {
      kind: 'issue_initial_attempt', taskId, expectedVersion: 0,
      idempotencyKey: 'seed-initial', causationId: 'c', correlationId: 'c',
      retryBudget: opts?.retryBudget ?? 3,
      retryBackoffMs: opts?.retryBackoffMs ?? 100,
      evidenceRefs: [],
    }));
    return { taskId, version: r.state.aggregateVersion, attemptId: r.state.currentAttemptId };
  }

  async function applyTransition(
    agg: Aggregate,
    eventType: 'attempt:started' | 'attempt:failed' | 'attempt:succeeded' | 'attempt:cancelled',
    idempotencyKey: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const r = must(await svc.executeCommand(prisma, {
      kind: 'transition_attempt', taskId: agg.taskId, attemptId: agg.attemptId,
      expectedVersion: agg.version, eventType,
      idempotencyKey, causationId: 'c', correlationId: 'c',
      evidenceRefs: [], payload: {}, committedResult: {},
    }));
    agg.version = r.state.aggregateVersion;
    agg.attemptId = r.state.currentAttemptId ?? agg.attemptId;
    return r;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function issueRetry(agg: Aggregate, idempotencyKey: string): Promise<any> {
    const r = must(await svc.executeCommand(prisma, {
      kind: 'issue_retry_attempt', taskId: agg.taskId, expectedVersion: agg.version,
      idempotencyKey, causationId: 'c', correlationId: 'c', evidenceRefs: [],
    }));
    agg.version = r.state.aggregateVersion;
    agg.attemptId = r.state.currentAttemptId;
    return r;
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.MUN0020_DB_URL! }) });
    svc = new ExecutionAuthorityService(clk, idSrc);
    const project = await prisma.$queryRawUnsafe(
      `SELECT 1 AS ok FROM public.projects WHERE id = $1::uuid`,
      PROJECT_ID,
    );
    if (!Array.isArray(project) || project.length !== 1) {
      throw new Error(
        `execution_authority_preseed.sql has not been applied: project ${PROJECT_ID} is missing`,
      );
    }
  });
  afterAll(async () => { await prisma.$disconnect(); });

  // Reset the injected clock so each test sees the same starting instant
  // whether it runs alone or in a full suite run.
  beforeEach(() => { ct = START.getTime(); });

  // =====================================================================
  // EvidenceRef structural boundary — every rejection must leave no rows
  // =====================================================================

  it('0a: non-enumerable uri is rejected with no database residue', async () => {
    const taskId = await freshTask(prisma, 'Hidden URI validation');
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
    const taskId = await freshTask(prisma, 'Accessor URI validation');
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
    const taskId = await freshTask(prisma, 'Class instance validation');
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
    const taskId = await freshTask(prisma, 'Prototype pollution validation');
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
    const taskId = await freshTask(prisma, 'Bounded diagnostic validation');
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
    const taskId = await freshTask(prisma, 'JSON wire evidence');
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
    const taskId = await freshTask(prisma, 'Initial issuance');
    const s = must(await svc.executeCommand(prisma, {
      kind: 'issue_initial_attempt', taskId, expectedVersion: 0,
      idempotencyKey: 'k1', causationId: 'c', correlationId: 'c',
      retryBudget: 3, retryBackoffMs: 100, evidenceRefs: [],
    }));
    expect(s.state.aggregateVersion).toBe(1);
    expect(s.state.currentAttemptId).toBeTruthy();
    expect(s.state.retryBudget).toBe(3);
    expect(s.state.retryCount).toBe(0);
    expect(await snapCounts(prisma, taskId)).toEqual({
      state: 1, attempts: 1, transitions: 1,
    });
  });

  it('2: transition issued→running updates attempt status + startedAt', async () => {
    const agg = await seedAggregate({ title: 'Issued to running' });
    const s = await applyTransition(agg, 'attempt:started', 'k2');
    expect(s.state.aggregateVersion).toBe(2);
    const a = await prisma.taskExecutionAttempt.findUnique({
      where: { attemptId: agg.attemptId },
    });
    expect(a.status).toBe('running');
    expect(a.startedAt).toBeTruthy();
  });

  // =====================================================================
  // Idempotency
  // =====================================================================

  it('3: same-key same-digest → idempotent replay, no new transitions', async () => {
    const agg = await seedAggregate({ title: 'Idempotent replay' });
    const cmd = {
      kind: 'transition_attempt' as const, taskId: agg.taskId, attemptId: agg.attemptId,
      expectedVersion: 1, eventType: 'attempt:started' as const,
      idempotencyKey: 'k2', causationId: 'c', correlationId: 'c',
      evidenceRefs: [] as never[], payload: {}, committedResult: {},
    };
    const first = must(await svc.executeCommand(prisma, cmd));
    const snap = await snapCounts(prisma, agg.taskId);

    // Exact same command bytes
    const replay = must(await svc.executeCommand(prisma, cmd));
    expect(replay).toEqual(first);
    expect(await snapCounts(prisma, agg.taskId)).toEqual(snap); // no rows added
  });

  it('4: same-key different-digest → IdempotencyCollisionError, no new rows', async () => {
    const agg = await seedAggregate({ title: 'Idempotency collision' });
    await applyTransition(agg, 'attempt:started', 'k2');
    const snap = await snapCounts(prisma, agg.taskId);

    const r = await svc.executeCommand(prisma, {
      kind: 'transition_attempt', taskId: agg.taskId, attemptId: agg.attemptId,
      expectedVersion: 1, eventType: 'attempt:failed',
      idempotencyKey: 'k2', causationId: 'c', correlationId: 'c',
      evidenceRefs: [], payload: { diff: 1 }, committedResult: {},
    });
    expect(r).toBeInstanceOf(IdempotencyCollisionError);
    expect(await snapCounts(prisma, agg.taskId)).toEqual(snap);
  });

  // =====================================================================
  // Negative cases — each asserts zero writes via snapshot comparison
  // =====================================================================

  it('5: stale version → StaleVersionError, all tables unchanged', async () => {
    const agg = await seedAggregate({ title: 'Stale version' });
    const snap = await snapCounts(prisma, agg.taskId);
    const r = await svc.executeCommand(prisma, {
      kind: 'transition_attempt', taskId: agg.taskId, attemptId: agg.attemptId,
      expectedVersion: 99, eventType: 'attempt:failed',
      idempotencyKey: 'k5', causationId: 'c', correlationId: 'c',
      evidenceRefs: [], payload: {}, committedResult: {},
    });
    expect(r).toBeInstanceOf(StaleVersionError);
    expect(await snapCounts(prisma, agg.taskId)).toEqual(snap);
  });

  it('6: invalid transition → InvalidTransitionError, all tables unchanged', async () => {
    const agg = await seedAggregate({ title: 'Invalid transition' });
    await applyTransition(agg, 'attempt:started', 'k6a'); // now running
    const snap = await snapCounts(prisma, agg.taskId);
    const r = await svc.executeCommand(prisma, {
      kind: 'transition_attempt', taskId: agg.taskId, attemptId: agg.attemptId,
      expectedVersion: agg.version, eventType: 'attempt:started', // running → running
      idempotencyKey: 'k6', causationId: 'c', correlationId: 'c',
      evidenceRefs: [], payload: {}, committedResult: {},
    });
    expect(r).toBeInstanceOf(InvalidTransitionError);
    expect(await snapCounts(prisma, agg.taskId)).toEqual(snap);
  });

  it('7: unissued attempt → UnissuedAttemptError, all tables unchanged', async () => {
    const agg = await seedAggregate({ title: 'Unissued attempt' });
    await applyTransition(agg, 'attempt:started', 'k7a');
    const snap = await snapCounts(prisma, agg.taskId);
    const r = await svc.executeCommand(prisma, {
      kind: 'transition_attempt', taskId: agg.taskId,
      attemptId: randomUUID(), // never issued by Muneral
      expectedVersion: agg.version, eventType: 'attempt:failed',
      idempotencyKey: 'k7', causationId: 'c', correlationId: 'c',
      evidenceRefs: [], payload: {}, committedResult: {},
    });
    expect(r).toBeInstanceOf(UnissuedAttemptError);
    expect(await snapCounts(prisma, agg.taskId)).toEqual(snap);
  });

  // =====================================================================
  // Current-attempt FK negative
  // =====================================================================

  it('8: foreign current_attempt_id rejected by DEFERRABLE composite FK', async () => {
    // A task that exists in tasks but has NO execution state.
    const fkTaskId = await freshTask(prisma, 'FK Test');
    // The tasks FK passes (task exists), but the DEFERRABLE composite FK
    // (current_attempt_id, task_id) → task_execution_attempts MUST reject.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fkError: any;
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO public.task_execution_state (task_id, aggregate_version, current_attempt_id, retry_budget, retry_count, retry_backoff_ms)
         VALUES ($1::uuid, 1, $2::uuid, 3, 0, 100)`,
        fkTaskId,
        randomUUID(),
      );
      throw new Error('expected FK rejection but insert succeeded');
    } catch (e) {
      fkError = e;
    }
    // Must name the exact constraint
    expect(String(fkError.message)).toContain('task_execution_state_current_attempt_fkey');

    // Verify no execution-state row exists for the FK task
    const row = await prisma.taskExecutionState.findUnique({ where: { taskId: fkTaskId } });
    expect(row).toBeNull();
  });

  // =====================================================================
  // Retry lifecycle
  // =====================================================================

  it('9: fail → advance past backoff → retry succeeds', async () => {
    const agg = await seedAggregate({ title: 'Retry after backoff' });
    const firstAttempt = agg.attemptId;
    await applyTransition(agg, 'attempt:failed', 'k9a');
    tick(200); // past the 100ms backoff
    const s = await issueRetry(agg, 'k9b');
    expect(s.state.retryCount).toBe(1);
    expect(s.state.aggregateVersion).toBe(3);
    expect(s.state.currentAttemptId).toBeTruthy();
    expect(s.state.currentAttemptId).not.toBe(firstAttempt);
  });

  it('10: retry before backoff → RetryBackoffError, all tables unchanged', async () => {
    const agg = await seedAggregate({ title: 'Retry before backoff' });
    await applyTransition(agg, 'attempt:failed', 'k10a');
    const snap = await snapCounts(prisma, agg.taskId);
    // No tick — backoff not elapsed
    const r = await svc.executeCommand(prisma, {
      kind: 'issue_retry_attempt', taskId: agg.taskId, expectedVersion: agg.version,
      idempotencyKey: 'k10b', causationId: 'c', correlationId: 'c',
      evidenceRefs: [],
    });
    expect(r).toBeInstanceOf(RetryBackoffError);
    expect(await snapCounts(prisma, agg.taskId)).toEqual(snap);
  });

  // =====================================================================
  // Retry budget exhaustion
  // =====================================================================

  it('11: budget exhausted → RetryBudgetExhaustedError, all tables unchanged', async () => {
    const budget = 3;
    const agg = await seedAggregate({ title: 'Budget exhaustion', retryBudget: budget });
    await applyTransition(agg, 'attempt:failed', 'k11f-initial');
    for (let i = 0; i < budget; i++) {
      tick(100 * 2 ** (i + 1)); // clear the exponential backoff
      await issueRetry(agg, `k11r${i}`);
      await applyTransition(agg, 'attempt:failed', `k11f${i}`);
    }
    tick(60_000);

    const st = await prisma.taskExecutionState.findUnique({ where: { taskId: agg.taskId } });
    expect(st.retryCount).toBe(budget);
    const snap = await snapCounts(prisma, agg.taskId);

    const r = await svc.executeCommand(prisma, {
      kind: 'issue_retry_attempt', taskId: agg.taskId, expectedVersion: agg.version,
      idempotencyKey: 'k11final', causationId: 'c', correlationId: 'c',
      evidenceRefs: [],
    });
    expect(r).toBeInstanceOf(RetryBudgetExhaustedError);
    expect(await snapCounts(prisma, agg.taskId)).toEqual(snap);
  });

  // =====================================================================
  // Deep idempotent replay after state advancement
  // =====================================================================

  it('11b: deep-replay old key after many later transitions', async () => {
    const agg = await seedAggregate({ title: 'Deep replay' });
    const originalAttempt = agg.attemptId;

    // The command whose result must be reproduced verbatim later.
    const cmd = {
      kind: 'transition_attempt' as const, taskId: agg.taskId, attemptId: originalAttempt,
      expectedVersion: 1, eventType: 'attempt:started' as const,
      idempotencyKey: 'k2', causationId: 'c', correlationId: 'c',
      evidenceRefs: [] as never[], payload: {}, committedResult: {},
    };
    const original = must(await svc.executeCommand(prisma, cmd));
    agg.version = original.state.aggregateVersion;

    // Advance the aggregate well past that version.
    await applyTransition(agg, 'attempt:failed', 'k11b-fail');
    tick(500);
    await issueRetry(agg, 'k11b-retry');
    await applyTransition(agg, 'attempt:started', 'k11b-start2');

    const curState = await prisma.taskExecutionState.findUnique({ where: { taskId: agg.taskId } });
    expect(Number(curState.aggregateVersion)).toBeGreaterThan(4);
    const snap = await snapCounts(prisma, agg.taskId);

    const replay = must(await svc.executeCommand(prisma, cmd));

    // Full deep equality: committedResult, transition, and historical state
    // must match the stored original exactly.
    expect(replay).toEqual(original);
    expect(replay.state.aggregateVersion).toBe(2);

    // Live DB current version must still be higher (state advanced past v2)
    const curState2 = await prisma.taskExecutionState.findUnique({ where: { taskId: agg.taskId } });
    expect(Number(curState2.aggregateVersion)).toBeGreaterThan(2);

    // No new transition created — table counts unchanged
    expect(await snapCounts(prisma, agg.taskId)).toEqual(snap);
  });

  // =====================================================================
  // Concurrent same-expectedVersion race — exactly one wins
  // =====================================================================

  it('12: concurrent same-expectedVersion → exactly one succeeds', async () => {
    const agg = await seedAggregate({ title: 'Concurrency' });
    await applyTransition(agg, 'attempt:started', 'conc-i2');

    const raceVer = agg.version; // 2
    const snap = await snapCounts(prisma, agg.taskId);

    const cmd = {
      kind: 'transition_attempt' as const, taskId: agg.taskId, attemptId: agg.attemptId,
      expectedVersion: raceVer, eventType: 'attempt:failed' as const,
      causationId: 'c', correlationId: 'c',
      evidenceRefs: [] as never[], payload: {}, committedResult: {},
    };

    const url = process.env.MUN0020_DB_URL!;
    const p1 = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    const p2 = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

    try {
      // allSettled, not all: a raw rejection here (e.g. a Prisma P2028 pool /
      // transaction timeout under load) is an infrastructure failure, not a
      // violated concurrency invariant, and must be reported as such. With
      // Promise.all the two are indistinguishable in the failure output.
      const settled = await Promise.allSettled([
        svc.executeCommand(p1, { ...cmd, idempotencyKey: 'conc-a' }),
        svc.executeCommand(p2, { ...cmd, idempotencyKey: 'conc-b' }),
      ]);
      const rejected = settled.filter((s) => s.status === 'rejected');
      if (rejected.length > 0) {
        throw new Error(
          'concurrent executeCommand rejected instead of returning a typed outcome: ' +
          rejected
            .map((s) => String((s as PromiseRejectedResult).reason?.message ?? s))
            .join(' | '),
        );
      }
      const [r1, r2] = settled.map(
        (s) => (s as PromiseFulfilledResult<unknown>).value,
      );

      const err1 = r1 instanceof Error;
      const err2 = r2 instanceof Error;
      // Exactly one must succeed, the other must fail with StaleVersionError
      if (!err1 && err2) {
        expect(r2).toBeInstanceOf(StaleVersionError);
      } else if (err1 && !err2) {
        expect(r1).toBeInstanceOf(StaleVersionError);
      } else {
        throw new Error(
          `Concurrency invariant violated: r1=${r1 instanceof Error ? r1.constructor.name : 'OK'}, ` +
          `r2=${r2 instanceof Error ? r2.constructor.name : 'OK'}`,
        );
      }

      const after = await snapCounts(prisma, agg.taskId);
      // State and attempt counts unchanged; exactly one new transition
      expect(after.state).toBe(snap.state);
      expect(after.attempts).toBe(snap.attempts);
      expect(after.transitions).toBe(snap.transitions + 1);

      // Read aggregate — version must have advanced by exactly 1
      const cur2 = await prisma.taskExecutionState.findUnique({ where: { taskId: agg.taskId } });
      expect(Number(cur2.aggregateVersion)).toBe(raceVer + 1);
      // Attempt status must be 'failed' (the winning command's eventType)
      const att2 = await prisma.taskExecutionAttempt.findUnique({ where: { attemptId: agg.attemptId } });
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
    const rollbackTaskId = await freshTask(prisma, 'Rollback Test');
    const snap = await snapCounts(prisma, rollbackTaskId);
    expect(snap).toEqual({ state: 0, attempts: 0, transitions: 0 });

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
        kind: 'issue_initial_attempt', taskId: rollbackTaskId,
        expectedVersion: 0, idempotencyKey: 'rollback-k',
        causationId: 'c', correlationId: 'c',
        retryBudget: 3, retryBackoffMs: 100, evidenceRefs: [],
      });
      throw new Error('expected rollback did not happen');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    expect(await snapCounts(prisma, rollbackTaskId)).toEqual({ state: 0, attempts: 0, transitions: 0 });
  });

  // =====================================================================
  // Replay — byte-equivalent comparison with independent DB snapshot
  // =====================================================================

  it('14: replay decisionHash matches independently-constructed DB snapshot', async () => {
    // Build a history rich enough to exercise every reducer branch: initial
    // issuance, start, failure with backoff, retry issuance, start, success.
    const agg = await seedAggregate({ title: 'Replay decision hash' });
    await applyTransition(agg, 'attempt:started', 'r14-start');
    await applyTransition(agg, 'attempt:failed', 'r14-fail');
    tick(500);
    await issueRetry(agg, 'r14-retry');
    await applyTransition(agg, 'attempt:started', 'r14-start2');
    await applyTransition(agg, 'attempt:succeeded', 'r14-succeed');

    // Replay from journal facts only
    const rows = await prisma.taskExecutionTransition.findMany({
      where: { taskId: agg.taskId }, orderBy: { aggregateVersion: 'asc' },
    });
    expect(rows.length).toBe(6);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx = rows.map((t: any) => ({
      id: t.id, taskId: t.taskId, attemptId: t.attemptId,
      aggregateVersion: Number(t.aggregateVersion), eventType: t.eventType,
      idempotencyKey: t.idempotencyKey, commandDigest: t.commandDigest,
      transitionPayload: t.transitionPayload as Record<string, unknown>,
      committedResult: t.committedResult as Record<string, unknown>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      evidenceRefs: (t.evidenceRefs as any[]) ?? [],
      causationId: t.causationId, correlationId: t.correlationId,
      recordedAt: new Date(t.recordedAt),
    }));

    const { state: replayed, attempts: replayedAttempts } = replayJournal(tx);
    expect(replayed).not.toBeNull();

    // ---- Independently materialized snapshot from DB tables ----
    const dbSt = await prisma.taskExecutionState.findUnique({ where: { taskId: agg.taskId } });
    const dbAttempts = await prisma.taskExecutionAttempt.findMany({
      where: { taskId: agg.taskId }, orderBy: { ordinal: 'asc' },
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const independentAttempts = dbAttempts.map((a: any) => ({
      attemptId: a.attemptId,
      taskId: a.taskId,
      ordinal: a.ordinal,
      status: a.status,
      issuedAt: a.issuedAt,
      startedAt: a.startedAt,
      completedAt: a.completedAt,
    }));

    // A succeeded attempt clears the pointer — proves the comparison is not
    // trivially true for a single never-terminal attempt.
    expect(independentState.currentAttemptId).toBeNull();
    expect(independentAttempts.length).toBe(2);

    // Compare decisionHash(replayed) === decisionHash(independent)
    const replayHash = decisionHash(replayed, replayedAttempts);
    const independentHash = decisionHash(
      independentState as never,
      independentAttempts as never,
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

  // =====================================================================
  // 15 — QA finding F2: the SQL expected-version predicate must be the thing
  // that rejects a lost update, independently of the journal unique index.
  // =====================================================================

  it('15: the expected-version predicate on the state UPDATE rejects a lost update', async () => {
    // WHY THIS TEST EXISTS
    // Deleting `aggregateVersion: command.expectedVersion` from the state
    // updateMany where-clause left 148/149 tests green. Concurrency test 12
    // survives because both racers derive the same next version from the same
    // read, so the journal's UNIQUE (task_id, aggregate_version) catches the
    // loser and P2002 is remapped to StaleVersionError — the predicate is never
    // the thing under test.
    //
    // To isolate the predicate, the concurrent writer here moves the aggregate
    // to a version that leaves NO conflicting journal row for the command's
    // next version. The journal unique index therefore cannot fire, and only
    // the conditional UPDATE can reject the command.
    //
    // The concurrent writer is a raw state-row UPDATE on a second connection.
    // That is precisely what optimistic concurrency control has to defend
    // against: any other committed modification of the row between our read and
    // our write, not only ones this service issued.
    const agg = await seedAggregate({ title: 'Expected-version predicate' });
    await applyTransition(agg, 'attempt:started', 'f2-start');
    expect(agg.version).toBe(2); // journal holds versions 1 and 2 only

    const url = process.env.MUN0020_DB_URL!;
    const holder = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

    let releaseLock!: () => void;
    let signalLockTaken!: () => void;
    const lockHeld = new Promise<void>((resolve) => { releaseLock = resolve; });
    const lockTaken = new Promise<void>((resolve) => { signalLockTaken = resolve; });

    // Hold a row lock on the aggregate while rewriting its version to 7.
    const holderTx = holder.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE public.task_execution_state SET aggregate_version = 7 WHERE task_id = $1::uuid`,
        agg.taskId,
      );
      signalLockTaken();
      await lockHeld;
    }, { maxWait: 20_000, timeout: 60_000 });

    let result: unknown;
    try {
      await lockTaken; // the UPDATE has returned: the row lock is held

      // Command reads version 2 (the still-committed value), then blocks on the
      // conditional UPDATE.
      const pending = svc.executeCommand(prisma, {
        kind: 'transition_attempt', taskId: agg.taskId, attemptId: agg.attemptId,
        expectedVersion: 2, eventType: 'attempt:failed',
        idempotencyKey: 'f2-race', causationId: 'c', correlationId: 'c',
        evidenceRefs: [], payload: {}, committedResult: {},
      });

      // Wait until a backend is genuinely blocked on a lock. Without this the
      // command might reach the UPDATE only after the writer committed, in
      // which case the reducer would reject it and the predicate would go
      // untested — a false pass.
      await waitUntilBlockedOnLock(prisma);

      releaseLock();      // writer commits aggregate_version = 7
      await holderTx;
      result = await pending;
    } finally {
      releaseLock();
      await holder.$disconnect();
    }

    // With the predicate: updateMany matches 0 rows → StaleVersionError.
    // Without it: the UPDATE matches on task_id alone, overwrites version 7
    // with 3, and the journal insert at version 3 succeeds because versions
    // 1 and 2 are the only rows present — the command wrongly reports success.
    expect(result).toBeInstanceOf(StaleVersionError);
    expect((result as StaleVersionError).expectedVersion).toBe(2);
    expect((result as StaleVersionError).actualVersion).toBe(7);

    // The concurrent writer's value survived — no lost update.
    const st = await prisma.taskExecutionState.findUnique({ where: { taskId: agg.taskId } });
    expect(Number(st.aggregateVersion)).toBe(7);

    // And nothing was appended to the journal.
    const versions = (await prisma.taskExecutionTransition.findMany({
      where: { taskId: agg.taskId }, orderBy: { aggregateVersion: 'asc' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })).map((t: any) => Number(t.aggregateVersion));
    expect(versions).toEqual([1, 2]);
  }, 60_000);

  // =====================================================================
  // 16 — QA finding F4: a unique violation that cannot express a version race
  // must not be reported as a phantom StaleVersionError.
  // =====================================================================

  it('16: duplicate attempt UUID → UnexpectedUniqueViolationError, not a phantom stale version', async () => {
    // A faulty IdSource that hands the same attempt UUID to two different
    // tasks. The first call of each command produces the attempt id, the
    // second the transition id.
    const collidingAttemptId = randomUUID();
    let call = 0;
    const collidingIdSource: IdSource = {
      generate: () => (call++ % 2 === 0 ? collidingAttemptId : randomUUID()),
    };
    const collidingSvc = new ExecutionAuthorityService(clk, collidingIdSource);

    const firstTaskId = await freshTask(prisma, 'F4 first holder of the UUID');
    must(await collidingSvc.executeCommand(prisma, {
      kind: 'issue_initial_attempt', taskId: firstTaskId, expectedVersion: 0,
      idempotencyKey: 'f4-first', causationId: 'c', correlationId: 'c',
      retryBudget: 3, retryBackoffMs: 100, evidenceRefs: [],
    }));

    const secondTaskId = await freshTask(prisma, 'F4 duplicate attempt UUID');
    const before = await snapCounts(prisma, secondTaskId);

    // Previously: P2002 on task_execution_attempts_pkey was swallowed by the
    // blanket unique-violation catch, reconcile found no transition for the
    // key, and the caller received `StaleVersionError: ... expected 0, got 0` —
    // self-contradictory, and a caller obeying the documented "re-read and
    // re-issue" contract would retry forever.
    const attempt = collidingSvc.executeCommand(prisma, {
      kind: 'issue_initial_attempt', taskId: secondTaskId, expectedVersion: 0,
      idempotencyKey: 'f4-second', causationId: 'c', correlationId: 'c',
      retryBudget: 3, retryBackoffMs: 100, evidenceRefs: [],
    });

    await expect(attempt).rejects.toBeInstanceOf(UnexpectedUniqueViolationError);
    await attempt.catch((e: UnexpectedUniqueViolationError) => {
      expect(e.taskId).toBe(secondTaskId);
      expect(e.constraint).toBe('task_execution_attempts_pkey');
      expect(e.code).toBe('UNEXPECTED_UNIQUE_VIOLATION');
      // The point of the finding: this must NOT be a StaleVersionError, whose
      // documented remedy ("re-read and re-issue") would loop forever here.
      expect(e).not.toBeInstanceOf(StaleVersionError);
    });

    // Fail-closed: the rolled-back transaction left nothing behind.
    expect(await snapCounts(prisma, secondTaskId)).toEqual(before);
  });

  // =====================================================================
  // 17 — guards the F4 narrowing against over-reach: concurrent initial
  // issuance collides on task_execution_state_pkey, which IS a genuine
  // version race and must still reconcile into a typed domain error.
  // =====================================================================

  it('17: concurrent initial issuance still reconciles to a typed version conflict', async () => {
    const taskId = await freshTask(prisma, 'Concurrent initial issuance');
    const url = process.env.MUN0020_DB_URL!;
    const p1 = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    const p2 = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

    const cmd = {
      kind: 'issue_initial_attempt' as const, taskId, expectedVersion: 0,
      causationId: 'c', correlationId: 'c',
      retryBudget: 3, retryBackoffMs: 100, evidenceRefs: [] as never[],
    };

    try {
      const [r1, r2] = await Promise.all([
        svc.executeCommand(p1, { ...cmd, idempotencyKey: 'init-a' }),
        svc.executeCommand(p2, { ...cmd, idempotencyKey: 'init-b' }),
      ]);

      const errors = [r1, r2].filter((r) => r instanceof Error);
      const winners = [r1, r2].filter((r) => !(r instanceof Error));
      expect(winners.length).toBe(1);
      expect(errors.length).toBe(1);

      // The loser must get a domain error it can act on, NOT the fail-closed
      // UnexpectedUniqueViolationError introduced for finding F4.
      //
      // Which domain error it is depends on timing and both are correct:
      //   * loser reads state BEFORE the winner commits -> it proceeds, its
      //     state INSERT collides on task_execution_state_pkey, and the
      //     reconcile path returns StaleVersionError. This is the branch the
      //     F4 allow-list has to keep working.
      //   * loser reads state AFTER the winner commits -> the reducer rejects
      //     it up front with ExecutionStateAlreadyExistsError, never reaching
      //     the database.
      // Asserting only one of the two would make this test timing-dependent.
      expect(errors[0]).not.toBeInstanceOf(UnexpectedUniqueViolationError);
      expect(
        errors[0] instanceof StaleVersionError ||
          errors[0] instanceof ExecutionStateAlreadyExistsError,
      ).toBe(true);

      expect(await snapCounts(prisma, taskId)).toEqual({
        state: 1, attempts: 1, transitions: 1,
      });
    } finally {
      await p1.$disconnect();
      await p2.$disconnect();
    }
  }, 30_000);
});

/**
 * Block until some backend is waiting on a lock, proving the command under test
 * has reached its conditional UPDATE and is queued behind the barrier writer.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function waitUntilBlockedOnLock(p: any): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const rows = await p.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`,
    );
    if (Array.isArray(rows) && Number(rows[0]?.n) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(
    'timed out waiting for the command to block on the aggregate row lock; ' +
    'the barrier did not engage, so the expected-version predicate was not exercised',
  );
}
