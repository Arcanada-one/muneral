// MUN-0041 (AUP-DAT-006, review X-08): the raw-status → Muneral-status mapping
// is a VERSIONED ARTEFACT, not an implicit default buried in a switch.
//
// `status-map-v1-rev<N>.json` in this directory are byte-identical vendored
// copies of the program's contract files
// (`arcanada-universal-program/contracts/status-mapping/status-map-v1-rev<N>.json`).
// They are vendored rather than fetched so that the projection an import
// performs is pinned to the deployed artefact and can be reproduced from the
// image alone; `revision` is the provenance token recorded on every occurrence.
//
// MUN-0043 (DEC-AUP-0014 rule 3): revisions are KEPT, not replaced. Revision 3
// stops projecting `archived` onto `done` — an archive card records that a card
// LEFT THE BOARD, which is terminal and unverified, and reading it as
// completion is the silent totalisation the program's I4 forbids. Revision 2
// stays loaded verbatim, because every occurrence already written carries the
// revision that produced it and a replay of those rows must be able to ask for
// revision 2 and get the same projection it got the first time. Backfilling
// them to revision 3 would be a claim about the past that revision 3 did not
// make.
//
// This module validates the SHAPE of every vendored artefact at boot. A
// malformed or unrecognised map is a startup failure, not a silent fallback:
// the whole point of DAT-006 is that no import may quietly default a status it
// does not understand, and a loader that shrugged and carried on would
// reintroduce exactly that.

import type { TaskStatus } from '@muneral/types';
import rawStatusMapRev2 from './status-map-v1-rev2.json';
import rawStatusMapRev3 from './status-map-v1-rev3.json';

/** The schema this loader is written against. A different schema is refused. */
export const STATUS_MAP_SCHEMA = 'HistoricalStatusMap/v1';

/** The statuses Muneral itself knows. The map may not project onto anything
 *  outside this set — the projection targets an existing vocabulary, it never
 *  extends one. `archived` joined the vocabulary in MUN-0043; it is declared
 *  here because the type in `@muneral/types` declares it, not the other way
 *  round. */
const TASK_STATUSES: readonly TaskStatus[] = [
  'todo',
  'in_progress',
  'review',
  'blocked',
  'done',
  'cancelled',
  'archived',
];

/** The only projections a historical completion ASSERTION may accompany.
 *
 *  `done` says the work was completed; `archived` says the card left the board
 *  after the source asserted it was finished. Both are assertions about the
 *  past that this path never re-verifies (I14). Every other status describes
 *  work that is not claimed finished at all, so `asserted_done` there is a
 *  contradiction the occurrence would carry forever. */
const ASSERTION_BEARING_STATUSES: readonly TaskStatus[] = ['done', 'archived'];

export interface StatusMapEntry {
  /** The Muneral status this raw value projects onto. */
  readonly muneral: TaskStatus;
  /** Whether the SOURCE asserted completion. Never a fresh verdict. */
  readonly asserted_done: boolean;
  /** The contract's own note, carried for documentation and readback. */
  readonly note?: string;
}

export interface HistoricalStatusMapArtefact {
  readonly schema: string;
  readonly revision: number;
  readonly muneral_statuses: readonly string[];
  readonly map: Readonly<Record<string, StatusMapEntry>>;
}

export class StatusMapError extends Error {
  constructor(reason: string) {
    super(`historical status map is unusable: ${reason}`);
    this.name = 'StatusMapError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate the vendored artefact and return it typed.
 *
 * Exported (rather than only invoked on the module's own JSON) so the tests can
 * feed it deliberately broken artefacts and prove each refusal, instead of
 * asserting only that the good one loads.
 */
export function loadStatusMap(candidate: unknown): HistoricalStatusMapArtefact {
  if (!isRecord(candidate)) throw new StatusMapError('it is not a JSON object');

  if (candidate.schema !== STATUS_MAP_SCHEMA) {
    throw new StatusMapError(
      `schema is ${JSON.stringify(candidate.schema)}, expected ${JSON.stringify(STATUS_MAP_SCHEMA)}`,
    );
  }

  const revision = candidate.revision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    throw new StatusMapError(`revision ${JSON.stringify(revision)} is not a positive integer`);
  }

  const declared = candidate.muneral_statuses;
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new StatusMapError('muneral_statuses is missing or empty');
  }
  // muneral_statuses ⊆ TaskStatus. A contract that named a seventh status would
  // be describing a Muneral this build does not have.
  for (const status of declared) {
    if (typeof status !== 'string' || !TASK_STATUSES.includes(status as TaskStatus)) {
      throw new StatusMapError(
        `muneral_statuses contains ${JSON.stringify(status)}, which is not a Muneral TaskStatus`,
      );
    }
  }

  const map = candidate.map;
  if (!isRecord(map) || Object.keys(map).length === 0) {
    throw new StatusMapError('map is missing or empty');
  }

  const entries: Record<string, StatusMapEntry> = {};
  for (const [raw, entry] of Object.entries(map)) {
    if (!isRecord(entry)) {
      throw new StatusMapError(`entry ${JSON.stringify(raw)} is not an object`);
    }
    const target = entry.muneral;
    if (typeof target !== 'string' || !TASK_STATUSES.includes(target as TaskStatus)) {
      throw new StatusMapError(
        `entry ${JSON.stringify(raw)} projects onto ${JSON.stringify(target)}, which is not a Muneral TaskStatus`,
      );
    }
    // Declared but unreachable: an entry may only target a status the contract
    // itself lists, otherwise `muneral_statuses` documents something narrower
    // than the map performs.
    if (!declared.includes(target)) {
      throw new StatusMapError(
        `entry ${JSON.stringify(raw)} projects onto ${JSON.stringify(target)}, which muneral_statuses does not declare`,
      );
    }
    if (typeof entry.asserted_done !== 'boolean') {
      throw new StatusMapError(`entry ${JSON.stringify(raw)} has no boolean asserted_done`);
    }
    // Keys are looked up post-normalisation, so a key that does not survive its
    // own normalisation could never be hit — a dead row in a contract whose
    // purpose is exhaustiveness.
    if (normalizeRawStatus(raw) !== raw) {
      throw new StatusMapError(
        `key ${JSON.stringify(raw)} is not in normalised form and could never be matched`,
      );
    }
    // `asserted_done` may only be set where the projection can bear the
    // assertion (`done` or, since revision 3, `archived`). Asserting completion
    // for a card that lands anywhere else is a contradiction the occurrence
    // would carry forever.
    if (entry.asserted_done && !ASSERTION_BEARING_STATUSES.includes(target as TaskStatus)) {
      throw new StatusMapError(
        `entry ${JSON.stringify(raw)} asserts done while projecting onto ${JSON.stringify(target)}`,
      );
    }
    entries[raw] = {
      muneral: target as TaskStatus,
      asserted_done: entry.asserted_done,
      ...(typeof entry.note === 'string' ? { note: entry.note } : {}),
    };
  }

  return {
    schema: candidate.schema,
    revision,
    muneral_statuses: declared as readonly string[],
    map: Object.freeze(entries),
  };
}

/**
 * Normalise a raw status for LOOKUP only.
 *
 * NFC first, so two byte sequences that render identically compare identically;
 * then trim; then casefold. `toLowerCase` is deliberately locale-independent
 * (`toLocaleLowerCase` would fold Turkish dotted I differently depending on the
 * container's locale, making the projection environment-dependent).
 *
 * The result is NEVER stored. The raw string is kept verbatim on the occurrence
 * — that is the whole audit trail.
 */
export function normalizeRawStatus(raw: string): string {
  return raw.normalize('NFC').trim().toLowerCase();
}

/**
 * Every vendored revision, validated at module load — i.e. at boot. A build
 * that ships a broken artefact for ANY revision it claims to support fails to
 * start, rather than discovering the breakage the first time something asks to
 * replay that revision.
 *
 * Exported, like `loadStatusMap`, so the tests can hand it a deliberately
 * broken SET — two artefacts claiming one revision — and prove the refusal,
 * instead of only asserting that the good set loads.
 */
export function buildStatusMapRegistry(
  artefacts: readonly unknown[],
): ReadonlyMap<number, HistoricalStatusMapArtefact> {
  const registry = new Map<number, HistoricalStatusMapArtefact>();
  for (const candidate of artefacts) {
    const artefact = loadStatusMap(candidate);
    const existing = registry.get(artefact.revision);
    if (existing) {
      throw new StatusMapError(
        `two vendored artefacts both declare revision ${artefact.revision}`,
      );
    }
    registry.set(artefact.revision, artefact);
  }
  return registry;
}

export const STATUS_MAP_REVISIONS: ReadonlyMap<number, HistoricalStatusMapArtefact> =
  buildStatusMapRegistry([rawStatusMapRev2, rawStatusMapRev3]);

/** The revision this build applies when the caller does not name one. The
 *  highest vendored revision, computed rather than written down, so adding an
 *  artefact cannot leave the current revision pointing at the previous one. */
export const STATUS_MAP_REVISION: number = Math.max(...STATUS_MAP_REVISIONS.keys());

/** The artefact for the current revision. */
export const STATUS_MAP: HistoricalStatusMapArtefact = STATUS_MAP_REVISIONS.get(
  STATUS_MAP_REVISION,
) as HistoricalStatusMapArtefact;

/** Every revision this build can project with, ascending. */
export const SUPPORTED_STATUS_MAP_REVISIONS: readonly number[] = [
  ...STATUS_MAP_REVISIONS.keys(),
].sort((a, b) => a - b);

/**
 * The artefact for one revision, or `undefined` when this build does not carry
 * it. `undefined` is deliberate: a replay that asks for a revision the image
 * does not hold must be a typed refusal at the call site, never a silent
 * fallback onto the current revision — that would relabel a revision-2 row as
 * revision 3 and lose the only record of how it was actually projected.
 */
export function statusMapForRevision(
  revision: number,
): HistoricalStatusMapArtefact | undefined {
  return STATUS_MAP_REVISIONS.get(revision);
}
