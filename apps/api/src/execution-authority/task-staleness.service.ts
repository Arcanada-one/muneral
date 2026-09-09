// MUN-0040: "we know how long a task usually takes to solve — that should
// already be a signal if a task is taking too long" (operator, verbatim, in
// the card brief). This turns MUN-0020 execution-authority recordings into
// that number.
//
// The verdict is tri-valued on purpose (I4, no silent totalization): a task
// currently `in_progress` with no recorded execution attempt — never wired
// before this card, and never backfilled by it, since this repo never writes
// to the live Muneral database — is `not_measured`. It must never be read as
// `healthy` (there is no evidence of that) or as `stalled` (same). Only a
// task with a running attempt gets a real `healthy`/`stalled` verdict, timed
// from that attempt's `startedAt` (falling back to `issuedAt` for the
// vanishingly short window between issue and start).
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type StalenessVerdict = 'healthy' | 'stalled' | 'not_measured';

export interface TaskStalenessEntry {
  taskId: string;
  priority: string;
  verdict: StalenessVerdict;
  ageMs: number | null;
  reason: string;
}

const DEFAULT_THRESHOLD_MS = 24 * 3_600_000; // 24h

@Injectable()
export class TaskStalenessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * All `in_progress` tasks in a project. When `scopedToAgentId` is given the
   * result is narrowed to that agent's assigned tasks — same narrowing, same
   * reason, as `TasksService.findByProject` (MUN-0043): the database, not a
   * post-filter, is what keeps an agent key from seeing the rest of the board.
   */
  async reportForProject(
    projectId: string,
    thresholdMs: number = DEFAULT_THRESHOLD_MS,
    scopedToAgentId?: string,
    now: Date = new Date(),
  ): Promise<TaskStalenessEntry[]> {
    const tasks = await this.prisma.task.findMany({
      where: {
        projectId,
        status: 'in_progress',
        ...(scopedToAgentId
          ? { agents: { some: { agentId: scopedToAgentId } } }
          : {}),
      },
      select: { id: true, priority: true },
    });

    return Promise.all(
      tasks.map((t) => this.evaluateTask(t.id, t.priority, thresholdMs, now)),
    );
  }

  async evaluateTask(
    taskId: string,
    priority: string,
    thresholdMs: number = DEFAULT_THRESHOLD_MS,
    now: Date = new Date(),
  ): Promise<TaskStalenessEntry> {
    const state = await this.prisma.taskExecutionState.findUnique({
      where: { taskId },
    });
    if (!state || state.currentAttemptId === null) {
      return {
        taskId,
        priority,
        verdict: 'not_measured',
        ageMs: null,
        reason: 'no recorded execution attempt for this task',
      };
    }

    const attempt = await this.prisma.taskExecutionAttempt.findUnique({
      where: { attemptId: state.currentAttemptId },
    });
    if (!attempt || attempt.status !== 'running') {
      return {
        taskId,
        priority,
        verdict: 'not_measured',
        ageMs: null,
        reason: `current attempt status is ${attempt?.status ?? 'missing'}, not running`,
      };
    }

    const since = attempt.startedAt ?? attempt.issuedAt;
    const ageMs = now.getTime() - since.getTime();
    const stalled = ageMs > thresholdMs;
    return {
      taskId,
      priority,
      verdict: stalled ? 'stalled' : 'healthy',
      ageMs,
      reason: stalled
        ? `running ${Math.round(ageMs / 3_600_000)}h, over the ${Math.round(thresholdMs / 3_600_000)}h threshold`
        : 'within threshold',
    };
  }
}
