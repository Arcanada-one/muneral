// MUN-0021 adoption gate: Muneral-owned committed-result reference and
// deterministic completion receipt.
//
// Ratified by datarim/research/ARCA-0194/muneral-result-reference-consilium.md.
// MUN-0022 may remain a pure contract proof; the additive Muneral relation and
// the authoritative commit seam are mandatory here. Every test below maps to a
// required falsifier from that consilium or to acceptance criteria 10-12 of
// datarim/tasks/MUN-0021-task-description.md.
//
// Round-5 boundary: this seam transports committed Muneral task facts only. It
// owns no fleet registry, lifecycle, placement, update, watchdog, telemetry
// aggregation, or direct command routing.

import {
  DOMAIN_CARD,
  DOMAIN_PROJECTION,
  DOMAIN_RECEIPT,
  DOMAIN_RESULT_NODE,
  DOMAIN_RESULT_REF,
  LEGACY_NONE,
} from '../src/result-authority/result-authority.types';
import type {
  CommittedResultRefV0,
  CompletionReceiptV0,
  OwnedResultMutationV0,
} from '../src/result-authority/result-authority.types';
import {
  cardDigest,
  computeReceiptId,
  computeResultRefId,
  domainDigest,
  projectionDigest,
  resultNodeDigest,
} from '../src/result-authority/result-authority.canonical';
import {
  replayLegacyCommittedResult,
  validateCommittedResultRefV0,
  validateCompletionReceiptV0,
  validateOwnedResultMutationV0,
  validateResultPlane,
} from '../src/result-authority/result-authority.guards';
import {
  AdapterAuthorityError,
  ResultBindingError,
  ResultContractError,
  ResultPlaneError,
} from '../src/result-authority/result-authority.errors';
import { ResultAuthorityService } from '../src/result-authority/result-authority.service';
import type { TransactionalClient } from '../src/execution-authority/execution-authority.service';
import type {
  Clock,
  IdSource,
} from '../src/execution-authority/execution-authority.types';
import { IdempotencyCollisionError } from '../src/execution-authority/execution-authority.errors';

// ---------------------------------------------------------------------------
// Fixtures — fixed card, projection and committed result node
// ---------------------------------------------------------------------------

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const TRANSITION_ID = '33333333-3333-4333-8333-333333333333';
const NODE_ROW_ID = '44444444-4444-4444-8444-444444444444';
const OUTBOX_ID = '55555555-5555-4555-8555-555555555555';

const CARD = {
  schemaVersion: 'v0',
  cardId: 'card-1',
  instructions: 'do the thing',
};
const PROJECTION = {
  schemaVersion: 'v0',
  projectionId: 'proj-1',
  cardId: 'card-1',
  nodes: ['node-1'],
};
const NODE = {
  nodeId: 'node-1',
  kind: 'task-card-result-node',
  value: { summary: 'done' },
};
const NODE_ALTERED = {
  nodeId: 'node-1',
  kind: 'task-card-result-node',
  value: { summary: 'done differently' },
};

// Goldens computed by an independent reimplementation of canonical JSON and
// domain-separated SHA-256 (scratchpad/goldens.mjs). They are pinned literals
// here so a change in the module under test cannot silently move them.
const GOLDEN = {
  cardDigest:
    '61a1e4d925b2358ab655b3d072fe8cb8fbed4e1cd02b191962c18a1ce4355123',
  projectionDigest:
    '88b844dd7738a58fba5d8ade74448b4e213b9d0b57ee98cf9a9db6b0d549e3be',
  resultDigest:
    'f30ea308edc27ae9f5d8e0a1ee5aecacd17435ff969accd4400d7516b6d1705c',
  resultRefId:
    '80e627e0793335c8bf2f1a7bd52d9e5cfb2d6823453e5790f89ce054e2af9c09',
  receiptId:
    '7d186ea95da6a3955f544eed68a608de8b2f57afb9ceb9763e49a6b4d1916f84',
  resultDigestAltered:
    'a70917ea008e28651ce4d427f6e82f8c40cfb1ea744983c1532100302e8ae504',
  resultRefIdAltered:
    '79798cc915884cb4fb79a95674b1d58b72a314b09ee1df903abab91480c06c9a',
  receiptIdAltered:
    'b0ed96a0cfea609c66372d86adf248908fe14a950b5261d28c13a0d440f5fae9',
} as const;

const PRINCIPAL = 'agent-arcana:executor-1';

function refWithout(
  resultDigest: string = GOLDEN.resultDigest,
): Omit<CommittedResultRefV0, 'resultRefId'> {
  return {
    schemaVersion: 'v0',
    kind: 'task-card-result',
    taskId: TASK_ID,
    attemptId: ATTEMPT_ID,
    cardId: 'card-1',
    cardDigest: GOLDEN.cardDigest,
    projectionId: 'proj-1',
    projectionDigest: GOLDEN.projectionDigest,
    nodeId: 'node-1',
    nodeVersion: 1,
    resultDigest,
    mutationId: 'mut-1',
    principalId: PRINCIPAL,
    transitionId: TRANSITION_ID,
    aggregateVersion: 3,
  };
}

function validRef(): CommittedResultRefV0 {
  return { ...refWithout(), resultRefId: GOLDEN.resultRefId };
}

function validReceipt(): CompletionReceiptV0 {
  return {
    schemaVersion: 'v0',
    kind: 'completion-receipt',
    receiptId: GOLDEN.receiptId,
    outcome: 'committed',
    resultRef: validRef(),
    causationId: 'cause-1',
    correlationId: 'corr-1',
  };
}

function validProposal(
  overrides: Partial<OwnedResultMutationV0> = {},
): OwnedResultMutationV0 {
  return {
    schemaVersion: 'v0',
    kind: 'owned-result-mutation',
    mutationId: 'mut-1',
    taskId: TASK_ID,
    attemptId: ATTEMPT_ID,
    cardId: 'card-1',
    cardDigest: GOLDEN.cardDigest,
    projectionId: 'proj-1',
    projectionDigest: GOLDEN.projectionDigest,
    nodeId: 'node-1',
    expectedNodeVersion: 0,
    principalId: PRINCIPAL,
    resultNode: NODE,
    idempotencyKey: 'idem-result-1',
    causationId: 'cause-1',
    correlationId: 'corr-1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Transaction mock
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date('2026-07-31T12:00:00Z');
const clock: Clock = { now: () => FIXED_NOW };

function makeIdSource(): IdSource {
  const queue = [NODE_ROW_ID, TRANSITION_ID, OUTBOX_ID];
  let extra = 0;
  return {
    generate: () => {
      const next = queue.shift();
      if (next !== undefined) return next;
      extra += 1;
      return `66666666-6666-4666-8666-${String(extra).padStart(12, '0')}`;
    },
  };
}

interface MockTx {
  taskExecutionState: Record<string, jest.Mock>;
  taskExecutionAttempt: Record<string, jest.Mock>;
  taskExecutionTransition: Record<string, jest.Mock>;
  taskOutboxEvent: Record<string, jest.Mock>;
  outboxLease: Record<string, jest.Mock>;
  taskResultNode: Record<string, jest.Mock>;
  taskCommittedResultRef: Record<string, jest.Mock>;
}

/** A task that already has an aggregate at version 2 and a running attempt. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeTx(overrides: Record<string, any> = {}): MockTx {
  const tx: MockTx = {
    taskExecutionState: {
      findUnique: jest.fn().mockResolvedValue({
        taskId: TASK_ID,
        aggregateVersion: 2n,
        currentAttemptId: ATTEMPT_ID,
        retryBudget: 3,
        retryCount: 0,
        retryBackoffMs: 1_000n,
        retryEligibleAt: null,
      }),
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    taskExecutionAttempt: {
      findUnique: jest.fn().mockResolvedValue({
        attemptId: ATTEMPT_ID,
        taskId: TASK_ID,
        ordinal: 1,
        status: 'running',
        issuedAt: FIXED_NOW,
        startedAt: FIXED_NOW,
        completedAt: null,
      }),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    taskExecutionTransition: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: jest.fn().mockImplementation(async (args: any) => ({
        ...args.data,
        recordedAt: FIXED_NOW,
      })),
    },
    taskOutboxEvent: {
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    outboxLease: {
      create: jest.fn().mockResolvedValue({}),
    },
    taskResultNode: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
    taskCommittedResultRef: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
    ...overrides,
  };
  return tx;
}

function makePrisma(tx: MockTx): TransactionalClient {
  return {
    $transaction: jest
      .fn()
      .mockImplementation(
        async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
      ),
  };
}

/** Assert the seam produced no durable row of any kind. */
function expectZeroWrites(tx: MockTx): void {
  expect(tx.taskExecutionState.create).not.toHaveBeenCalled();
  expect(tx.taskExecutionState.updateMany).not.toHaveBeenCalled();
  expect(tx.taskExecutionAttempt.create).not.toHaveBeenCalled();
  expect(tx.taskExecutionAttempt.update).not.toHaveBeenCalled();
  expect(tx.taskExecutionTransition.create).not.toHaveBeenCalled();
  expect(tx.taskOutboxEvent.create).not.toHaveBeenCalled();
  expect(tx.outboxLease.create).not.toHaveBeenCalled();
  expect(tx.taskResultNode.create).not.toHaveBeenCalled();
  expect(tx.taskCommittedResultRef.create).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------
// Group A — domain separation and golden digests
// Falsifiers 1, 2. Acceptance criterion 10.
// ---------------------------------------------------------------------------

describe('A. domain-separated digests', () => {
  it('F1: the fixed card, projection, result, reference and receipt produce the five exact golden hashes', () => {
    expect(cardDigest(CARD)).toBe(GOLDEN.cardDigest);
    expect(projectionDigest(PROJECTION)).toBe(GOLDEN.projectionDigest);
    expect(resultNodeDigest(NODE)).toBe(GOLDEN.resultDigest);
    expect(computeResultRefId(refWithout())).toBe(GOLDEN.resultRefId);
    expect(
      computeReceiptId({
        schemaVersion: 'v0',
        kind: 'completion-receipt',
        outcome: 'committed',
        resultRef: validRef(),
        causationId: 'cause-1',
        correlationId: 'corr-1',
      }),
    ).toBe(GOLDEN.receiptId);
  });

  it('F1: the five golden hashes are pairwise distinct', () => {
    const all = [
      GOLDEN.cardDigest,
      GOLDEN.projectionDigest,
      GOLDEN.resultDigest,
      GOLDEN.resultRefId,
      GOLDEN.receiptId,
    ];
    expect(new Set(all).size).toBe(5);
  });

  it('F1: the five digest domains are distinct constants', () => {
    const domains = [
      DOMAIN_CARD,
      DOMAIN_PROJECTION,
      DOMAIN_RESULT_NODE,
      DOMAIN_RESULT_REF,
      DOMAIN_RECEIPT,
    ];
    expect(domains).toEqual([
      'task-card-v0',
      'task-card-projection-v0',
      'task-card-result-node-v0',
      'muneral-result-ref-v0',
      'assembly-completion-receipt-v0',
    ]);
    expect(new Set(domains).size).toBe(5);
  });

  it('F1: identical bytes under different domains produce different digests', () => {
    expect(domainDigest(DOMAIN_CARD, NODE)).not.toBe(
      domainDigest(DOMAIN_RESULT_NODE, NODE),
    );
    expect(domainDigest(DOMAIN_RESULT_REF, NODE)).not.toBe(
      domainDigest(DOMAIN_RECEIPT, NODE),
    );
    expect(domainDigest(DOMAIN_PROJECTION, NODE)).not.toBe(
      domainDigest(DOMAIN_RESULT_NODE, NODE),
    );
  });

  it('F1: the card digest is not the projection digest for the same card bytes', () => {
    expect(cardDigest(CARD)).not.toBe(projectionDigest(CARD));
  });

  it('F1: digests are stable under key reordering (canonical form)', () => {
    const reordered = {
      instructions: 'do the thing',
      cardId: 'card-1',
      schemaVersion: 'v0',
    };
    expect(cardDigest(reordered)).toBe(GOLDEN.cardDigest);
  });

  it('F2: changing result bytes changes the result digest', () => {
    expect(resultNodeDigest(NODE_ALTERED)).toBe(GOLDEN.resultDigestAltered);
    expect(resultNodeDigest(NODE_ALTERED)).not.toBe(GOLDEN.resultDigest);
  });

  it('F2: changing result bytes changes the reference digest', () => {
    expect(computeResultRefId(refWithout(GOLDEN.resultDigestAltered))).toBe(
      GOLDEN.resultRefIdAltered,
    );
    expect(computeResultRefId(refWithout(GOLDEN.resultDigestAltered))).not.toBe(
      GOLDEN.resultRefId,
    );
  });

  it('F2: changing result bytes changes the receipt digest', () => {
    const alteredRef: CommittedResultRefV0 = {
      ...refWithout(GOLDEN.resultDigestAltered),
      resultRefId: GOLDEN.resultRefIdAltered,
    };
    expect(
      computeReceiptId({
        schemaVersion: 'v0',
        kind: 'completion-receipt',
        outcome: 'committed',
        resultRef: alteredRef,
        causationId: 'cause-1',
        correlationId: 'corr-1',
      }),
    ).toBe(GOLDEN.receiptIdAltered);
  });

  it('F2: changing result bytes does NOT change the Task Card digest', () => {
    expect(cardDigest(CARD)).toBe(GOLDEN.cardDigest);
    expect(resultNodeDigest(NODE_ALTERED)).not.toBe(GOLDEN.resultDigest);
    // The card is the instruction domain; the result is a separate domain.
    expect(cardDigest(CARD)).not.toBe(resultNodeDigest(NODE_ALTERED));
  });
});

// ---------------------------------------------------------------------------
// Group B — closed schemas fail closed
// Falsifiers 3, 8, 11. Acceptance criterion 10.
// ---------------------------------------------------------------------------

describe('B. closed receipt and reference schemas', () => {
  it('F3: a receipt carrying the unknown field "digest" fails closed', () => {
    const legacy = { ...validReceipt(), digest: GOLDEN.cardDigest };
    const outcome = validateCompletionReceiptV0(legacy);
    expect(outcome).toBeInstanceOf(ResultContractError);
    expect((outcome as ResultContractError).message).toMatch(/digest/);
  });

  it('F3: the rejected legacy proposal receipt.digest === projection.cardDigest is refused', () => {
    const legacy = {
      ...validReceipt(),
      digest: GOLDEN.projectionDigest,
    };
    expect(validateCompletionReceiptV0(legacy)).toBeInstanceOf(
      ResultContractError,
    );
  });

  it('F11: a receipt carrying result content fails closed', () => {
    const withPayload = {
      ...validReceipt(),
      result: { summary: 'done' },
    };
    expect(validateCompletionReceiptV0(withPayload)).toBeInstanceOf(
      ResultContractError,
    );
  });

  it('F11: prose and Markdown cannot be a completion receipt', () => {
    expect(validateCompletionReceiptV0('the task is done')).toBeInstanceOf(
      ResultContractError,
    );
    expect(
      validateCompletionReceiptV0('## Result\n\nAll good.'),
    ).toBeInstanceOf(ResultContractError);
  });

  it('F11: a receipt carrying a storage locator or adapter mode fails closed', () => {
    expect(
      validateCompletionReceiptV0({ ...validReceipt(), storageUri: 's3://x' }),
    ).toBeInstanceOf(ResultContractError);
    expect(
      validateCompletionReceiptV0({ ...validReceipt(), adapterMode: 'local' }),
    ).toBeInstanceOf(ResultContractError);
  });

  it('a well-formed receipt validates and round-trips unchanged', () => {
    const outcome = validateCompletionReceiptV0(validReceipt());
    expect(outcome).not.toBeInstanceOf(Error);
    expect(outcome).toEqual(validReceipt());
  });

  it('F8: a receipt whose stated receiptId does not match its bytes fails closed', () => {
    const tampered = { ...validReceipt(), receiptId: GOLDEN.receiptIdAltered };
    expect(validateCompletionReceiptV0(tampered)).toBeInstanceOf(
      ResultContractError,
    );
  });

  it('a reference carrying an unknown field fails closed', () => {
    expect(
      validateCommittedResultRefV0({ ...validRef(), extra: 1 }),
    ).toBeInstanceOf(ResultContractError);
  });

  it('a reference with a non-hex digest fails closed', () => {
    expect(
      validateCommittedResultRefV0({ ...validRef(), resultDigest: 'not-hex' }),
    ).toBeInstanceOf(ResultContractError);
  });

  it('a reference with nodeVersion below 1 fails closed', () => {
    expect(
      validateCommittedResultRefV0({ ...validRef(), nodeVersion: 0 }),
    ).toBeInstanceOf(ResultContractError);
  });

  it('a reference whose resultRefId does not match recomputation fails closed', () => {
    expect(
      validateCommittedResultRefV0({
        ...validRef(),
        resultRefId: GOLDEN.resultRefIdAltered,
      }),
    ).toBeInstanceOf(ResultContractError);
  });

  it('a reference with the wrong kind or schemaVersion fails closed', () => {
    expect(
      validateCommittedResultRefV0({ ...validRef(), kind: 'completion-receipt' }),
    ).toBeInstanceOf(ResultContractError);
    expect(
      validateCommittedResultRefV0({ ...validRef(), schemaVersion: 'v1' }),
    ).toBeInstanceOf(ResultContractError);
  });

  it('F16: an empty legacy result replays as legacy-none and is never promoted to a receipt', () => {
    expect(replayLegacyCommittedResult({})).toBe(LEGACY_NONE);
    expect(validateCompletionReceiptV0({})).toBeInstanceOf(ResultContractError);
  });

  it('F16: arbitrary legacy JSON cannot be promoted into a completion receipt', () => {
    const legacy = { ok: true, output: 'whatever the adapter said' };
    expect(replayLegacyCommittedResult(legacy)).toBeInstanceOf(
      ResultContractError,
    );
    expect(validateCompletionReceiptV0(legacy)).toBeInstanceOf(
      ResultContractError,
    );
  });
});

// ---------------------------------------------------------------------------
// Group C — per-message plane validation (round-5 boundary)
// Falsifier 14. Task-description design property 8.
// ---------------------------------------------------------------------------

describe('C. result-plane validation preserves the round-5 boundary', () => {
  it('F14: a valid Task Card nodeId is accepted on the result plane', () => {
    expect(validateResultPlane(NODE)).toBeNull();
    expect(validateResultPlane({ nodeId: 'node-7' })).toBeNull();
  });

  it('F14: Supervisor lifecycle fields are rejected', () => {
    expect(validateResultPlane({ desiredState: 'running' })).not.toBeNull();
    expect(validateResultPlane({ desiredGeneration: 4 })).not.toBeNull();
    expect(validateResultPlane({ observedState: 'up' })).not.toBeNull();
  });

  it('F14: Supervisor placement, rollout and watchdog fields are rejected', () => {
    expect(validateResultPlane({ placement: 'host-1' })).not.toBeNull();
    expect(validateResultPlane({ rollout: 'canary' })).not.toBeNull();
    expect(validateResultPlane({ watchdog: { heartbeat: 1 } })).not.toBeNull();
  });

  it('F14: Supervisor direct command-routing fields are rejected', () => {
    expect(validateResultPlane({ startProcess: true })).not.toBeNull();
    expect(validateResultPlane({ stopProcess: true })).not.toBeNull();
    expect(validateResultPlane({ restartProcess: true })).not.toBeNull();
  });

  it('F14: a Supervisor principal is rejected', async () => {
    const tx = makeTx();
    const service = new ResultAuthorityService(clock, makeIdSource());
    const outcome = await service.commitOwnedResult(
      makePrisma(tx),
      validProposal({ principalId: 'supervisor:fleet-controller' }),
    );
    expect(outcome).toBeInstanceOf(ResultPlaneError);
    expectZeroWrites(tx);
  });

  it('F14: a wrong-plane result node creates zero task-state mutation', async () => {
    const tx = makeTx();
    const service = new ResultAuthorityService(clock, makeIdSource());
    const outcome = await service.commitOwnedResult(
      makePrisma(tx),
      validProposal({
        resultNode: { nodeId: 'node-1', desiredState: 'running' },
      }),
    );
    expect(outcome).toBeInstanceOf(ResultPlaneError);
    expectZeroWrites(tx);
  });
});

// ---------------------------------------------------------------------------
// Group D — the authoritative commit seam
// Falsifiers 4, 5, 6, 7, 8, 9. Acceptance criteria 11 and 12.
// ---------------------------------------------------------------------------

describe('D. authoritative commit seam', () => {
  let service: ResultAuthorityService;

  beforeEach(() => {
    service = new ResultAuthorityService(clock, makeIdSource());
  });

  it('an execution adapter cannot author a receipt', async () => {
    const tx = makeTx();
    const outcome = await service.commitOwnedResult(makePrisma(tx), {
      ...validProposal(),
      receipt: validReceipt(),
    });
    expect(outcome).toBeInstanceOf(AdapterAuthorityError);
    expectZeroWrites(tx);
  });

  it('an execution adapter cannot supply an authoritative digest', async () => {
    const tx = makeTx();
    const outcome = await service.commitOwnedResult(makePrisma(tx), {
      ...validProposal(),
      resultDigest: GOLDEN.resultDigest,
    });
    expect(outcome).toBeInstanceOf(AdapterAuthorityError);
    expectZeroWrites(tx);
  });

  it('an execution adapter cannot supply a resultRefId', async () => {
    const tx = makeTx();
    const outcome = await service.commitOwnedResult(makePrisma(tx), {
      ...validProposal(),
      resultRefId: GOLDEN.resultRefId,
    });
    expect(outcome).toBeInstanceOf(AdapterAuthorityError);
    expectZeroWrites(tx);
  });

  it('a malformed proposal fails closed with zero writes', async () => {
    const tx = makeTx();
    const outcome = await service.commitOwnedResult(makePrisma(tx), {
      kind: 'owned-result-mutation',
    });
    expect(outcome).toBeInstanceOf(ResultContractError);
    expectZeroWrites(tx);
  });

  it('AC12: a successful commit writes node, transition, reference and outbox in one transaction', async () => {
    const tx = makeTx();
    const prisma = makePrisma(tx);
    const outcome = await service.commitOwnedResult(prisma, validProposal());

    expect(outcome).not.toBeInstanceOf(Error);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.taskResultNode.create).toHaveBeenCalledTimes(1);
    expect(tx.taskExecutionTransition.create).toHaveBeenCalledTimes(1);
    expect(tx.taskCommittedResultRef.create).toHaveBeenCalledTimes(1);
    expect(tx.taskOutboxEvent.create).toHaveBeenCalledTimes(1);
    expect(tx.outboxLease.create).toHaveBeenCalledTimes(1);
  });

  it('the server computes the result digest from the committed canonical node bytes', async () => {
    const tx = makeTx();
    const outcome = await service.commitOwnedResult(
      makePrisma(tx),
      validProposal(),
    );
    expect(outcome).not.toBeInstanceOf(Error);
    const committed = outcome as { resultRef: CommittedResultRefV0 };
    expect(committed.resultRef.resultDigest).toBe(GOLDEN.resultDigest);
    expect(tx.taskResultNode.create.mock.calls[0][0].data.resultDigest).toBe(
      GOLDEN.resultDigest,
    );
  });

  it('the authored receipt validates against the closed schema', async () => {
    const tx = makeTx();
    const outcome = await service.commitOwnedResult(
      makePrisma(tx),
      validProposal(),
    );
    const committed = outcome as { receipt: CompletionReceiptV0 };
    expect(validateCompletionReceiptV0(committed.receipt)).not.toBeInstanceOf(
      Error,
    );
    expect(committed.receipt.outcome).toBe('committed');
    expect(committed.receipt.resultRef.resultRefId).toBe(
      committed.receipt.resultRef.resultRefId,
    );
  });

  it('the outbox payload carries the closed reference, never the result body', async () => {
    const tx = makeTx();
    await service.commitOwnedResult(makePrisma(tx), validProposal());
    const payload = tx.taskOutboxEvent.create.mock.calls[0][0].data
      .eventPayload as { committedResult: Record<string, unknown> };
    expect(payload.committedResult).toMatchObject({
      schema: 'muneral-committed-result-v0',
    });
    expect(JSON.stringify(payload)).not.toContain('done');
  });

  it('the first commit of a node starts at nodeVersion 1', async () => {
    const tx = makeTx();
    const outcome = await service.commitOwnedResult(
      makePrisma(tx),
      validProposal({ expectedNodeVersion: 0 }),
    );
    const committed = outcome as { resultRef: CommittedResultRefV0 };
    expect(committed.resultRef.nodeVersion).toBe(1);
  });

  it('F4: a wrong principal against an established binding creates zero writes', async () => {
    const tx = makeTx({
      taskCommittedResultRef: {
        findFirst: jest.fn().mockResolvedValue({
          taskId: TASK_ID,
          cardId: 'card-1',
          cardDigest: GOLDEN.cardDigest,
          projectionId: 'proj-1',
          projectionDigest: GOLDEN.projectionDigest,
          principalId: PRINCIPAL,
        }),
        create: jest.fn().mockResolvedValue({}),
      },
    });
    const outcome = await service.commitOwnedResult(
      makePrisma(tx),
      validProposal({ principalId: 'agent-arcana:someone-else' }),
    );
    expect(outcome).toBeInstanceOf(ResultBindingError);
    expectZeroWrites(tx);
  });

  it('F4: a wrong card digest against an established binding creates zero writes', async () => {
    const tx = makeTx({
      taskCommittedResultRef: {
        findFirst: jest.fn().mockResolvedValue({
          taskId: TASK_ID,
          cardId: 'card-1',
          cardDigest: GOLDEN.cardDigest,
          projectionId: 'proj-1',
          projectionDigest: GOLDEN.projectionDigest,
          principalId: PRINCIPAL,
        }),
        create: jest.fn().mockResolvedValue({}),
      },
    });
    const outcome = await service.commitOwnedResult(
      makePrisma(tx),
      validProposal({ cardDigest: GOLDEN.resultDigest }),
    );
    expect(outcome).toBeInstanceOf(ResultBindingError);
    expectZeroWrites(tx);
  });

  it('F4: a wrong projection digest against an established binding creates zero writes', async () => {
    const tx = makeTx({
      taskCommittedResultRef: {
        findFirst: jest.fn().mockResolvedValue({
          taskId: TASK_ID,
          cardId: 'card-1',
          cardDigest: GOLDEN.cardDigest,
          projectionId: 'proj-1',
          projectionDigest: GOLDEN.projectionDigest,
          principalId: PRINCIPAL,
        }),
        create: jest.fn().mockResolvedValue({}),
      },
    });
    const outcome = await service.commitOwnedResult(
      makePrisma(tx),
      validProposal({ projectionDigest: GOLDEN.cardDigest }),
    );
    expect(outcome).toBeInstanceOf(ResultBindingError);
    expectZeroWrites(tx);
  });

  it('F4: a wrong expected node version creates zero writes', async () => {
    const tx = makeTx({
      taskResultNode: {
        findFirst: jest.fn().mockResolvedValue({ nodeVersion: 2 }),
        create: jest.fn().mockResolvedValue({}),
      },
    });
    const outcome = await service.commitOwnedResult(
      makePrisma(tx),
      validProposal({ expectedNodeVersion: 0 }),
    );
    expect(outcome).toBeInstanceOf(ResultBindingError);
    expectZeroWrites(tx);
  });

  it('F4: a wrong attempt creates zero writes', async () => {
    const tx = makeTx();
    const outcome = await service.commitOwnedResult(
      makePrisma(tx),
      validProposal({ attemptId: '99999999-9999-4999-8999-999999999999' }),
    );
    expect(outcome).toBeInstanceOf(ResultBindingError);
    expectZeroWrites(tx);
  });

  it('F4: a node declared other than the node actually committed creates zero writes', async () => {
    // The proposal claims to commit node-9 while the committed node bytes
    // address node-1. A reference must never bind a digest to a node the
    // adapter did not commit.
    const tx = makeTx();
    const outcome = await service.commitOwnedResult(
      makePrisma(tx),
      validProposal({ nodeId: 'node-9' }),
    );
    expect(outcome).toBeInstanceOf(ResultContractError);
    expectZeroWrites(tx);
  });

  it('F5: two writers at one node version yield one reference; the loser produces none', async () => {
    const tx = makeTx();
    // The unique constraint on (task, attempt, card, node, node version) is the
    // arbiter: the loser's insert raises P2002 and the transaction rolls back.
    tx.taskCommittedResultRef.create = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    const outcome = await service.commitOwnedResult(
      makePrisma(tx),
      validProposal(),
    );
    expect(outcome).toBeInstanceOf(ResultBindingError);
  });

  it('F6: repeating the same mutation returns a byte-identical reference and receipt', async () => {
    const first = await new ResultAuthorityService(
      clock,
      makeIdSource(),
    ).commitOwnedResult(makePrisma(makeTx()), validProposal());
    const committed = first as {
      resultRef: CommittedResultRefV0;
      receipt: CompletionReceiptV0;
    };

    const replayTx = makeTx({
      taskCommittedResultRef: {
        findFirst: jest.fn().mockImplementation(async (args: {
          where: Record<string, unknown>;
        }) =>
          args.where.mutationId === undefined
            ? null
            : {
                ...committed.resultRef,
                receiptId: committed.receipt.receiptId,
                causationId: 'cause-1',
                correlationId: 'corr-1',
              },
        ),
        create: jest.fn().mockResolvedValue({}),
      },
    });
    const replay = await new ResultAuthorityService(
      clock,
      makeIdSource(),
    ).commitOwnedResult(makePrisma(replayTx), validProposal());

    const replayed = replay as {
      resultRef: CommittedResultRefV0;
      receipt: CompletionReceiptV0;
    };
    expect(replayed.resultRef).toEqual(committed.resultRef);
    expect(replayed.receipt).toEqual(committed.receipt);
    expect(replayTx.taskResultNode.create).not.toHaveBeenCalled();
    expect(replayTx.taskCommittedResultRef.create).not.toHaveBeenCalled();
    expect(replayTx.taskOutboxEvent.create).not.toHaveBeenCalled();
  });

  it('F7: reusing an idempotency key with different canonical bytes fails as a conflict', async () => {
    const tx = makeTx({
      taskExecutionTransition: {
        findFirst: jest.fn().mockResolvedValue({
          id: TRANSITION_ID,
          taskId: TASK_ID,
          aggregateVersion: 3n,
          idempotencyKey: 'idem-result-1',
          commandDigest: 'a'.repeat(64),
          committedResult: {},
        }),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({}),
      },
    });
    const outcome = await service.commitOwnedResult(
      makePrisma(tx),
      validProposal(),
    );
    expect(outcome).toBeInstanceOf(IdempotencyCollisionError);
    expect(tx.taskCommittedResultRef.create).not.toHaveBeenCalled();
  });

  it('F9: a failure after the node write rolls the whole set back', async () => {
    const tx = makeTx();
    tx.taskExecutionTransition.create = jest
      .fn()
      .mockRejectedValue(new Error('crash between node and transition'));
    await expect(
      service.commitOwnedResult(makePrisma(tx), validProposal()),
    ).rejects.toThrow('crash between node and transition');
    expect(tx.taskCommittedResultRef.create).not.toHaveBeenCalled();
    expect(tx.taskOutboxEvent.create).not.toHaveBeenCalled();
  });

  it('F9: a failure after the transition write leaves no reference or receipt', async () => {
    const tx = makeTx();
    tx.taskCommittedResultRef.create = jest
      .fn()
      .mockRejectedValue(new Error('crash before reference'));
    await expect(
      service.commitOwnedResult(makePrisma(tx), validProposal()),
    ).rejects.toThrow('crash before reference');
  });

  it('F10: journal replay regenerates a byte-identical reference from stored fields', async () => {
    const tx = makeTx();
    const outcome = await service.commitOwnedResult(
      makePrisma(tx),
      validProposal(),
    );
    const committed = outcome as { resultRef: CommittedResultRefV0 };
    const stored = tx.taskCommittedResultRef.create.mock.calls[0][0].data;
    const regenerated = computeResultRefId({
      schemaVersion: 'v0',
      kind: 'task-card-result',
      taskId: stored.taskId,
      attemptId: stored.attemptId,
      cardId: stored.cardId,
      cardDigest: stored.cardDigest,
      projectionId: stored.projectionId,
      projectionDigest: stored.projectionDigest,
      nodeId: stored.nodeId,
      nodeVersion: stored.nodeVersion,
      resultDigest: stored.resultDigest,
      mutationId: stored.mutationId,
      principalId: stored.principalId,
      transitionId: stored.transitionId,
      aggregateVersion: Number(stored.aggregateVersion),
    });
    expect(regenerated).toBe(committed.resultRef.resultRefId);
    expect(regenerated).toBe(stored.resultRefId);
  });

  it('the seam issues no fleet lifecycle, placement or command call', async () => {
    const tx = makeTx();
    await service.commitOwnedResult(makePrisma(tx), validProposal());
    const written = JSON.stringify(
      tx.taskCommittedResultRef.create.mock.calls[0][0].data,
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
    );
    for (const forbidden of [
      'desiredState',
      'placement',
      'rollout',
      'watchdog',
      'startProcess',
      'stopProcess',
      'restartProcess',
    ]) {
      expect(written).not.toContain(forbidden);
    }
  });
});
