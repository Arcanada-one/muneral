// MUN-0040 (AUP-X03 HistoricalTaskImport) / MUN-0041 (AUP-DAT-006): historical
// status -> Muneral status, through the versioned HistoricalStatusMap.
//
// Three rules the profile is explicit about, and that this module exists to
// keep separate from ordinary status handling:
//
//   1. An old `done` is only an ASSERTION about the past. The work item gets
//      Muneral status `done`, but the occurrence records
//      historical_asserted_done = true with current_verification =
//      'not_revalidated'. Nothing in this import path may claim the work was
//      re-verified now. Which raw values assert completion is the CONTRACT's
//      decision, not this file's: `archived`, `done_pending_archive`,
//      `completed` and `done` all do, at revisions 2 and 3 alike.
//   1b. MUN-0043 / DEC-AUP-0014 rule 3: the assertion and the projection are
//      two different facts. From revision 3 `archived` still asserts that the
//      source considered the card finished, but it projects onto `archived`,
//      not onto `done` — an archive card records a card LEAVING THE BOARD, and
//      a status that reads as completion would totalise it into one.
//   2. An unmappable status is NOT invented into something plausible. The work
//      item lands in `todo`, `unmapped` is set, and the raw string survives
//      verbatim on the occurrence, so the mapping stays auditable and
//      reversible. For a BULK importer, DAT-006 makes UNMAPPED a typed refusal;
//      producer0 never rejects a single item, it flags it.
//   3. The raw string is stored exactly as the source wrote it. Normalisation
//      (NFC, trim, casefold) exists only to find the row in the map.

import type { TaskStatus } from '@muneral/types';
import {
  STATUS_MAP,
  STATUS_MAP_REVISION,
  STATUS_MAP_REVISIONS,
  SUPPORTED_STATUS_MAP_REVISIONS,
  normalizeRawStatus,
  statusMapForRevision,
} from './status-map/status-map';

export const NOT_REVALIDATED = 'not_revalidated' as const;

/** Raised when a caller asks to project under a revision this build does not
 *  carry. Never softened into "use the current one": the revision is the whole
 *  provenance claim. */
export class UnknownStatusMapRevisionError extends Error {
  constructor(readonly revision: number) {
    super(
      `status map revision ${revision} is not vendored in this build ` +
        `(available: ${SUPPORTED_STATUS_MAP_REVISIONS.join(', ')})`,
    );
    this.name = 'UnknownStatusMapRevisionError';
  }
}

export interface HistoricalStatusMapping {
  /** The Muneral status the imported work item starts in. */
  taskStatus: TaskStatus;
  /** The source's own status string, stored verbatim on the occurrence. */
  historicalStatus: string;
  /** True only when the SOURCE asserted completion — never a fresh verdict. */
  historicalAssertedDone: boolean;
  /** Always 'not_revalidated' on import: this path never re-verifies. */
  currentVerification: typeof NOT_REVALIDATED;
  /** True when the normalised raw status is absent from the map. */
  unmapped: boolean;
  /** The revision of the map that produced this projection — provenance,
   *  recorded on the occurrence so a later revision cannot be mistaken for the
   *  one actually applied. */
  statusMapRevision: number;
}

/**
 * Project one raw status.
 *
 * `revision` names the artefact to project with. Omitted, it is the revision
 * this build ships as current; given, it must be a revision the build actually
 * vendors, and an unknown one throws instead of degrading to the current map.
 * That is what makes a replay of an older batch honest: the row says it was
 * projected under revision 2, and asking for revision 2 reproduces exactly the
 * projection that was written, rather than silently re-deciding it under
 * today's rules.
 */
export function mapHistoricalStatus(
  raw: string,
  revision?: number,
): HistoricalStatusMapping {
  const artefact =
    revision === undefined ? STATUS_MAP : statusMapForRevision(revision);
  if (!artefact) throw new UnknownStatusMapRevisionError(revision as number);

  const entry = artefact.map[normalizeRawStatus(raw)];

  return {
    taskStatus: entry ? entry.muneral : ('todo' as TaskStatus),
    historicalStatus: raw,
    historicalAssertedDone: entry ? entry.asserted_done : false,
    currentVerification: NOT_REVALIDATED,
    unmapped: entry === undefined,
    statusMapRevision: artefact.revision,
  };
}

export {
  STATUS_MAP,
  STATUS_MAP_REVISION,
  STATUS_MAP_REVISIONS,
  SUPPORTED_STATUS_MAP_REVISIONS,
  normalizeRawStatus,
  statusMapForRevision,
};
