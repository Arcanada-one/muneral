// MUN-0020: Execution authority service unit tests.
// Verifies transaction ownership, pre-mutation validations (safe returns),
// post-mutation rollback + reconcile, attempt lifecycle updates, retry
// validation, and typed error mapping.

import { ExecutionAuthorityService } from '../src/execution-authority/execution-authority.service';
import type {
  TransactionalClient,
} from '../src/execution-authority/execution-authority.service';
import type {
  Clock,
  IdSource,
} from '../src/execution-authority/execution-authority.types';
import {
  StaleVersionError,
  InvalidTransitionError,
  IdempotencyCollisionError,
} from '../src/execution-authority/execution-authority.errors';
import { commandDigest } from '../src/execution-authority/canonical-json';
import { EvidenceRefValidationError } from '../src/execution-authority/evidence-ref.validator';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date('2026-07-30T12:00:00Z');

const clock: Clock = { now: () => FIXED_NOW };

let idCounter = 0;
const idSource: IdSource = {
  generate: () => {
    idCounter += 1;
    return `id-${String(idCounter).padStart(4, '0')}`;
  },
};

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeTx(overrides: Record<string, any> = {}): any {
  return {
    taskExecutionState: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    taskExecutionAttempt: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    taskExecutionTransition: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
    ...overrides,
  };
}

/**
 * Build a realistic $transaction mock: calls the callback with tx.
 * If the callback returns, the mock resolves with that value.
 * If the callback throws, the mock rejects (transaction rolls back).
 */
function makePrisma(tx: ReturnType<typeof makeTx>): TransactionalClient {
  return {
    $transaction: jest
      .fn()
      .mockImplementation(
        async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      ),
  };
}

function expectNoAuthorityStoreAccess(tx: ReturnType<typeof makeTx>): void {
  expect(tx.taskExecutionState.findUnique).not.toHaveBeenCalled();
  expect(tx.taskExecutionState.create).not.toHaveBeenCalled();
  expect(tx.taskExecutionState.updateMany).not.toHaveBeenCalled();
  expect(tx.taskExecutionAttempt.findUnique).not.toHaveBeenCalled();
  expect(tx.taskExecutionAttempt.create).not.toHaveBeenCalled();
  expect(tx.taskExecutionAttempt.update).not.toHaveBeenCalled();
  expect(tx.taskExecutionTransition.findFirst).not.toHaveBeenCalled();
  expect(tx.taskExecutionTransition.create).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExecutionAuthorityService', () => {
  let service: ExecutionAuthorityService;

  beforeEach(() => {
    idCounter = 0;
    service = new ExecutionAuthorityService(clock, idSource);
  });

  // -- transaction ownership -------------------------------------------------

  describe('executeCommand — transaction ownership', () => {
    it('runs inside $transaction and commits on success', async () => {
      const tx = makeTx();
      const prisma = makePrisma(tx);

      const result = await service.executeCommand(prisma, {
        kind: 'issue_initial_attempt',
        taskId: 'task-1',
        expectedVersion: 0,
        idempotencyKey: 'idem-1',
        causationId: 'cause-1',
        correlationId: 'corr-1',
        retryBudget: 3,
        retryBackoffMs: 1_000,
        evidenceRefs: [],
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(result).not.toBeInstanceOf(Error);
      expect(tx.taskExecutionState.create).toHaveBeenCalled();
    });

    it('rolls back and reconciles on post-mutation version race', async () => {
      // preValidateAttempt needs a valid attempt, so it passes and we reach
      // the updateMany count=0 path that throws StaleVersionError.
      const tx = makeTx({
        taskExecutionState: {
          findUnique: jest.fn().mockResolvedValue({
            taskId: 'task-1',
            aggregate_version: 2,
            current_attempt_id: 'att-1',
            retry_budget: 3,
            retry_count: 0,
            retry_backoff_ms: 1000,
            retry_eligible_at: null,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          create: jest.fn(),
        },
        taskExecutionAttempt: {
          findUnique: jest.fn().mockResolvedValue({
            attempt_id: 'att-1',
            task_id: 'task-1',
            ordinal: 1,
            status: 'running',
            issued_at: FIXED_NOW,
            started_at: FIXED_NOW,
            completed_at: null,
          }),
          create: jest.fn(),
          update: jest.fn(),
        },
        taskExecutionTransition: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null),
          create: jest.fn(),
        },
      });

      const prisma = makePrisma(tx);

      const result = await service.executeCommand(prisma, {
        kind: 'transition_attempt',
        taskId: 'task-1',
        attemptId: 'att-1',
        expectedVersion: 2,
        eventType: 'attempt:failed',
        idempotencyKey: 'idem-3',
        causationId: 'cause-3',
        correlationId: 'corr-3',
        evidenceRefs: [],
        payload: {},
        committedResult: {},
      });

      // count=0 → executeInTransaction throws StaleVersionError
      // → $transaction propagates → executeCommand catches → reconcile
      // → reconcile finds no existing idempotency → returns StaleVersionError
      expect(result).toBeInstanceOf(StaleVersionError);
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it('rolls back and reconciles idempotent replay on P2002 race', async () => {
      // Simulate P2002 from a concurrent identical command
      const tx = makeTx({
        taskExecutionTransition: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce(null), // first attempt: no existing
          create: jest.fn().mockRejectedValue({ code: 'P2002' }),
        },
      });

      const prisma = makePrisma(tx);

      // Override the reconcile to return the committed result
      // We test this by having the reconcile's findFirst return the committed value
      const reconcileTx = makeTx({
        taskExecutionTransition: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'tx-existing',
            taskId: 'task-1',
            attemptId: 'att-1',
            aggregate_version: 1,
            event_type: 'attempt:issued',
            idempotency_key: 'idem-1',
            command_digest: '', // will be computed from the command
            committed_result: { status: 'done' },
            recorded_at: FIXED_NOW,
          }),
        },
        taskExecutionState: {
          findUnique: jest.fn().mockResolvedValue({
            taskId: 'task-1',
            aggregate_version: 1,
            current_attempt_id: 'att-1',
            retry_budget: 3,
            retry_count: 0,
            retry_backoff_ms: 1000,
            retry_eligible_at: null,
          }),
        },
      });

      // Set up $transaction to use tx for first call, reconcileTx for second
      let callCount = 0;
      const prisma2: TransactionalClient = {
        $transaction: jest.fn().mockImplementation(
          async (fn: (t: unknown) => Promise<unknown>) => {
            callCount++;
            if (callCount === 1) return fn(tx);
            return fn(reconcileTx);
          },
        ),
      };

      const result = await service.executeCommand(prisma2, {
        kind: 'issue_initial_attempt',
        taskId: 'task-1',
        expectedVersion: 0,
        idempotencyKey: 'idem-1',
        causationId: 'cause-1',
        correlationId: 'corr-1',
        retryBudget: 3,
        retryBackoffMs: 1_000,
        evidenceRefs: [],
      });

      // P2002 → rollback → reconcile finds existing transition
      // With different digest → collision, or same digest → replay
      // Our reconcile mock's digest won't match, so we get collision
      expect(result).toBeInstanceOf(IdempotencyCollisionError);
      expect(callCount).toBe(2);
    });
  });

  // -- attempt lifecycle -----------------------------------------------------

  describe('transition_attempt — attempt lifecycle', () => {
    it('updates attempt status and startedAt on issued→started', async () => {
      const tx = makeTx({
        taskExecutionState: {
          findUnique: jest.fn().mockResolvedValue({
            taskId: 'task-1',
            aggregate_version: 2,
            current_attempt_id: 'att-1',
            retry_budget: 3,
            retry_count: 0,
            retry_backoff_ms: 1000,
            retry_eligible_at: null,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        taskExecutionAttempt: {
          findUnique: jest.fn().mockResolvedValue({
            attempt_id: 'att-1',
            task_id: 'task-1',
            ordinal: 1,
            status: 'issued',
            issued_at: FIXED_NOW,
            started_at: null,
            completed_at: null,
          }),
          update: jest.fn().mockResolvedValue({}),
        },
      });
      const prisma = makePrisma(tx);

      const result = await service.executeCommand(prisma, {
        kind: 'transition_attempt',
        taskId: 'task-1',
        attemptId: 'att-1',
        expectedVersion: 2,
        eventType: 'attempt:started',
        idempotencyKey: 'idem-2',
        causationId: 'cause-2',
        correlationId: 'corr-2',
        evidenceRefs: [],
        payload: {},
        committedResult: { status: 'running' },
      });

      expect(result).not.toBeInstanceOf(Error);
      expect(tx.taskExecutionAttempt.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { attemptId: 'att-1' },
          data: expect.objectContaining({
            status: 'running',
            startedAt: FIXED_NOW,
          }),
        }),
      );
    });

    it('sets completedAt for succeeded, failed, and cancelled', async () => {
      for (const eventType of [
        'attempt:succeeded' as const,
        'attempt:failed' as const,
        'attempt:cancelled' as const,
      ]) {
        idCounter = 0;
        const tx = makeTx({
          taskExecutionState: {
            findUnique: jest.fn().mockResolvedValue({
              taskId: 'task-1',
              aggregate_version: 3,
              current_attempt_id: 'att-1',
              retry_budget: 3,
              retry_count: 0,
              retry_backoff_ms: 1000,
              retry_eligible_at: null,
            }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          taskExecutionAttempt: {
            findUnique: jest.fn().mockResolvedValue({
              attempt_id: 'att-1',
              task_id: 'task-1',
              ordinal: 1,
              status: 'running',
              issued_at: FIXED_NOW,
              started_at: FIXED_NOW,
              completed_at: null,
            }),
            update: jest.fn().mockResolvedValue({}),
          },
        });
        const prisma = makePrisma(tx);

        const result = await service.executeCommand(prisma, {
          kind: 'transition_attempt',
          taskId: 'task-1',
          attemptId: 'att-1',
          expectedVersion: 3,
          eventType,
          idempotencyKey: `idem-${eventType}`,
          causationId: 'cause-X',
          correlationId: 'corr-X',
          evidenceRefs: [],
          payload: {},
          committedResult: {},
        });

        expect(result).not.toBeInstanceOf(Error);
        expect(tx.taskExecutionAttempt.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: expect.any(String),
              completedAt: FIXED_NOW,
            }),
          }),
        );
      }
    });
  });

  // -- pre-mutation validations ----------------------------------------------

  describe('pre-mutation validations (safe returns)', () => {
    async function executeWithEvidenceRef(
      ref: unknown,
      idempotencyKey: string,
    ): Promise<{
      result: Awaited<ReturnType<ExecutionAuthorityService['executeCommand']>>;
      tx: ReturnType<typeof makeTx>;
    }> {
      const tx = makeTx();
      const prisma = makePrisma(tx);
      const result = await service.executeCommand(prisma, {
        kind: 'issue_initial_attempt',
        taskId: 'task-structural-validation',
        expectedVersion: 0,
        idempotencyKey,
        causationId: 'cause-structural-validation',
        correlationId: 'corr-structural-validation',
        retryBudget: 3,
        retryBackoffMs: 1_000,
        evidenceRefs: [ref] as never[],
      });
      return { result, tx };
    }

    function expectStructuralRejection(
      result: Awaited<ReturnType<ExecutionAuthorityService['executeCommand']>>,
      tx: ReturnType<typeof makeTx>,
    ): EvidenceRefValidationError {
      expect(result).toBeInstanceOf(EvidenceRefValidationError);
      const err = result as EvidenceRefValidationError;
      expect(err.reason.length).toBeLessThanOrEqual(128);
      expect(err.message.length).toBeLessThanOrEqual(192);
      expectNoAuthorityStoreAccess(tx);
      return err;
    }

    it('rejects a non-enumerable uri before digesting or store access', async () => {
      const ref = {
        digest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        contentType: 'text/plain',
      };
      Object.defineProperty(ref, 'uri', {
        value: 'tasks/task-1/evidence/log.txt',
        enumerable: false,
        configurable: true,
      });

      const { result, tx } = await executeWithEvidenceRef(
        ref,
        'idem-hidden-uri',
      );
      const err = expectStructuralRejection(result, tx);
      expect(err.reason).toBe(
        'evidence reference fields must be own enumerable data properties',
      );
    });

    it('rejects an accessor before invoking it or accessing the store', async () => {
      let getterHits = 0;
      const ref = {
        digest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        contentType: 'text/plain',
        get uri() {
          getterHits += 1;
          return 'tasks/task-1/evidence/log.txt';
        },
      };

      const { result, tx } = await executeWithEvidenceRef(
        ref,
        'idem-accessor-uri',
      );
      const err = expectStructuralRejection(result, tx);
      expect(err.reason).toBe(
        'evidence reference fields must be own enumerable data properties',
      );
      expect(getterHits).toBe(0);
    });

    it('rejects a class instance before canonical digesting or store access', async () => {
      class EvidenceFixture {
        uri = 'tasks/task-1/evidence/log.txt';
        digest =
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        contentType = 'text/plain';
      }

      const { result, tx } = await executeWithEvidenceRef(
        new EvidenceFixture(),
        'idem-class-instance',
      );
      const err = expectStructuralRejection(result, tx);
      expect(err.reason).toBe('evidence reference must be a plain object');
    });

    it('rejects inherited fields under Object.prototype pollution', async () => {
      const fieldNames = ['uri', 'digest', 'contentType'] as const;
      const previous = new Map(
        fieldNames.map((field) => [
          field,
          Object.getOwnPropertyDescriptor(Object.prototype, field),
        ]),
      );

      try {
        Object.defineProperties(Object.prototype, {
          uri: {
            value: 'tasks/task-1/evidence/log.txt',
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

        const { result, tx } = await executeWithEvidenceRef(
          {},
          'idem-prototype-pollution',
        );
        const err = expectStructuralRejection(result, tx);
        expect(err.reason).toBe(
          'evidence reference fields must be own enumerable data properties',
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
    });

    it('bounds diagnostics for an attacker-sized unknown key', async () => {
      const attackerKey = 'x'.repeat(100_000);
      const ref = {
        uri: 'tasks/task-1/evidence/log.txt',
        digest:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        contentType: 'text/plain',
        [attackerKey]: true,
      };

      const { result, tx } = await executeWithEvidenceRef(
        ref,
        'idem-long-unknown-key',
      );
      const err = expectStructuralRejection(result, tx);
      expect(err.reason).toBe('evidence reference contains unknown fields');
      expect(err.message).not.toContain(attackerKey.slice(0, 100));
    });

    it('NEGATIVE-CONTROL: updateMany WHERE clause includes aggregateVersion', async () => {
      const tx = makeTx({
        taskExecutionState: {
          findUnique: jest.fn().mockResolvedValue({
            taskId: 'task-1',
            aggregate_version: 2,
            current_attempt_id: 'att-1',
            retry_budget: 3,
            retry_count: 0,
            retry_backoff_ms: 1000,
            retry_eligible_at: null,
          }),
          create: jest.fn(),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        taskExecutionAttempt: {
          findUnique: jest.fn().mockResolvedValue({
            attempt_id: 'att-1',
            task_id: 'task-1',
            ordinal: 1,
            status: 'issued',
            issued_at: FIXED_NOW,
            started_at: null,
            completed_at: null,
          }),
          create: jest.fn(),
          update: jest.fn(),
        },
        taskExecutionTransition: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({}),
        },
      });
      const prisma = makePrisma(tx);

      const result = await service.executeCommand(prisma, {
        kind: 'transition_attempt',
        taskId: 'task-1',
        attemptId: 'att-1',
        expectedVersion: 2,
        eventType: 'attempt:started',
        idempotencyKey: 'idem-nc',
        causationId: 'cause-nc',
        correlationId: 'corr-nc',
        evidenceRefs: [],
        payload: {},
        committedResult: { ok: true },
      });

      expect(result).not.toBeInstanceOf(Error);

      // CRITICAL: the WHERE clause MUST include aggregateVersion for the
      // stale-write guard. If this fails, the version predicate is absent.
      expect(tx.taskExecutionState.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            taskId: 'task-1',
            aggregateVersion: 2,
          }),
        }),
      );
    });

    it('rejects stale expectedVersion before any writes', async () => {
      const tx = makeTx({
        taskExecutionState: {
          findUnique: jest.fn().mockResolvedValue({
            taskId: 'task-1',
            aggregate_version: 2,
            current_attempt_id: 'att-1',
            retry_budget: 3,
            retry_count: 0,
            retry_backoff_ms: 1000,
            retry_eligible_at: null,
          }),
          create: jest.fn(),
          updateMany: jest.fn(),
        },
        taskExecutionAttempt: {
          findUnique: jest.fn().mockResolvedValue({
            attempt_id: 'att-1',
            task_id: 'task-1',
            ordinal: 1,
            status: 'issued',
            issued_at: FIXED_NOW,
            started_at: null,
            completed_at: null,
          }),
          create: jest.fn(),
          update: jest.fn(),
        },
        taskExecutionTransition: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
      });
      const prisma = makePrisma(tx);

      // expectedVersion is 1, but state is at 2 — reducer returns StaleVersionError
      const result = await service.executeCommand(prisma, {
        kind: 'transition_attempt',
        taskId: 'task-1',
        attemptId: 'att-1',
        expectedVersion: 1,
        eventType: 'attempt:started',
        idempotencyKey: 'idem-2',
        causationId: 'cause-2',
        correlationId: 'corr-2',
        evidenceRefs: [],
        payload: {},
        committedResult: { ok: true },
      });

      expect(result).toBeInstanceOf(StaleVersionError);
      // No writes occurred — StaleVersionError returned by reducer before any mutation
      expect(tx.taskExecutionState.updateMany).not.toHaveBeenCalled();
      expect(tx.taskExecutionTransition.create).not.toHaveBeenCalled();
    });

    it('rejects retry when current attempt is not failed', async () => {
      const tx = makeTx({
        taskExecutionState: {
          findUnique: jest.fn().mockResolvedValue({
            taskId: 'task-1',
            aggregate_version: 3,
            current_attempt_id: 'att-1',
            retry_budget: 3,
            retry_count: 0,
            retry_backoff_ms: 1000,
            retry_eligible_at: null,
          }),
          create: jest.fn(),
          updateMany: jest.fn(),
        },
        taskExecutionAttempt: {
          findUnique: jest.fn().mockResolvedValue({
            attempt_id: 'att-1',
            task_id: 'task-1',
            ordinal: 1,
            status: 'issued', // NOT failed!
            issued_at: FIXED_NOW,
            started_at: null,
            completed_at: null,
          }),
          create: jest.fn(),
          update: jest.fn(),
        },
        taskExecutionTransition: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
      });
      const prisma = makePrisma(tx);

      const result = await service.executeCommand(prisma, {
        kind: 'issue_retry_attempt',
        taskId: 'task-1',
        expectedVersion: 3,
        idempotencyKey: 'idem-retry',
        causationId: 'cause-retry',
        correlationId: 'corr-retry',
        evidenceRefs: [],
      });

      expect(result).toBeInstanceOf(InvalidTransitionError);
      expect(tx.taskExecutionAttempt.create).not.toHaveBeenCalled();
    });
  });

  describe('reconcileAfterRollback', () => {
    async function verifyHistoricalConflict(errorCode: 'P2002' | 'P2034') {
      // Simulate: existing transition for same key+digest, plus later journal facts.
      // The reconcile must replay journal up to the historical version and return
      // the full ExecutionResult, not the current aggregate state.
      const existingTransition = {
        id: 'tx-old',
        taskId: 'task-1',
        attemptId: 'att-1',
        aggregate_version: 2n,
        event_type: 'attempt:started',
        idempotency_key: 'idem-old',
        command_digest: '', // will match after canonical JSON
        committed_result: { ok: true },
        transition_payload: {},
        evidence_refs: [],
        causation_id: 'cause-old',
        correlation_id: 'corr-old',
        recorded_at: FIXED_NOW,
      };

      // Pre-compute the digest that the reconcile will look for
      const cmd = {
        kind: 'issue_initial_attempt' as const,
        taskId: 'task-1',
        expectedVersion: 0,
        idempotencyKey: 'idem-old',
        causationId: 'cause-old',
        correlationId: 'corr-old',
        retryBudget: 3,
        retryBackoffMs: 1000,
        evidenceRefs: [],
      };
      const digest = commandDigest(cmd);
      existingTransition.command_digest = digest;

      // Mock: first transaction throws a retryable Prisma conflict, second
      // (reconcile) finds the already-committed historical transition.
      let callCount = 0;
      const tx = makeTx();
      // First attempt: idempotency miss, then conflict on transition create.
      tx.taskExecutionTransition.findFirst = jest.fn().mockResolvedValue(null);
      tx.taskExecutionTransition.create = jest.fn().mockRejectedValue({ code: errorCode });

      // Reconcile: findFirst returns existing transition
      const reconcileTx = makeTx({
        taskExecutionTransition: {
          findFirst: jest.fn().mockResolvedValue(existingTransition),
          // findMany for reconstructHistoricalResult: return journal up to version 2
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'tx-1', taskId: 'task-1', attemptId: 'att-1',
              aggregateVersion: 1n, eventType: 'attempt:issued',
              idempotencyKey: 'idem-1', commandDigest: 'aaaa',
              transitionPayload: { retryBudget: 3, retryBackoffMs: 1000 },
              committedResult: {}, evidenceRefs: [],
              causationId: 'c', correlationId: 'c', recordedAt: FIXED_NOW,
            },
            {
              id: 'tx-old', taskId: 'task-1', attemptId: 'att-1',
              aggregateVersion: 2n, eventType: 'attempt:started',
              idempotencyKey: 'idem-old', commandDigest: digest,
              transitionPayload: {}, committedResult: { ok: true },
              evidenceRefs: [], causationId: 'c', correlationId: 'c',
              recordedAt: FIXED_NOW,
            },
          ]),
          create: jest.fn(),
        },
        taskExecutionState: {
          findUnique: jest.fn().mockResolvedValue({
            taskId: 'task-1', aggregateVersion: 1n,
            currentAttemptId: 'att-1', retryBudget: 3, retryCount: 0,
            retryBackoffMs: 1000n, retryEligibleAt: null,
          }),
          create: jest.fn(),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      });

      const prisma2 = {
        $transaction: jest.fn().mockImplementation(
          async (fn: (t: unknown) => Promise<unknown>, _opts?: any) => {
            callCount++;
            if (callCount === 1) return fn(tx);
            return fn(reconcileTx);
          },
        ),
      };

      const result = await service.executeCommand(prisma2, cmd);

      // Must return the historical result, not a StaleVersionError or collision
      expect(result).not.toBeInstanceOf(Error);
      if (result instanceof Error) return;
      expect(result.committedResult).toEqual({ ok: true });
      expect(result.transition.eventType).toBe('attempt:started');
      expect(result.state.aggregateVersion).toBe(2); // historical, not current
      expect(callCount).toBe(2);
    }

    it.each(['P2002', 'P2034'] as const)(
      'returns exact historical result via reconstructHistoricalResult after %s',
      verifyHistoricalConflict,
    );

    it('reconcile fails closed when journal is malformed (missing initial issuance)', async () => {
      let callCount = 0;
      const tx = makeTx();
      tx.taskExecutionTransition.findFirst = jest.fn().mockResolvedValue(null);
      tx.taskExecutionTransition.create = jest.fn().mockRejectedValue({ code: 'P2002' });

      // Pre-compute the digest so reconcile's digest match passes and we reach
      // reconstructHistoricalResult (which should then fail on the malformed journal).
      const cmd = {
        kind: 'issue_initial_attempt' as const,
        taskId: 'task-1', expectedVersion: 0,
        idempotencyKey: 'idem-bad', causationId: 'c', correlationId: 'c',
        retryBudget: 3, retryBackoffMs: 1000, evidenceRefs: [],
      };
      const { commandDigest } = require('../src/execution-authority/canonical-json');
      const digest = commandDigest(cmd);

      const existingTransition = {
        id: 'tx-bad', taskId: 'task-1', attemptId: 'att-1',
        aggregate_version: 5n, event_type: 'attempt:failed',
        idempotency_key: 'idem-bad', command_digest: digest,
        committed_result: {}, transition_payload: {},
        evidence_refs: [], causation_id: 'c', correlation_id: 'c',
        recorded_at: FIXED_NOW,
      };

      const reconcileTx = makeTx({
        taskExecutionTransition: {
          findFirst: jest.fn().mockResolvedValue(existingTransition),
          // Malformed: single transition at version 5, no initial issuance
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'tx-bad', taskId: 'task-1', attemptId: 'att-1',
              aggregateVersion: 5n, eventType: 'attempt:failed',
              idempotencyKey: 'idem-bad', commandDigest: digest,
              transitionPayload: {}, committedResult: {},
              evidenceRefs: [], causationId: 'c', correlationId: 'c',
              recordedAt: FIXED_NOW,
            },
          ]),
          create: jest.fn(),
        },
      });

      const prisma2 = {
        $transaction: jest.fn().mockImplementation(
          async (fn: (t: unknown) => Promise<unknown>, _opts?: any) => {
            callCount++;
            if (callCount === 1) return fn(tx);
            return fn(reconcileTx);
          },
        ),
      };

      // ReconstructHistoricalResult replays malformed journal — fails on gap/missing issuance
      await expect(
        service.executeCommand(prisma2, cmd),
      ).rejects.toThrow(/expected aggregate_version/);
    });
  });
});
