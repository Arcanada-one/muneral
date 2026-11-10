/**
 * MUN-0075 — project-scoped status-transition counts.
 *
 * Counts activity_log rows with action `task:status_changed` for tasks in one
 * project inside a half-open UTC window. Aligns with the offline reporter in
 * `scripts/reporting/status-transition-counts.mjs`, but the live route loads the
 * cohort from the database (completeness = DB_COHORT_COMPLETE / MEASURED).
 *
 * Read-only: never PATCHes task status. No free-text titles leave this report.
 */

export const STATUS_TRANSITION_ACTION = 'task:status_changed';
export const MAX_WINDOW_DAYS = 3_660;
export const DAY_MS = 86_400_000;

const UTC_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

export class WindowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WindowValidationError';
  }
}

export interface StatusTransitionWindow {
  startInclusiveUtc: string;
  endExclusiveUtc: string;
  startMs: number;
  endMs: number;
}

export interface StatusTransitionEvent {
  id: string;
  taskId: string;
  createdAt: string;
  createdAtMs: number;
}

export interface StatusTransitionCountsReport {
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
  transitions: {
    verdict: 'MEASURED';
    observedTotal: number;
    dailyCounts: Array<{ dateUtc: string; count: number }>;
    dailyCountsMeaning: string;
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

export function resolveStatusTransitionWindow(
  query: Record<string, unknown>,
): StatusTransitionWindow {
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

export function buildStatusTransitionCountsReport(input: {
  projectId: string;
  generatedAt: string;
  auditEventId: string;
  cohortTaskCount: number;
  window: StatusTransitionWindow;
  events: StatusTransitionEvent[];
}): StatusTransitionCountsReport {
  const countsByDay = new Map<string, number>();
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
  }

  const firstDay = utcDayStart(dayKey(input.window.startMs));
  const lastDay = utcDayStart(dayKey(input.window.endMs - 1));
  const dailyCounts: Array<{ dateUtc: string; count: number }> = [];
  for (let day = firstDay; day <= lastDay; day += DAY_MS) {
    const dateUtc = new Date(day).toISOString().slice(0, 10);
    dailyCounts.push({ dateUtc, count: countsByDay.get(dateUtc) ?? 0 });
  }

  return {
    schemaVersion: 1,
    projectId: input.projectId,
    generatedAt: input.generatedAt,
    scope: {
      cohortTaskCount: input.cohortTaskCount,
      startInclusiveUtc: input.window.startInclusiveUtc,
      endExclusiveUtc: input.window.endExclusiveUtc,
      timeZone: 'UTC',
      eventAction: STATUS_TRANSITION_ACTION,
      denominatorMeaning:
        'Number of distinct task UUIDs currently in the project cohort; counts are transition events, not unique transitioned tasks.',
    },
    inputCompleteness: {
      state: 'DB_COHORT_COMPLETE',
      evidenceId: input.auditEventId,
    },
    transitions: {
      verdict: 'MEASURED',
      observedTotal,
      dailyCounts,
      dailyCountsMeaning:
        'Counts include zero for every UTC date intersecting the half-open window.',
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
