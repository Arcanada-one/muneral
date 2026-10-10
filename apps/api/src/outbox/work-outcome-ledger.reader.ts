// A2-375 (AEV E03.03, AEV-AC014 on the production read model).
//
// work_outcome_records is append-only: every delivered outcome event is one
// row, in delivery order (consumed_at). The relay does not guarantee delivery
// in aggregate order — it leases pending events by recordedAt, so an event
// that was pending longer (retry, quarantine release, a second relay) can
// arrive after a newer one. The state a reader derives from the ledger must
// therefore never be "the last row consumed".
//
// This is the one read rule for the ledger: the current outcome of a task is
// the row with the highest aggregate_version; a row consumed after a row with
// a higher aggregate_version is a late revision and is marked `late_ignored`.
// Nothing is deleted or rewritten — the ledger keeps the late row as evidence.

export type WorkOutcomeDisposition = 'applied' | 'late_ignored';

export interface WorkOutcomeRow {
  id: string;
  outboxEventId: string;
  taskId: string;
  eventType: string;
  aggregateVersion: bigint;
  consumedAt: Date;
}

export interface WorkOutcomeView {
  taskId: string;
  current: WorkOutcomeRow | null;
  rows: Array<WorkOutcomeRow & { disposition: WorkOutcomeDisposition }>;
}

/** Fold ledger rows of ONE task, in delivery order, into its current outcome. */
export function foldWorkOutcomes(taskId: string, rows: readonly WorkOutcomeRow[]): WorkOutcomeView {
  const delivered = [...rows].sort(
    (a, b) =>
      a.consumedAt.getTime() - b.consumedAt.getTime() ||
      // Same millisecond: treat the lower version as delivered first, so a tie
      // can only ever mark the lower revision late, never roll state back.
      (a.aggregateVersion < b.aggregateVersion ? -1 : a.aggregateVersion > b.aggregateVersion ? 1 : 0),
  );
  let current: WorkOutcomeRow | null = null;
  const out: WorkOutcomeView['rows'] = [];
  for (const row of delivered) {
    if (current && row.aggregateVersion < current.aggregateVersion) {
      out.push({ ...row, disposition: 'late_ignored' });
      continue;
    }
    current = row;
    out.push({ ...row, disposition: 'applied' });
  }
  return { taskId, current, rows: out };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readWorkOutcome(client: any, taskId: string): Promise<WorkOutcomeView> {
  const rows: WorkOutcomeRow[] = await client.workOutcomeRecord.findMany({
    where: { taskId },
    select: {
      id: true,
      outboxEventId: true,
      taskId: true,
      eventType: true,
      aggregateVersion: true,
      consumedAt: true,
    },
  });
  return foldWorkOutcomes(taskId, rows);
}
