/**
 * MUN-0069 — transition-sourced workspace digest counts.
 *
 * Counts prefer `task:status_changed` activity over comment volume and over
 * `tasks.updatedAt` windows. Age crossings (staleness buckets) are deliberately
 * excluded: they belong to MUN-0067
 * (`GET /tasks/project/:projectId/active-status-staleness`). Bodyless status
 * histograms (current row status counts) may be attached as a separate
 * snapshot; they are not transition counts.
 */

import { TASK_STATUSES, type TaskStatus } from '@muneral/types';

export const TRANSITION_ACTION = 'task:status_changed';

/** Half-open window ceiling: same order as DEC-AUP-0029's 30-day read cap. */
export const MAX_DIGEST_TRANSITION_WINDOW_DAYS = 30;

export const WORKSPACE_DIGEST_TRANSITIONS_COUNTED =
  "every task:status_changed activity row of the key's own workspace inside the half-open window, before paging items";

export class DigestTransitionWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DigestTransitionWindowError';
  }
}

export interface DigestTransitionEvent {
  id: string;
  taskId: string;
  createdAt: string;
  from: TaskStatus;
  to: TaskStatus;
  projectId: string;
  title: string;
  /** Current task row status (may differ from `to` if later transitions exist). */
  status: TaskStatus;
}

export interface BodylessStatusRow {
  status: string;
}

export interface DigestTransitionWindow {
  sinceInclusive: string;
  beforeExclusive: string;
}

export interface DigestTransitionItem {
  id: string;
  taskId: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  from: TaskStatus;
  to: TaskStatus;
  transitionedAt: string;
}

export interface DigestTransitionsReport {
  counted: string;
  window: DigestTransitionWindow;
  transitions: {
    observedTotal: number;
    byToStatus: Record<TaskStatus, number>;
    byProjectId: Record<string, { total: number; byToStatus: Record<TaskStatus, number> }>;
    meaning: string;
  };
  commentVolume: {
    included: false;
    reason: string;
  };
  ageCrossings: {
    included: false;
    reason: string;
  };
  statusHistogram: {
    included: boolean;
    source: 'bodyless_task_status_rows' | 'omitted';
    byStatus?: Record<string, number>;
    total?: number;
    meaning: string;
  };
  items: DigestTransitionItem[];
  total: number;
  limit: number;
  offset: number;
}

const STATUS_SET = new Set<string>(TASK_STATUSES);

function emptyByStatus(): Record<TaskStatus, number> {
  return Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<
    TaskStatus,
    number
  >;
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && STATUS_SET.has(value);
}

function parseIsoInstant(value: string, label: string): number {
  if (typeof value !== 'string' || !/Z$/i.test(value)) {
    throw new DigestTransitionWindowError(
      `${label} must be an ISO-8601 UTC instant ending in Z.`,
    );
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new DigestTransitionWindowError(
      `${label} must be an ISO-8601 UTC instant ending in Z.`,
    );
  }
  return ms;
}

/**
 * Validate the half-open window. End is exclusive. Caps width at
 * MAX_DIGEST_TRANSITION_WINDOW_DAYS.
 */
export function resolveDigestTransitionWindow(input: {
  sinceInclusive?: string;
  beforeExclusive?: string;
}): DigestTransitionWindow {
  if (!input.sinceInclusive || !input.beforeExclusive) {
    throw new DigestTransitionWindowError(
      'sinceInclusive and beforeExclusive are required (half-open UTC window).',
    );
  }
  const start = parseIsoInstant(input.sinceInclusive, 'sinceInclusive');
  const end = parseIsoInstant(input.beforeExclusive, 'beforeExclusive');
  if (!(start < end)) {
    throw new DigestTransitionWindowError(
      'sinceInclusive must be strictly before beforeExclusive.',
    );
  }
  if (end - start > MAX_DIGEST_TRANSITION_WINDOW_DAYS * 86_400_000) {
    throw new DigestTransitionWindowError(
      `Window must be at most ${MAX_DIGEST_TRANSITION_WINDOW_DAYS} days.`,
    );
  }
  return {
    sinceInclusive: new Date(start).toISOString(),
    beforeExclusive: new Date(end).toISOString(),
  };
}

/**
 * Extract from/to from an activity payload. Malformed rows are skipped (never
 * counted as transitions); comments and other actions never arrive here.
 */
export function parseTransitionPayload(
  payload: unknown,
): { from: TaskStatus; to: TaskStatus } | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (!isTaskStatus(record.from) || !isTaskStatus(record.to)) return null;
  if (record.from === record.to) return null;
  return { from: record.from, to: record.to };
}

export function buildBodylessStatusHistogram(
  rows: readonly BodylessStatusRow[],
): { byStatus: Record<string, number>; total: number } {
  const byStatus: Record<string, number> = {};
  for (const row of rows) {
    const key = typeof row.status === 'string' ? row.status : 'unknown';
    byStatus[key] = (byStatus[key] ?? 0) + 1;
  }
  return { byStatus, total: rows.length };
}

/**
 * Build the transition-sourced digest summary. `events` must already be
 * workspace-scoped and limited to `task:status_changed` inside the window.
 * Callers pass every matching event for totals; `limit`/`offset` page `items`.
 */
export function buildDigestTransitionsReport(input: {
  window: DigestTransitionWindow;
  events: readonly DigestTransitionEvent[];
  limit?: number;
  offset?: number;
  statusRows?: readonly BodylessStatusRow[];
}): DigestTransitionsReport {
  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;
  const byToStatus = emptyByStatus();
  const byProjectId: Record<
    string,
    { total: number; byToStatus: Record<TaskStatus, number> }
  > = {};

  for (const event of input.events) {
    byToStatus[event.to] += 1;
    const project = byProjectId[event.projectId] ?? {
      total: 0,
      byToStatus: emptyByStatus(),
    };
    project.total += 1;
    project.byToStatus[event.to] += 1;
    byProjectId[event.projectId] = project;
  }

  const items = input.events.slice(offset, offset + limit).map((event) => ({
    id: event.id,
    taskId: event.taskId,
    projectId: event.projectId,
    title: event.title,
    status: event.status,
    from: event.from,
    to: event.to,
    transitionedAt: event.createdAt,
  }));

  const histogram =
    input.statusRows === undefined
      ? {
          included: false,
          source: 'omitted' as const,
          meaning:
            'Bodyless status histogram omitted; pass current task status rows to attach a snapshot separate from transition counts.',
        }
      : (() => {
          const built = buildBodylessStatusHistogram(input.statusRows);
          return {
            included: true,
            source: 'bodyless_task_status_rows' as const,
            byStatus: built.byStatus,
            total: built.total,
            meaning:
              'Current task-row status counts (bodyless). Not transition events; not age crossings.',
          };
        })();

  return {
    counted: WORKSPACE_DIGEST_TRANSITIONS_COUNTED,
    window: input.window,
    transitions: {
      observedTotal: input.events.length,
      byToStatus,
      byProjectId,
      meaning:
        'Counts are task:status_changed events (by destination status). Comment volume and updatedAt edits are excluded.',
    },
    commentVolume: {
      included: false,
      reason: 'Comment activity is excluded; counts are transition events only.',
    },
    ageCrossings: {
      included: false,
      reason:
        'Age/staleness crossings are reported by GET /tasks/project/:projectId/active-status-staleness (MUN-0067), not this route.',
    },
    statusHistogram: histogram,
    items,
    total: input.events.length,
    limit,
    offset,
  };
}
