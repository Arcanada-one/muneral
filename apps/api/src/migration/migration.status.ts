// MUN-0040 (AUP-X03 HistoricalTaskImport): historical status -> Muneral status.
//
// Two rules the profile is explicit about, and that this module exists to keep
// separate from ordinary status handling:
//
//   1. An old `done` is only an ASSERTION about the past. The work item gets
//      Muneral status `done`, but the occurrence records
//      historical_asserted_done = true with current_verification =
//      'not_revalidated'. Nothing in this import path may claim the work was
//      re-verified now.
//   2. An unmappable status is NOT invented into something plausible. The work
//      item lands in `todo` and the raw string survives verbatim on the
//      occurrence, so the mapping stays auditable and reversible.

import type { TaskStatus } from '@muneral/types';

const KNOWN_STATUSES: readonly TaskStatus[] = [
  'todo',
  'in_progress',
  'review',
  'blocked',
  'done',
  'cancelled',
];

export const NOT_REVALIDATED = 'not_revalidated' as const;

export interface HistoricalStatusMapping {
  /** The Muneral status the imported work item starts in. */
  taskStatus: TaskStatus;
  /** The source's own status string, stored verbatim on the occurrence. */
  historicalStatus: string;
  /** True only when the SOURCE asserted completion — never a fresh verdict. */
  historicalAssertedDone: boolean;
  /** Always 'not_revalidated' on import: this path never re-verifies. */
  currentVerification: typeof NOT_REVALIDATED;
  /** True when the raw status has no Muneral equivalent and `todo` was used. */
  unmapped: boolean;
}

export function mapHistoricalStatus(raw: string): HistoricalStatusMapping {
  const normalized = raw.trim().toLowerCase();
  const known = KNOWN_STATUSES.find((s) => s === normalized);

  return {
    taskStatus: known ?? 'todo',
    historicalStatus: raw,
    historicalAssertedDone: known === 'done',
    currentVerification: NOT_REVALIDATED,
    unmapped: known === undefined,
  };
}
