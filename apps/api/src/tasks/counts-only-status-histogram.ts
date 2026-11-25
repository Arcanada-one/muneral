import type { TaskStatus } from '@muneral/types';

const ALLOWED_SCOPE_VERSIONS = ['fixture-scope-1'] as const;
const [SCOPE_VERSION] = ALLOWED_SCOPE_VERSIONS;
const REFUSAL = 'D182_COUNTS_REFUSED';

if (!ALLOWED_SCOPE_VERSIONS.every((version) => /^[a-z][a-z0-9-]{2,40}$/.test(version))) {
  throw new Error(REFUSAL);
}

const EMPTY_PUBLIC_COUNTS = {
  todo: 0,
  in_progress: 0,
  review: 0,
  blocked: 0,
  done: 0,
  cancelled: 0,
  archived: 0,
} satisfies Record<TaskStatus, number>;

const EMPTY_COUNTS = { ...EMPTY_PUBLIC_COUNTS, unknown: 0, invalid: 0 };
type Bucket = keyof typeof EMPTY_COUNTS;
const BUCKETS = Object.keys(EMPTY_COUNTS) as Bucket[];

interface Cohort {
  workspaceId: string;
  projectId?: string;
}

interface CohortWhere {
  project: { workspaceId: string };
  projectId?: string;
}

interface StatusGroup {
  status: unknown;
  _count: { _all: number };
}

interface StatusCohortReader {
  task: {
    groupBy(query: {
      where: CohortWhere;
      by: ['status'];
      _count: { _all: true };
    }): PromiseLike<readonly StatusGroup[]>;
    count(query: { where: CohortWhere }): PromiseLike<number>;
  };
}

function bucketFor(status: unknown): Bucket {
  if (typeof status !== 'string') return 'unknown';
  return Object.hasOwn(EMPTY_PUBLIC_COUNTS, status) ? (status as TaskStatus) : 'invalid';
}

function hasExactFields(value: object, fields: readonly string[]): boolean {
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
}

function assertSafeCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(REFUSAL);
}

function buildCounts(groups: readonly StatusGroup[], total: number): Record<Bucket, number> {
  assertSafeCount(total);
  const byStatus: Record<Bucket, number> = Object.assign(Object.create(null), EMPTY_COUNTS);

  for (const group of groups) {
    if (!hasExactFields(group, ['status', '_count']) || !hasExactFields(group._count, ['_all'])) {
      throw new Error(REFUSAL);
    }
    const count = group._count._all;
    assertSafeCount(count);
    byStatus[bucketFor(group.status)] += count;
  }

  let sum = 0n;
  for (const bucket of BUCKETS) {
    assertSafeCount(byStatus[bucket]);
    sum += BigInt(byStatus[bucket]);
  }
  if (sum !== BigInt(total)) throw new Error(REFUSAL);
  return byStatus;
}

function formatCaptureInstant(instant: Date): string {
  // Intrinsic getTime checks the Date brand without invoking an override or coercion.
  const milliseconds = Date.prototype.getTime.call(instant);
  const utc = Date.prototype.toISOString.call(new Date(milliseconds));
  const isoUtc = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
  if (!isoUtc.test(utc)) throw new Error(REFUSAL);
  return utc;
}

/** Internal adapter. The interval brackets both reads without claiming an atomic snapshot. */
export async function readCountsOnlyStatusHistogram(
  db: StatusCohortReader,
  cohort: Cohort,
  now: () => Date = () => new Date(),
): Promise<string> {
  try {
    const { workspaceId, projectId } = cohort;
    if (SCOPE_VERSION === workspaceId || SCOPE_VERSION === projectId) throw new Error(REFUSAL);
    const where: CohortWhere = {
      project: { workspaceId },
      ...(projectId ? { projectId } : {}),
    };

    const captureStart = formatCaptureInstant(now());
    const groups = await db.task.groupBy({ where, by: ['status'], _count: { _all: true } });
    const total = await db.task.count({ where });
    const captureEnd = formatCaptureInstant(now());
    if (captureEnd < captureStart) throw new Error(REFUSAL);

    const byStatus = buildCounts(groups, total);
    return JSON.stringify({
      contract: 'D182-ASTAT-M1-COUNTS/2',
      scope_version: SCOPE_VERSION,
      capture_start: captureStart,
      capture_end: captureEnd,
      'tasks.total_current': String(total),
      'tasks.source_done_current': String(byStatus.done),
    });
  } catch {
    throw new Error(REFUSAL);
  }
}
