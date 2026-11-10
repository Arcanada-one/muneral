/**
 * MUN-0067 — active-status staleness report over bodyless project-index fields.
 *
 * Distinct from MUN-0040 / TaskStalenessService (execution-attempt age). This
 * report ages `in_progress` / `review` / `blocked` rows by
 * `generatedAt - updatedAt` from a project index envelope (or the same
 * bodyless columns loaded under the same project-index grant).
 *
 * Read-only: never PATCHes task status. Title/description never appear; only
 * the existing bodyless index fields (title as sha256) may leave.
 */

export const ACTIVE_STATUSES = ['in_progress', 'review', 'blocked'] as const;
export type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

export const DEFAULT_SOFT_DAYS = 3;
export const DEFAULT_HARD_DAYS = 14;

const DAY_MS = 24 * 3_600_000;
const POSITIVE_FINITE_NUMBER =
  /^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

export type AgeBucket = 'fresh' | 'gtSoft' | 'gtHard';

export interface BodylessIndexTask {
  id: string;
  parentId: string | null;
  status: string;
  priority: string;
  /** Matches project-index bodyless column; schema allows null. */
  actorType: string | null;
  createdAt: string;
  updatedAt: string;
  titleSha256: string;
}

export interface ProjectIndexEnvelope {
  projectId: string;
  generatedAt: string;
  tasks: BodylessIndexTask[];
}

export interface ActiveStatusStalenessThresholds {
  softDays: number;
  hardDays: number;
}

export interface ActiveStatusStaleTask extends BodylessIndexTask {
  ageMs: number;
  bucket: Exclude<AgeBucket, 'fresh'>;
}

export interface ActiveStatusBucketCounts {
  n: number;
  fresh: number;
  gtSoft: number;
  gtHard: number;
  stale: ActiveStatusStaleTask[];
}

export interface ActiveStatusStalenessReport {
  projectId: string;
  generatedAt: string;
  counted: string;
  thresholds: ActiveStatusStalenessThresholds;
  /** Explicit product contract: this report never mutates statuses. */
  autoPatch: false;
  activeStatuses: readonly ActiveStatus[];
  byStatus: Record<ActiveStatus, ActiveStatusBucketCounts>;
}

export class ThresholdValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThresholdValidationError';
  }
}

function isActiveStatus(status: string): status is ActiveStatus {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

function emptyBuckets(): ActiveStatusBucketCounts {
  return { n: 0, fresh: 0, gtSoft: 0, gtHard: 0, stale: [] };
}

/**
 * Parse one positive finite day threshold from an Express/Nest query bag.
 * Mirrors MUN-0065 / closed PR261 intent for scalar validation without
 * reopening that PR's execution-staleness route.
 */
export function parsePositiveFiniteDays(
  query: Record<string, unknown>,
  key: string,
): number | undefined {
  const keys = Object.keys(query).filter(
    (k) => k === key || k.startsWith(`${key}[`),
  );
  if (keys.some((k) => k !== key)) {
    throw new ThresholdValidationError(
      `${key} must be a single positive finite number of days.`,
    );
  }

  const raw = query[key];
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'string' || !POSITIVE_FINITE_NUMBER.test(raw.trim())) {
    throw new ThresholdValidationError(
      `${key} must be a single positive finite number of days.`,
    );
  }
  const days = Number(raw.trim());
  const ms = days * DAY_MS;
  if (!Number.isFinite(days) || days <= 0 || !Number.isFinite(ms) || ms <= 0) {
    throw new ThresholdValidationError(
      `${key} must be a single positive finite number of days.`,
    );
  }
  return days;
}

export function resolveActiveStatusThresholds(
  query: Record<string, unknown>,
): ActiveStatusStalenessThresholds {
  const softDays = parsePositiveFiniteDays(query, 'softDays') ?? DEFAULT_SOFT_DAYS;
  const hardDays = parsePositiveFiniteDays(query, 'hardDays') ?? DEFAULT_HARD_DAYS;
  if (!(hardDays > softDays)) {
    throw new ThresholdValidationError(
      'hardDays must be strictly greater than softDays.',
    );
  }
  return { softDays, hardDays };
}

function classifyAge(
  ageMs: number,
  softMs: number,
  hardMs: number,
): AgeBucket {
  // Strict greater-than, same boundary convention as MUN-0040/MUN-0065.
  if (ageMs > hardMs) return 'gtHard';
  if (ageMs > softMs) return 'gtSoft';
  return 'fresh';
}

/**
 * Build the report from a project-index envelope (documented offline recipe)
 * or from the same bodyless rows a grant-scoped route loads.
 */
export function buildActiveStatusStalenessReport(
  index: ProjectIndexEnvelope,
  thresholds: ActiveStatusStalenessThresholds = {
    softDays: DEFAULT_SOFT_DAYS,
    hardDays: DEFAULT_HARD_DAYS,
  },
): ActiveStatusStalenessReport {
  if (!(thresholds.hardDays > thresholds.softDays)) {
    throw new ThresholdValidationError(
      'hardDays must be strictly greater than softDays.',
    );
  }
  if (
    !Number.isFinite(thresholds.softDays) ||
    !Number.isFinite(thresholds.hardDays) ||
    thresholds.softDays <= 0 ||
    thresholds.hardDays <= 0
  ) {
    throw new ThresholdValidationError(
      'softDays and hardDays must be positive finite numbers of days.',
    );
  }

  const generatedAtMs = Date.parse(index.generatedAt);
  if (!Number.isFinite(generatedAtMs)) {
    throw new ThresholdValidationError(
      'generatedAt must be a parseable ISO-8601 timestamp.',
    );
  }

  const softMs = thresholds.softDays * DAY_MS;
  const hardMs = thresholds.hardDays * DAY_MS;
  if (!Number.isFinite(softMs) || !Number.isFinite(hardMs) || softMs <= 0 || hardMs <= 0) {
    throw new ThresholdValidationError(
      'softDays and hardDays must be positive finite numbers of days.',
    );
  }

  const byStatus = {
    in_progress: emptyBuckets(),
    review: emptyBuckets(),
    blocked: emptyBuckets(),
  } satisfies Record<ActiveStatus, ActiveStatusBucketCounts>;

  for (const task of index.tasks) {
    if (!isActiveStatus(task.status)) continue;
    const updatedAtMs = Date.parse(task.updatedAt);
    if (!Number.isFinite(updatedAtMs)) {
      // Unparseable timestamps stay out of buckets rather than inventing age.
      continue;
    }
    const ageMs = generatedAtMs - updatedAtMs;
    const bucket = classifyAge(ageMs, softMs, hardMs);
    const row = byStatus[task.status];
    row.n += 1;
    if (bucket === 'fresh') {
      row.fresh += 1;
      continue;
    }
    if (bucket === 'gtHard') {
      row.gtHard += 1;
      row.gtSoft += 1;
    } else {
      row.gtSoft += 1;
    }
    row.stale.push({
      id: task.id,
      parentId: task.parentId,
      status: task.status,
      priority: task.priority,
      actorType: task.actorType,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      titleSha256: task.titleSha256,
      ageMs,
      bucket,
    });
  }

  for (const status of ACTIVE_STATUSES) {
    byStatus[status].stale.sort((a, b) => b.ageMs - a.ageMs || a.id.localeCompare(b.id));
  }

  return {
    projectId: index.projectId,
    generatedAt: index.generatedAt,
    counted:
      'active in_progress/review/blocked tasks of the project; age = generatedAt - updatedAt',
    thresholds: {
      softDays: thresholds.softDays,
      hardDays: thresholds.hardDays,
    },
    autoPatch: false,
    activeStatuses: ACTIVE_STATUSES,
    byStatus,
  };
}
