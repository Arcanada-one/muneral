import type { TaskStatus } from '@muneral/types';
import { validate as isUuid } from 'uuid';
import { statusOnlyCohortQuery } from './status-only-cohort.js';

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

interface CountsOnlyStatusHistogram {
  byStatus: Record<Bucket, number>;
  total: number;
}

interface Scope {
  scopeVersion: string;
  /** Reviewed public labels supplied by the caller. Never include cohort names. */
  allowedScopeVersions: ReadonlySet<string>;
}

interface Capture extends Scope {
  captureStart: Date;
  captureEnd: Date;
}

interface StatusRow {
  status: unknown;
}

interface StatusCohortReader {
  task: {
    findMany(query: ReturnType<typeof statusOnlyCohortQuery>): PromiseLike<readonly StatusRow[]>;
  };
}

function bucketFor(status: unknown): Bucket {
  if (typeof status !== 'string') return 'unknown';
  return Object.hasOwn(EMPTY_PUBLIC_COUNTS, status) ? (status as TaskStatus) : 'invalid';
}

function assertSafeCount(count: number, label: string): void {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(`${label} must be a nonnegative safe integer.`);
  }
}

function assertReconciled({ byStatus, total }: CountsOnlyStatusHistogram): void {
  assertSafeCount(total, 'Cohort count');
  let sum = 0n;
  for (const bucket of BUCKETS) {
    const count = byStatus[bucket];
    assertSafeCount(count, 'Status count');
    sum += BigInt(count);
  }
  if (sum !== BigInt(total)) {
    throw new RangeError('Status counts do not reconcile with the cohort count.');
  }
}

export function buildCountsOnlyStatusHistogram(
  rows: readonly StatusRow[],
  cohortCount: number,
): CountsOnlyStatusHistogram {
  assertSafeCount(cohortCount, 'Cohort count');

  const byStatus: Record<Bucket, number> = Object.assign(Object.create(null), EMPTY_COUNTS);
  for (const row of rows) {
    const prototype = Object.getPrototypeOf(row);
    const keys = Reflect.ownKeys(row);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      keys.length !== 1 ||
      keys[0] !== 'status'
    ) {
      throw new TypeError('Cohort query rows must contain only the status field.');
    }
    byStatus[bucketFor(row.status)] += 1;
  }

  const histogram = { byStatus, total: cohortCount };
  assertReconciled(histogram);
  return histogram;
}

function assertAllowedScope({ scopeVersion, allowedScopeVersions }: Scope): void {
  if (typeof scopeVersion !== 'string' || isUuid(scopeVersion)) {
    throw new RangeError('Scope version must be a public label.');
  }
  if (!allowedScopeVersions.has(scopeVersion)) {
    throw new RangeError('Scope version is not allowlisted.');
  }
}

function formatCaptureInstant(instant: Date): string {
  const utc = instant.toISOString();
  if (utc.length !== 24) throw new RangeError('Capture instant must have a four-digit UTC year.');
  return utc;
}

export function serializeCountsOnlyStatusHistogram(
  histogram: CountsOnlyStatusHistogram,
  capture: Capture,
): string {
  assertAllowedScope(capture);
  const captureStart = formatCaptureInstant(capture.captureStart);
  const captureEnd = formatCaptureInstant(capture.captureEnd);
  if (captureEnd < captureStart) {
    throw new RangeError('Capture end must not precede capture start.');
  }
  assertReconciled(histogram);

  return JSON.stringify({
    contract: 'D182-ASTAT-M1-COUNTS/1',
    scope_version: capture.scopeVersion,
    capture_start: captureStart,
    capture_end: captureEnd,
    total: String(histogram.total),
    by_status: Object.fromEntries(
      BUCKETS.map((bucket) => [bucket, String(histogram.byStatus[bucket])]),
    ),
  });
}

/** Internal adapter. No controller or agent grant registers this read. */
export async function readCountsOnlyStatusHistogram(
  db: StatusCohortReader,
  cohort: { workspaceId: string; projectId?: string },
  scope: Scope,
  now: () => Date = () => new Date(),
): Promise<string> {
  assertAllowedScope(scope);
  if (scope.scopeVersion === cohort.workspaceId || scope.scopeVersion === cohort.projectId) {
    throw new RangeError('Scope version must be a public label.');
  }
  const query = statusOnlyCohortQuery(cohort.workspaceId, cohort.projectId);
  const captureStart = new Date(now().getTime());
  const rows = await db.task.findMany(query);
  const captureEnd = now();
  return serializeCountsOnlyStatusHistogram(buildCountsOnlyStatusHistogram(rows, rows.length), {
    ...scope,
    captureStart,
    captureEnd,
  });
}
