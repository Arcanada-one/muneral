// MUN-0022 AC-6: bounded, test-only falsification over the pure compiler and
// actual MUN-0020 reducer output. Every claim has a deliberately weakened
// implementation as its negative control.

import { createHash } from 'node:crypto';
import {
  createAssemblyDecision,
} from '../../src/assembly/assembly.canonical';
import { compileAssembly } from '../../src/assembly/assembly.compiler';
import type {
  AssemblyArtifactV0,
  AssemblyRequestV0,
} from '../../src/assembly/assembly.types';
import { canonicalJsonV1 } from '../../src/execution-authority/canonical-json-v1';
import { commandDigest } from '../../src/execution-authority/canonical-json';
import { reduce } from '../../src/execution-authority/execution-authority.reducer';
import { replayJournal } from '../../src/execution-authority/execution-authority.replay';
import {
  EVENT_TO_ATTEMPT_STATUS,
} from '../../src/execution-authority/execution-authority.types';
import type {
  ExecutionAuthorityCommand,
  ReducerResult,
  TaskExecutionAttempt,
  TaskExecutionState,
  TaskExecutionTransition,
} from '../../src/execution-authority/execution-authority.types';

const NOW = new Date('2026-07-30T00:00:00.000Z');
const EVALUATED_AT = NOW.toISOString();

interface ReducerScenario {
  readonly initialCommand: ExecutionAuthorityCommand;
  readonly journal: TaskExecutionTransition[];
  readonly states: TaskExecutionState[];
  readonly attempts: TaskExecutionAttempt[];
}

function request(overrides: Partial<AssemblyRequestV0> = {}): AssemblyRequestV0 {
  return {
    schemaVersion: 'v0',
    taskId: 'task-falsify',
    causationId: 'cause-falsify',
    correlationId: 'corr-falsify',
    evaluatedAt: EVALUATED_AT,
    authorityCeiling: {
      tenant: 'acme',
      principal: 'user-f',
      purpose: 'bounded falsification',
      audience: 'internal',
      scope: 'read,write',
    },
    requestedAuthority: {
      tenant: 'acme',
      principal: 'user-f',
      purpose: 'bounded falsification',
      audience: 'internal',
      scope: 'read',
    },
    rolePolicy: { policyId: 'policy-f', policyVersion: 'v1', roleName: 'assistant' },
    candidateSet: {
      candidates: ['assistant'],
      sourceDigest: 'f'.repeat(64),
      capturedAt: EVALUATED_AT,
    },
    evidenceRefs: [],
    provenance: {
      policyUri: 'content://policy-f',
      policyDigest: 'e'.repeat(64),
      issuedAt: EVALUATED_AT,
    },
    ...overrides,
  };
}

function requestForState(state: TaskExecutionState): AssemblyRequestV0 {
  return request({
    taskId: state.taskId,
    causationId: `state-v${state.aggregateVersion}`,
    correlationId: 'journal-falsification',
    attemptBudget: Math.max(1, state.retryBudget - state.retryCount),
  });
}

function compile(input: AssemblyRequestV0): AssemblyArtifactV0 {
  const result = compileAssembly(input);
  if (!result.ok) throw new Error(`${result.error.errorCode}: ${result.error.message}`);
  return result.artifact;
}

function initialCommand(): ExecutionAuthorityCommand {
  return {
    kind: 'issue_initial_attempt',
    taskId: 'task-journal',
    expectedVersion: 0,
    idempotencyKey: 'idem-1',
    causationId: 'cause-journal',
    correlationId: 'corr-journal',
    retryBudget: 3,
    retryBackoffMs: 0,
    evidenceRefs: [],
  };
}

function updateAttempt(
  current: TaskExecutionAttempt,
  command: ExecutionAuthorityCommand,
  now: Date,
): TaskExecutionAttempt {
  if (command.kind !== 'transition_attempt') return current;
  const status = EVENT_TO_ATTEMPT_STATUS[command.eventType];
  return {
    ...current,
    status,
    startedAt: status === 'running' && current.startedAt === null ? now : current.startedAt,
    completedAt: ['succeeded', 'failed', 'cancelled'].includes(status) ? now : current.completedAt,
  };
}

function requireCurrent<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`${label} unexpectedly absent`);
  return value;
}

/** Build all ten facts through the real reducer; no transition is fabricated. */
function buildReducerJournal(): ReducerScenario {
  let state: TaskExecutionState | null = null;
  let attempt: TaskExecutionAttempt | null = null;
  const journal: TaskExecutionTransition[] = [];
  const states: TaskExecutionState[] = [];
  const attempts: TaskExecutionAttempt[] = [];
  const first = initialCommand();

  const apply = (command: ExecutionAuthorityCommand, attemptId: string): void => {
    const nextVersion = journal.length + 1;
    const now = new Date(NOW.getTime() + nextVersion * 1000);
    const result = reduce(state, attempt, command, {
      attemptId,
      transitionId: `transition-${nextVersion}`,
      now,
    });
    if (result instanceof Error) throw result;

    const reduced = result as ReducerResult;
    const fact: TaskExecutionTransition = {
      ...reduced.transition,
      id: `transition-${nextVersion}`,
      commandDigest: commandDigest(command),
      recordedAt: now,
    };
    state = reduced.nextState;
    if (reduced.attempt !== null) attempt = reduced.attempt;
    else if (attempt !== null) attempt = updateAttempt(attempt, command, now);
    if (attempt === null) throw new Error('reducer failed to establish a current attempt');
    journal.push(fact);
    states.push(state);
    attempts.push(attempt);
  };

  apply(first, 'attempt-1');
  for (let ordinal = 1; ordinal <= 3; ordinal++) {
    const issuedState = requireCurrent<TaskExecutionState>(state, 'issued state');
    const issuedAttempt = requireCurrent<TaskExecutionAttempt>(attempt, 'issued attempt');
    apply({
      kind: 'transition_attempt',
      taskId: issuedState.taskId,
      attemptId: issuedAttempt.attemptId,
      expectedVersion: issuedState.aggregateVersion,
      eventType: 'attempt:started',
      idempotencyKey: `idem-${journal.length + 1}`,
      causationId: 'cause-journal',
      correlationId: 'corr-journal',
      evidenceRefs: [],
      payload: {},
      committedResult: {},
    }, issuedAttempt.attemptId);
    const runningState = requireCurrent<TaskExecutionState>(state, 'running state');
    const runningAttempt = requireCurrent<TaskExecutionAttempt>(attempt, 'running attempt');
    apply({
      kind: 'transition_attempt',
      taskId: runningState.taskId,
      attemptId: runningAttempt.attemptId,
      expectedVersion: runningState.aggregateVersion,
      eventType: 'attempt:failed',
      idempotencyKey: `idem-${journal.length + 1}`,
      causationId: 'cause-journal',
      correlationId: 'corr-journal',
      evidenceRefs: [],
      payload: { failureClass: `bounded-${ordinal}` },
      committedResult: {},
    }, runningAttempt.attemptId);
    const failedState = requireCurrent<TaskExecutionState>(state, 'failed state');
    apply({
      kind: 'issue_retry_attempt',
      taskId: failedState.taskId,
      expectedVersion: failedState.aggregateVersion,
      idempotencyKey: `idem-${journal.length + 1}`,
      causationId: 'cause-journal',
      correlationId: 'corr-journal',
      evidenceRefs: [],
    }, `attempt-${ordinal + 1}`);
  }

  expect(journal).toHaveLength(10);
  return { initialCommand: first, journal, states, attempts };
}

function compileReplaySequence(journal: TaskExecutionTransition[]): AssemblyArtifactV0[] {
  return journal.map((_, index) => {
    const replayed = replayJournal(journal.slice(0, index + 1));
    if (replayed.state === null) throw new Error('non-empty journal replay produced no state');
    return compile(requestForState(replayed.state));
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('Claim 1 (N=3): identical command replays are byte-identical', () => {
  it('passes while a request-mutating replay wrapper breaks identity', () => {
    const scenario = buildReducerJournal();
    const artifacts = Array.from({ length: 3 }, () => {
      const result = reduce(null, null, scenario.initialCommand, {
        attemptId: 'attempt-1', transitionId: 'transition-1', now: new Date(NOW.getTime() + 1000),
      });
      if (result instanceof Error) throw result;
      return compile(requestForState(result.nextState));
    });
    expect(new Set(artifacts.map((value) => JSON.stringify(value))).size).toBe(1);

    const weakenedReplay = (delivery: number) => compile({
      ...requestForState(scenario.states[0]),
      causationId: `${requestForState(scenario.states[0]).causationId}-mutant-${delivery}`,
    });
    expect(new Set(Array.from({ length: 3 }, (_, index) => weakenedReplay(index).digest)).size)
      .toBe(3);
  });
});

describe('Claim 2 (N=5 sequences): exact journal replay reproduces artifacts', () => {
  it('passes while altering one reducer-produced fact changes the sequence', () => {
    const scenario = buildReducerJournal();
    const sequences = Array.from({ length: 5 }, () => compileReplaySequence(scenario.journal));
    expect(new Set(sequences.map((value) => JSON.stringify(value))).size).toBe(1);

    const altered = scenario.journal.map((fact, index) => index === 0 ? {
      ...fact,
      transitionPayload: { ...fact.transitionPayload, retryBudget: 4 },
    } : { ...fact });
    expect(JSON.stringify(compileReplaySequence(altered))).not.toBe(JSON.stringify(sequences[0]));
  });
});

describe('Claim 3 (5 stale versions): refusal precedes compiled-state change', () => {
  it('passes while a version-refusal bypass changes the compiled state', () => {
    const scenario = buildReducerJournal();
    const state = scenario.states[9];
    const attempt = scenario.attempts[9];
    const before = compile(requestForState(state));
    const snapshot = JSON.stringify(state);
    const commandFor = (expectedVersion: number): ExecutionAuthorityCommand => ({
      kind: 'transition_attempt',
      taskId: state.taskId,
      attemptId: attempt.attemptId,
      expectedVersion,
      eventType: 'attempt:started',
      idempotencyKey: `stale-${expectedVersion}`,
      causationId: 'cause-stale',
      correlationId: 'corr-stale',
      evidenceRefs: [],
      payload: {},
      committedResult: {},
    });

    for (let behind = 1; behind <= 5; behind++) {
      const result = reduce(state, attempt, commandFor(state.aggregateVersion - behind), {
        attemptId: attempt.attemptId,
        transitionId: `stale-${behind}`,
        now: NOW,
      });
      expect(result).toBeInstanceOf(Error);
      expect(JSON.stringify(state)).toBe(snapshot);
      expect(compile(requestForState(state)).digest).toBe(before.digest);
    }

    // Test-only weakened reducer: normalize the stale version to current before
    // delegating, which removes the refusal and permits an observable state move.
    const stale = commandFor(state.aggregateVersion - 1);
    const weakened = reduce(state, attempt, { ...stale, expectedVersion: state.aggregateVersion }, {
      attemptId: attempt.attemptId,
      transitionId: 'weakened-version-refusal',
      now: NOW,
    });
    expect(weakened).not.toBeInstanceOf(Error);
    if (weakened instanceof Error) throw weakened;
    expect(compile(requestForState(weakened.nextState)).digest).not.toBe(before.digest);
  });
});

describe('Claim 4 (N=1000): duplicate deliveries preserve one artifact', () => {
  it('passes while a delivery-nonce compiler wrapper breaks identity', () => {
    const scenario = buildReducerJournal();
    const input = requestForState(scenario.states[9]);
    expect(new Set(Array.from({ length: 1000 }, () => compile(input).digest)).size).toBe(1);

    const weakenedCompile = (delivery: number) => compile({
      ...input,
      causationId: `${input.causationId}-delivery-${delivery}`,
    });
    expect(new Set(Array.from({ length: 1000 }, (_, index) => weakenedCompile(index).digest)).size)
      .toBe(1000);
  });
});

describe('Claim 5 (N=1000): reorderings preserve request-to-artifact mapping', () => {
  it('passes while an order-sensitive compiler wrapper changes the mapping', () => {
    const scenario = buildReducerJournal();
    const inputs = scenario.states.slice(0, 5).map(requestForState);
    const expected = new Map(inputs.map((input) => [input.causationId, compile(input).digest]));
    for (let iteration = 0; iteration < 1000; iteration++) {
      const offset = iteration % inputs.length;
      const rotated = inputs.slice(offset).concat(inputs.slice(0, offset));
      const reordered = iteration % 2 === 0 ? rotated : [...rotated].reverse();
      for (const input of reordered) expect(compile(input).digest).toBe(expected.get(input.causationId));
    }

    const weakenedMapping = (ordered: AssemblyRequestV0[]) => {
      let accumulator = 0;
      return new Map(ordered.map((input) => {
        const version = Number(input.causationId.replace('state-v', ''));
        accumulator = accumulator * 11 + version;
        const artifact = compile({
          ...input,
          correlationId: `order-sensitive-${accumulator}-${input.causationId}`,
        });
        return [input.causationId, artifact.digest];
      }));
    };
    const forward = weakenedMapping(inputs);
    const reverse = weakenedMapping([...inputs].reverse());
    expect(inputs.some((input) => forward.get(input.causationId) !== reverse.get(input.causationId)))
      .toBe(true);
  });
});

describe('Claim 6 (N=10 prefixes): crash-prefix replay is reproducible', () => {
  it('compiles every prefix twice while a gapped prefix is refused', () => {
    const scenario = buildReducerJournal();
    for (let length = 1; length <= 10; length++) {
      const prefix = scenario.journal.slice(0, length);
      const first = replayJournal(prefix);
      const second = replayJournal(prefix);
      expect(second).toEqual(first);
      if (first.state === null || second.state === null) throw new Error('prefix replay lost state');
      expect(compile(requestForState(second.state))).toEqual(compile(requestForState(first.state)));
    }

    const gapped = scenario.journal.filter((fact) => fact.aggregateVersion !== 5);
    expect(() => replayJournal(gapped)).toThrow(/expected aggregate_version/);
  });
});

describe('Claim 7 (all categories): execution mutations move or refuse identity', () => {
  it('covers value/add/remove/schema mutations and catches an omitted decision field', () => {
    const scenario = buildReducerJournal();
    const baseRequest = requestForState(scenario.states[9]);
    const base = compile(baseRequest);
    const valueMutations: AssemblyRequestV0[] = [
      { ...baseRequest, taskId: 'task-mutated' },
      { ...baseRequest, causationId: 'cause-mutated' },
      { ...baseRequest, correlationId: 'corr-mutated' },
      { ...baseRequest, evaluatedAt: '2026-07-30T00:00:01.000Z' },
      {
        ...baseRequest,
        authorityCeiling: { ...baseRequest.authorityCeiling, tenant: 'other' },
        requestedAuthority: { ...baseRequest.requestedAuthority, tenant: 'other' },
      },
      {
        ...baseRequest,
        authorityCeiling: { ...baseRequest.authorityCeiling, principal: 'other' },
        requestedAuthority: { ...baseRequest.requestedAuthority, principal: 'other' },
      },
      {
        ...baseRequest,
        authorityCeiling: { ...baseRequest.authorityCeiling, purpose: 'other' },
        requestedAuthority: { ...baseRequest.requestedAuthority, purpose: 'other' },
      },
      {
        ...baseRequest,
        authorityCeiling: { ...baseRequest.authorityCeiling, audience: 'external' },
        requestedAuthority: { ...baseRequest.requestedAuthority, audience: 'external' },
      },
      { ...baseRequest, authorityCeiling: { ...baseRequest.authorityCeiling, scope: 'read' } },
      { ...baseRequest, requestedAuthority: { ...baseRequest.requestedAuthority, scope: 'write' } },
      { ...baseRequest, rolePolicy: { ...baseRequest.rolePolicy, policyId: 'other-policy' } },
      { ...baseRequest, rolePolicy: { ...baseRequest.rolePolicy, policyVersion: 'v2' } },
      { ...baseRequest, rolePolicy: { ...baseRequest.rolePolicy, roleName: 'reviewer' } },
      {
        ...baseRequest,
        candidateSet: { ...baseRequest.candidateSet, candidates: ['assistant', 'reviewer'] },
      },
      { ...baseRequest, candidateSet: { ...baseRequest.candidateSet, sourceDigest: 'b'.repeat(64) } },
      {
        ...baseRequest,
        candidateSet: { ...baseRequest.candidateSet, capturedAt: '2026-07-29T23:59:59.000Z' },
      },
      { ...baseRequest, attemptBudget: 2 },
      { ...baseRequest, provenance: { ...baseRequest.provenance, policyUri: 'content://other' } },
      { ...baseRequest, provenance: { ...baseRequest.provenance, policyDigest: 'c'.repeat(64) } },
      {
        ...baseRequest,
        provenance: { ...baseRequest.provenance, issuedAt: '2026-07-29T23:59:59.000Z' },
      },
    ];
    for (const mutation of valueMutations) {
      const result = compileAssembly(mutation);
      if (result.ok) expect(result.artifact.digest).not.toBe(base.digest);
      else expect(result.error.errorCode).toBeDefined();
    }

    const withAddedFields = request({
      ...baseRequest,
      deadline: '2026-07-30T00:01:00.000Z',
      evidenceRefs: [{
        uri: 'evidence/claim.json',
        digest: 'a'.repeat(64),
        contentType: 'application/json',
      }],
      provenance: { ...baseRequest.provenance, expiresAt: '2026-07-30T00:02:00.000Z' },
    });
    expect(compile(withAddedFields).digest).not.toBe(base.digest);

    const { attemptBudget: _removed, ...withoutAttemptBudget } = baseRequest;
    expect(compile(withoutAttemptBudget).digest).not.toBe(base.digest);
    expect(compileAssembly({ ...baseRequest, schemaVersion: 'v1' } as never)).toMatchObject({
      ok: false,
      error: { errorCode: 'UNSUPPORTED_SCHEMA_VERSION' },
    });
    expect(compile({ ...baseRequest, traceFields: { diagnostic: 'changed' } }).digest)
      .toBe(base.digest);

    // Test-only weakened digest projection: omitting attemptBudget makes a
    // known execution-affecting mutation collapse, proving the suite detects
    // precisely the regression it claims to guard.
    const weakenedDigest = (input: AssemblyRequestV0): string => {
      const { attemptBudget: _omitted, ...weakenedInput } = input;
      return sha256(canonicalJsonV1(createAssemblyDecision(weakenedInput)));
    };
    expect(weakenedDigest({ ...baseRequest, attemptBudget: 2 })).toBe(weakenedDigest(baseRequest));
    expect(compile({ ...baseRequest, attemptBudget: 2 }).digest).not.toBe(base.digest);
  });
});
