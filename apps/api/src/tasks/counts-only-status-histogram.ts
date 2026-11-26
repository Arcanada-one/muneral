import type { TaskStatus } from '@muneral/types';

const ALLOWED_SCOPES: readonly { scopeVersion: string; projectIds: readonly string[] }[] = [
  {
    scopeVersion: 'fixture-scope-1',
    projectIds: [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
    ],
  },
];
const REFUSAL = 'D182_COUNTS_REFUSED';
const SCOPE_VERSION_FORMAT = /^[a-z][a-z0-9-]{2,40}$/;
const PROJECT_UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

for (const { scopeVersion, projectIds } of ALLOWED_SCOPES) {
  if (!SCOPE_VERSION_FORMAT.test(scopeVersion) || PROJECT_UUID_FORMAT.test(scopeVersion)) {
    throw new Error(REFUSAL);
  }
  if (!Array.isArray(projectIds) || projectIds.length === 0 ||
      projectIds.some((projectId) => typeof projectId !== 'string' || !PROJECT_UUID_FORMAT.test(projectId))) {
    throw new Error(REFUSAL);
  }
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

interface CohortWhere {
  projectId: { in: string[] };
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
  scopeVersion: string,
  now: () => Date = () => new Date(),
): Promise<string> {
  try {
    if (typeof scopeVersion !== 'string' || !SCOPE_VERSION_FORMAT.test(scopeVersion)) {
      throw new Error(REFUSAL);
    }
    const scope = ALLOWED_SCOPES.find((entry) => entry.scopeVersion === scopeVersion);
    if (!scope) throw new Error(REFUSAL);
    const where = (): CohortWhere => ({ projectId: { in: [...scope.projectIds] } });

    const captureStart = formatCaptureInstant(now());
    const groups = await db.task.groupBy({ where: where(), by: ['status'], _count: { _all: true } });
    const total = await db.task.count({ where: where() });
    const captureEnd = formatCaptureInstant(now());
    if (captureEnd < captureStart) throw new Error(REFUSAL);

    const byStatus = buildCounts(groups, total);
    if (byStatus.unknown > 0 || byStatus.invalid > 0) throw new Error(REFUSAL);
    return JSON.stringify({
      contract: 'D182-ASTAT-M1-COUNTS/2',
      scope_version: scope.scopeVersion,
      capture_start: captureStart,
      capture_end: captureEnd,
      'tasks.total_current': String(total),
      'tasks.source_done_current': String(byStatus.done),
    });
  } catch {
    throw new Error(REFUSAL);
  }
}
