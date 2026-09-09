// MUN-0040: wires MUN-0020 execution-authority into the real task lifecycle.
//
// This is deliberately best-effort and additive, mirroring the schema
// comment on TaskExecutionState/TaskExecutionAttempt ("additive models
// extending Task ... does not replace Task or its current status machine"):
// a failure to record an execution attempt must never block the Task.status
// transition it is attached to. Callers await onStatusTransition() for
// observability (it never throws) but do not need to branch on its result to
// stay correct — the staleness reporter (task-staleness.service.ts) is what
// turns a missing/failed recording into `not_measured`, never into a false
// "healthy" or "stalled" verdict.
//
// Scope, and why it stops here:
// - Only real-time, API-driven transitions are recorded (called from
//   TasksService). Historical/imported transitions (migration.service.ts)
//   are NOT recorded here — per I14, historical "done" is asserted, never
//   verified, and fabricating attempt provenance for backfilled rows would
//   misrepresent that assertion as a measured execution.
// - The MUN-0020 aggregate models one execution episode per task
//   (issue_initial_attempt is legal only once, at expectedVersion 0; a
//   second episode after a terminal succeeded/cancelled attempt has no
//   supported re-open command without rewriting the reducer, which is out of
//   scope for this card). A task that re-enters in_progress after such a
//   terminal episode is left `not_measured` rather than silently
//   misattributed to the prior episode — see ensureRunningAttempt() below.
// - Attempts opened on entry to in_progress stay `running` through review/
//   blocked/todo cycles and only close on a transition to done (succeeded)
//   or cancelled (cancelled): the operator's ask was "how long has this task
//   been being worked", which this models as one continuous span from first
//   entering in_progress to the task's resolution, not per-visit slices.
import { Injectable, Logger } from '@nestjs/common';
import type { TaskStatus } from '@muneral/types';
import { PrismaService } from '../prisma/prisma.service';
import { ExecutionAuthorityService } from './execution-authority.service';

const DEFAULT_RETRY_BUDGET = 3;
const DEFAULT_RETRY_BACKOFF_MS = 60_000;

export type RecordVerdict = 'recorded' | 'skipped' | 'failed';

export interface RecordOutcome {
  verdict: RecordVerdict;
  reason: string;
}

@Injectable()
export class TaskExecutionRecorderService {
  private readonly logger = new Logger(TaskExecutionRecorderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly executionAuthority: ExecutionAuthorityService,
  ) {}

  async onStatusTransition(
    taskId: string,
    to: TaskStatus,
    correlationId: string,
  ): Promise<RecordOutcome> {
    try {
      let outcome: RecordOutcome;
      if (to === 'in_progress') {
        outcome = await this.ensureRunningAttempt(taskId, correlationId);
      } else if (to === 'done' || to === 'cancelled') {
        outcome = await this.closeAttempt(taskId, to, correlationId);
      } else {
        outcome = {
          verdict: 'skipped',
          reason: `no execution-authority action for transition to ${to}`,
        };
      }
      if (outcome.verdict === 'failed') {
        this.logger.warn(
          `execution recording failed for task ${taskId} (-> ${to}): ${outcome.reason}`,
        );
      }
      return outcome;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `execution recording threw for task ${taskId} (-> ${to}): ${reason}`,
      );
      return { verdict: 'failed', reason };
    }
  }

  private async ensureRunningAttempt(
    taskId: string,
    correlationId: string,
  ): Promise<RecordOutcome> {
    const state = await this.prisma.taskExecutionState.findUnique({
      where: { taskId },
    });

    if (!state) {
      const issued = await this.executionAuthority.executeCommand(this.prisma, {
        kind: 'issue_initial_attempt',
        taskId,
        expectedVersion: 0,
        idempotencyKey: `issue:${taskId}:1`,
        causationId: correlationId,
        correlationId,
        retryBudget: DEFAULT_RETRY_BUDGET,
        retryBackoffMs: DEFAULT_RETRY_BACKOFF_MS,
        evidenceRefs: [],
      });
      if (issued instanceof Error) {
        return { verdict: 'failed', reason: `issue_initial_attempt: ${issued.message}` };
      }
      const attemptId = issued.state.currentAttemptId;
      if (!attemptId) {
        return { verdict: 'failed', reason: 'issue_initial_attempt did not set currentAttemptId' };
      }
      const started = await this.executionAuthority.executeCommand(this.prisma, {
        kind: 'transition_attempt',
        taskId,
        attemptId,
        expectedVersion: issued.state.aggregateVersion,
        eventType: 'attempt:started',
        idempotencyKey: `start:${attemptId}`,
        causationId: correlationId,
        correlationId,
        evidenceRefs: [],
        payload: {},
        committedResult: {},
      });
      if (started instanceof Error) {
        return { verdict: 'failed', reason: `attempt:started: ${started.message}` };
      }
      return { verdict: 'recorded', reason: 'issued and started initial attempt' };
    }

    const aggregateVersion = Number(state.aggregateVersion);

    if (state.currentAttemptId === null) {
      return {
        verdict: 'skipped',
        reason:
          'task re-entered in_progress after a terminal execution episode; ' +
          'MUN-0020 aggregate has no re-open command — not_measured for this episode',
      };
    }

    const attempt = await this.prisma.taskExecutionAttempt.findUnique({
      where: { attemptId: state.currentAttemptId },
    });
    if (!attempt) {
      return { verdict: 'failed', reason: 'currentAttemptId set but attempt row missing' };
    }

    if (attempt.status === 'running') {
      return { verdict: 'skipped', reason: 'attempt already running' };
    }

    if (attempt.status === 'issued') {
      const started = await this.executionAuthority.executeCommand(this.prisma, {
        kind: 'transition_attempt',
        taskId,
        attemptId: attempt.attemptId,
        expectedVersion: aggregateVersion,
        eventType: 'attempt:started',
        idempotencyKey: `start:${attempt.attemptId}`,
        causationId: correlationId,
        correlationId,
        evidenceRefs: [],
        payload: {},
        committedResult: {},
      });
      if (started instanceof Error) {
        return { verdict: 'failed', reason: `attempt:started: ${started.message}` };
      }
      return { verdict: 'recorded', reason: 'started issued attempt' };
    }

    if (attempt.status === 'failed') {
      const now = new Date();
      const eligible = state.retryEligibleAt === null || state.retryEligibleAt <= now;
      if (!eligible) {
        return { verdict: 'skipped', reason: 'retry not yet eligible (backoff window open)' };
      }
      const retried = await this.executionAuthority.executeCommand(this.prisma, {
        kind: 'issue_retry_attempt',
        taskId,
        expectedVersion: aggregateVersion,
        idempotencyKey: `retry:${taskId}:${Number(state.retryCount) + 1}`,
        causationId: correlationId,
        correlationId,
        evidenceRefs: [],
      });
      if (retried instanceof Error) {
        return { verdict: 'skipped', reason: `retry not issued: ${retried.message}` };
      }
      const newAttemptId = retried.state.currentAttemptId;
      if (!newAttemptId) {
        return { verdict: 'failed', reason: 'issue_retry_attempt did not set currentAttemptId' };
      }
      const started = await this.executionAuthority.executeCommand(this.prisma, {
        kind: 'transition_attempt',
        taskId,
        attemptId: newAttemptId,
        expectedVersion: retried.state.aggregateVersion,
        eventType: 'attempt:started',
        idempotencyKey: `start:${newAttemptId}`,
        causationId: correlationId,
        correlationId,
        evidenceRefs: [],
        payload: {},
        committedResult: {},
      });
      if (started instanceof Error) {
        return { verdict: 'failed', reason: `attempt:started after retry: ${started.message}` };
      }
      return { verdict: 'recorded', reason: 'issued retry attempt and started it' };
    }

    // succeeded/cancelled clear currentAttemptId (execution-authority.types.ts
    // clearsCurrentAttempt); reaching this with such a status is a data
    // inconsistency, not a case this recorder should paper over.
    return { verdict: 'failed', reason: `unexpected current attempt status ${attempt.status}` };
  }

  private async closeAttempt(
    taskId: string,
    to: 'done' | 'cancelled',
    correlationId: string,
  ): Promise<RecordOutcome> {
    const state = await this.prisma.taskExecutionState.findUnique({
      where: { taskId },
    });
    if (!state || state.currentAttemptId === null) {
      return { verdict: 'skipped', reason: 'no running execution attempt to close' };
    }
    const attempt = await this.prisma.taskExecutionAttempt.findUnique({
      where: { attemptId: state.currentAttemptId },
    });
    if (!attempt || attempt.status !== 'running') {
      return {
        verdict: 'skipped',
        reason: `current attempt status is ${attempt?.status ?? 'missing'}, not running`,
      };
    }

    const eventType = to === 'done' ? 'attempt:succeeded' : 'attempt:cancelled';
    const result = await this.executionAuthority.executeCommand(this.prisma, {
      kind: 'transition_attempt',
      taskId,
      attemptId: attempt.attemptId,
      expectedVersion: Number(state.aggregateVersion),
      eventType,
      idempotencyKey: `${eventType}:${attempt.attemptId}`,
      causationId: correlationId,
      correlationId,
      evidenceRefs: [],
      payload: {},
      committedResult: {},
    });
    if (result instanceof Error) {
      return { verdict: 'failed', reason: `${eventType}: ${result.message}` };
    }
    return { verdict: 'recorded', reason: `attempt ${eventType}` };
  }
}
