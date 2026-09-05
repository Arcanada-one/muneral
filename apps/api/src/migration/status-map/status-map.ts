// MUN-0041 (AUP-DAT-006, review X-08): the raw-status → Muneral-status mapping
// is a VERSIONED ARTEFACT, not an implicit default buried in a switch.
//
// `status-map-v1.json` in this directory is a byte-identical vendored copy of
// the program's contract file
// (`arcanada-universal-program/contracts/status-mapping/status-map-v1.json`).
// It is vendored rather than fetched so that the projection an import performs
// is pinned to the deployed artefact and can be reproduced from the image
// alone; `revision` is the provenance token recorded on every occurrence.
//
// This module validates the artefact's SHAPE at boot. A malformed or
// unrecognised map is a startup failure, not a silent fallback: the whole point
// of DAT-006 is that no import may quietly default a status it does not
// understand, and a loader that shrugged and carried on would reintroduce
// exactly that.

import type { TaskStatus } from '@muneral/types';
import rawStatusMap from './status-map-v1.json';

/** The schema this loader is written against. A different schema is refused. */
export const STATUS_MAP_SCHEMA = 'HistoricalStatusMap/v1';

/** The six statuses Muneral itself knows. The map may not project onto
 *  anything outside this set — the projection targets an existing vocabulary,
 *  it never extends one. */
const TASK_STATUSES: readonly TaskStatus[] = [
  'todo',
  'in_progress',
  'review',
  'blocked',
  'done',
  'cancelled',
];

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
    // `asserted_done` may only be set where the projection is `done`: asserting
    // completion for a card that lands anywhere else is a contradiction the
    // occurrence would carry forever.
    if (entry.asserted_done && target !== 'done') {
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

/** The vendored artefact, validated at module load — i.e. at boot. */
export const STATUS_MAP: HistoricalStatusMapArtefact = loadStatusMap(rawStatusMap);

/** The revision recorded as provenance on every occurrence this build writes. */
export const STATUS_MAP_REVISION: number = STATUS_MAP.revision;
