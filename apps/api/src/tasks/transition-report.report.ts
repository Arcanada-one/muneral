/**
 * MUN-0076 — project-scoped transition report.
 *
 * Distinct from daily-only status-transition-counts: this report adds the
 * current cohort statusCounts histogram and from→to edgeCounts derived from
 * activity_log payload tokens. Read-only: never PATCHes task status. No
 * free-text titles leave this report.
 */

import { TASK_STATUSES, type TaskStatus } from '@muneral/types';

export const STATUS_TRANSITION_ACTION = 'task:status_changed';
export const MAX_WINDOW_DAYS = 3_660;
export const DAY_MS = 86_400_000;

const UTC_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

const STATUS_SET = new Set<string>(TASK_STATUSES);

export class WindowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WindowValidationError';
  }
}

export interface TransitionReportWindow {
  startInclusiveUtc: string;
  endExclusiveUtc: string;
  startMs: number;
  endMs: number;
}

export interface TransitionReportEvent {
  id: string;
  taskId: string;
  createdAt: string;
  createdAtMs: number;
  from?: string;
  to?: string;
}

export interface TransitionReport {
  schemaVersion: 1;
  projectId: string;
  generatedAt: string;
  scope: {
    cohortTaskCount: number;
    startInclusiveUtc: string;
    endExclusiveUtc: string;
    timeZone: 'UTC';
    eventAction: typeof STATUS_TRANSITION_ACTION;
    denominatorMeaning: string;
  };
  inputCompleteness: {
    state: 'DB_COHORT_COMPLETE';
    evidenceId: string;
  };
  statusCounts: {
    verdict: 'MEASURED';
    byStatus: Record<TaskStatus, number>;
    statusCountsMeaning: string;
  };
  transitions: {
    verdict: 'MEASURED';
    observedTotal: number;
    dailyCounts: Array<{ dateUtc: string; count: number }>;
    dailyCountsMeaning: string;
    edgeCounts: Array<{ from: TaskStatus; to: TaskStatus; count: number }>;
    edgeCountsMeaning: string;
  };
  rates: {
    verdict: 'NOT_MEASURED';
    reason: string;
  };
  comparability: {
    verdict: 'NOT_MEASURED';
    reason: string;
  };
  /** Explicit product contract: this report never mutates statuses. */
  autoPatch: false;
}

function singleQueryValue(
  query: Record<string, unknown>,
  key: string,
): string | undefined {
  if (!(key in query)) return undefined;
  const value = query[key];
  if (Array.isArray(value)) {
    throw new WindowValidationError(
      `Query parameter ${key} must be a single UTC timestamp string.`,
    );
  }
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new WindowValidationError(
      `Query parameter ${key} must be a single UTC timestamp string.`,
    );
  }
  return value === undefined || value === null ? undefined : value;
}

function parseUtcTimestamp(value: string, key: string): { iso: string; ms: number } {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WindowValidationError(
      `Query parameter ${key} must be a UTC timestamp ending in Z.`,
    );
  }
  const match = UTC_TIMESTAMP.exec(value);
  if (!match) {
    throw new WindowValidationError(
      `Query parameter ${key} must be a UTC timestamp ending in Z.`,
    );
  }
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new WindowValidationError(
      `Query parameter ${key} must be a UTC timestamp ending in Z.`,
    );
  }
  const parsed = new Date(ms);
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day) ||
    parsed.getUTCHours() !== Number(hour) ||
    parsed.getUTCMinutes() !== Number(minute) ||
    parsed.getUTCSeconds() !== Number(second) ||
    parsed.getUTCMilliseconds() !== Number((fraction + '000').slice(0, 3))
  ) {
    throw new WindowValidationError(
      `Query parameter ${key} must be a UTC timestamp ending in Z.`,
    );
  }
  return { iso: value, ms };
}

export function resolveTransitionReportWindow(
  query: Record<string, unknown>,
): TransitionReportWindow {
  const startRaw = singleQueryValue(query, 'startInclusiveUtc');
  const endRaw = singleQueryValue(query, 'endExclusiveUtc');
  if (startRaw === undefined || endRaw === undefined) {
    throw new WindowValidationError(
      'Query parameters startInclusiveUtc and endExclusiveUtc are required.',
    );
  }
  const start = parseUtcTimestamp(startRaw, 'startInclusiveUtc');
  const end = parseUtcTimestamp(endRaw, 'endExclusiveUtc');
  if (start.ms >= end.ms) {
    throw new WindowValidationError(
      'startInclusiveUtc must be strictly before endExclusiveUtc.',
    );
  }
  if (end.ms - start.ms > MAX_WINDOW_DAYS * DAY_MS) {
    throw new WindowValidationError(
      `The half-open UTC window must be at most ${MAX_WINDOW_DAYS} days.`,
    );
  }
  return {
    startInclusiveUtc: start.iso,
    endExclusiveUtc: end.iso,
    startMs: start.ms,
    endMs: end.ms,
  };
}

function dayKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function utcDayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function emptyStatusCounts(): Record<TaskStatus, number> {
  const counts = {} as Record<TaskStatus, number>;
  for (const status of TASK_STATUSES) {
    counts[status] = 0;
  }
  return counts;
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && STATUS_SET.has(value);
}

export function buildTransitionReport(input: {
  projectId: string;
  generatedAt: string;
  auditEventId: string;
  cohortStatuses: string[];
  window: TransitionReportWindow;
  events: TransitionReportEvent[];
}): TransitionReport {
  const byStatus = emptyStatusCounts();
  for (const status of input.cohortStatuses) {
    if (isTaskStatus(status)) {
      byStatus[status] += 1;
    }
  }

  const countsByDay = new Map<string, number>();
  const edgeMap = new Map<string, { from: TaskStatus; to: TaskStatus; count: number }>();
  let observedTotal = 0;
  for (const event of input.events) {
    if (
      event.createdAtMs < input.window.startMs ||
      event.createdAtMs >= input.window.endMs
    ) {
      continue;
    }
    const dateUtc = dayKey(event.createdAtMs);
    countsByDay.set(dateUtc, (countsByDay.get(dateUtc) ?? 0) + 1);
    observedTotal += 1;
    if (isTaskStatus(event.from) && isTaskStatus(event.to) && event.from !== event.to) {
      const key = `${event.from}->${event.to}`;
      const existing = edgeMap.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        edgeMap.set(key, { from: event.from, to: event.to, count: 1 });
      }
    }
  }

  const firstDay = utcDayStart(dayKey(input.window.startMs));
  const lastDay = utcDayStart(dayKey(input.window.endMs - 1));
  const dailyCounts: Array<{ dateUtc: string; count: number }> = [];
  for (let day = firstDay; day <= lastDay; day += DAY_MS) {
    const dateUtc = new Date(day).toISOString().slice(0, 10);
    dailyCounts.push({ dateUtc, count: countsByDay.get(dateUtc) ?? 0 });
  }

  const edgeCounts = [...edgeMap.values()].sort((a, b) => {
    if (a.from !== b.from) return a.from.localeCompare(b.from);
    return a.to.localeCompare(b.to);
  });

  return {
    schemaVersion: 1,
    projectId: input.projectId,
    generatedAt: input.generatedAt,
    scope: {
      cohortTaskCount: input.cohortStatuses.length,
      startInclusiveUtc: input.window.startInclusiveUtc,
      endExclusiveUtc: input.window.endExclusiveUtc,
      timeZone: 'UTC',
      eventAction: STATUS_TRANSITION_ACTION,
      denominatorMeaning:
        'Number of distinct task UUIDs currently in the project cohort; transition totals are events, not unique transitioned tasks.',
    },
    inputCompleteness: {
      state: 'DB_COHORT_COMPLETE',
      evidenceId: input.auditEventId,
    },
    statusCounts: {
      verdict: 'MEASURED',
      byStatus,
      statusCountsMeaning:
        'Current status histogram of every task currently in the project cohort (all statuses).',
    },
    transitions: {
      verdict: 'MEASURED',
      observedTotal,
      dailyCounts,
      dailyCountsMeaning:
        'Counts include zero for every UTC date intersecting the half-open window.',
      edgeCounts,
      edgeCountsMeaning:
        'Only events whose payload from/to are distinct valid TaskStatus tokens contribute to edgeCounts; malformed payloads still count in observedTotal/dailyCounts.',
    },
    rates: {
      verdict: 'NOT_MEASURED',
      reason:
        'Aggregate events do not establish the number of unique tasks that transitioned or their historical state.',
    },
    comparability: {
      verdict: 'NOT_MEASURED',
      reason:
        'No paired report with matching cohort and UTC window was supplied.',
    },
    autoPatch: false,
  };
}
