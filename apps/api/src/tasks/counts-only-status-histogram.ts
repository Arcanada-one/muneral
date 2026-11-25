import type { TaskStatus } from '@muneral/types';
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

type Bucket = TaskStatus | 'unknown' | 'invalid';

interface StatusRow {
  status: unknown;
}

interface StatusCohortReader {
  task: {
    findMany(query: ReturnType<typeof statusOnlyCohortQuery>): PromiseLike<readonly StatusRow[]>;
  };
}

function bucketFor(status: unknown): Bucket {
  if (typeof status !== 'string') return 'invalid';
  return Object.hasOwn(EMPTY_PUBLIC_COUNTS, status) ? (status as TaskStatus) : 'unknown';
}

export function buildCountsOnlyStatusHistogram(
  rows: readonly StatusRow[],
  cohortCount: number,
) {
  if (!Number.isSafeInteger(cohortCount) || cohortCount < 0) {
    throw new RangeError('Cohort count must be a nonnegative safe integer.');
  }

  const byStatus: Record<Bucket, number> = Object.assign(Object.create(null), {
    ...EMPTY_PUBLIC_COUNTS,
    unknown: 0,
    invalid: 0,
  });
  for (const { status } of rows) {
    const bucket = bucketFor(status);
    const next = byStatus[bucket] + 1;
    if (!Number.isSafeInteger(next)) throw new RangeError('Status count exceeded the safe integer range.');
    byStatus[bucket] = next;
  }

  const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
  if (total !== cohortCount) {
    throw new RangeError('Status counts do not reconcile with the cohort count.');
  }

  return { byStatus, total };
}

/** Internal adapter. No controller or agent grant registers this read. */
export async function readCountsOnlyStatusHistogram(
  db: StatusCohortReader,
  workspaceId: string,
  projectId?: string,
) {
  const rows = await db.task.findMany(statusOnlyCohortQuery(workspaceId, projectId));
  return buildCountsOnlyStatusHistogram(rows, rows.length);
}
