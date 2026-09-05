// MUN-0043 (DEC-AUP-0014 rule 3): `archived` stops being a synonym for `done`,
// and revision 2 stays loadable so the rows that were written under it can be
// replayed exactly.
//
// The two claims are separable and both are tested here:
//
//   * revision 3 is what this build applies by default, and it projects
//     `archived` onto `archived` — an archive card records that a card LEFT THE
//     BOARD, which is terminal and unverified, not completed;
//   * revision 2 is still vendored, byte-for-byte, and asking for it reproduces
//     the projection it produced during the MUN-0041 import (2,726 occurrences,
//     1,340 of them archive cards). `migration.status.spec.ts` holds that side.
//
// Expectations are written out longhand rather than read off the artefact under
// test: a test that loops over `STATUS_MAP.map` proves only that the artefact
// equals itself, and would pass against a map that had been edited.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  mapHistoricalStatus,
  NOT_REVALIDATED,
  UnknownStatusMapRevisionError,
} from '../src/migration/migration.status';
import {
  STATUS_MAP,
  STATUS_MAP_REVISION,
  STATUS_MAP_REVISIONS,
  SUPPORTED_STATUS_MAP_REVISIONS,
  StatusMapError,
  buildStatusMapRegistry,
  loadStatusMap,
  statusMapForRevision,
} from '../src/migration/status-map/status-map';

const DIR = join(__dirname, '../src/migration/status-map');
const REV2_FILE = join(DIR, 'status-map-v1-rev2.json');
const REV3_FILE = join(DIR, 'status-map-v1-rev3.json');

/**
 * Revision 3 in full. Identical to revision 2 except for the single row this
 * task exists to change, which is why the whole table is repeated rather than
 * derived from revision 2 with a patch applied: the claim "only `archived`
 * moved" is worth nothing if the baseline it is measured against is itself
 * computed from the thing under test.
 */
const CONTRACT_ROWS_REV3: ReadonlyArray<[raw: string, muneral: string, assertedDone: boolean]> = [
  ['todo', 'todo', false],
  ['pending', 'todo', false],
  ['open', 'todo', false],
  ['planned', 'todo', false],
  ['in_progress', 'in_progress', false],
  ['prd_done', 'in_progress', false],
  ['review', 'review', false],
  ['blocked', 'blocked', false],
  ['paused', 'blocked', false],
  ['deferred', 'blocked', false],
  ['done', 'done', true],
  ['archived', 'archived', true],
  ['done_pending_archive', 'done', true],
  ['cancelled', 'cancelled', false],
  ['withdrawn', 'cancelled', false],
  ['superseded', 'cancelled', false],
  ['absorbed', 'cancelled', false],
  ['active', 'in_progress', false],
  ['backlog', 'todo', false],
  ['not_started', 'todo', false],
  ['completed', 'done', true],
  ['absent', 'todo', false],
  ['unknown', 'todo', false],
];

/**
 * The canonicalisation the program contract names for `semantic_core_sha256`:
 * sha256 over UTF-8 of the compact, key-sorted JSON of the four fields the
 * loader actually reads. Non-ASCII characters stay as themselves (no \uXXXX
 * escaping) — the recipe has to be written down somewhere executable, or the
 * digest in the contract is a number nobody can reproduce.
 */
function canonicalise(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function semanticCore(artefactJson: Record<string, unknown>): string {
  const core = {
    schema: artefactJson.schema,
    revision: artefactJson.revision,
    muneral_statuses: artefactJson.muneral_statuses,
    map: artefactJson.map,
  };
  return createHash('sha256').update(canonicalise(core), 'utf8').digest('hex');
}

const rev2OnDisk = JSON.parse(readFileSync(REV2_FILE, 'utf8')) as Record<string, unknown>;
const rev3OnDisk = JSON.parse(readFileSync(REV3_FILE, 'utf8')) as Record<string, unknown>;

describe('the vendored revision set', () => {
  it('carries revisions 2 and 3, and nothing else', () => {
    expect(SUPPORTED_STATUS_MAP_REVISIONS).toEqual([2, 3]);
    expect([...STATUS_MAP_REVISIONS.keys()].sort((a, b) => a - b)).toEqual([2, 3]);
  });

  it('applies revision 3 by default', () => {
    expect(STATUS_MAP_REVISION).toBe(3);
    expect(STATUS_MAP.revision).toBe(3);
    expect(statusMapForRevision(3)).toBe(STATUS_MAP);
  });

  it('still holds revision 2 for replay', () => {
    const rev2 = statusMapForRevision(2);
    expect(rev2).toBeDefined();
    expect(rev2?.revision).toBe(2);
    // Revision 2's own answer, unchanged: this is the whole reason it is kept.
    expect(rev2?.map.archived).toEqual({
      muneral: 'done',
      asserted_done: true,
      note: expect.any(String),
    });
  });

  it('has no revision it does not carry', () => {
    for (const missing of [0, 1, 4, 99, -3, 2.5]) {
      expect(statusMapForRevision(missing)).toBeUndefined();
    }
  });

  it('refuses a set in which two artefacts claim one revision', () => {
    // Not reachable through the vendored set, so it is proved against the
    // builder directly: a build in which "revision 3" means two different maps
    // depending on import order would otherwise fail silently, by picking one.
    const a = JSON.parse(readFileSync(REV3_FILE, 'utf8'));
    const b = JSON.parse(readFileSync(REV3_FILE, 'utf8'));
    b.map.todo = { muneral: 'in_progress', asserted_done: false };

    expect(() => buildStatusMapRegistry([a, b])).toThrow(StatusMapError);
    expect(() => buildStatusMapRegistry([a, b])).toThrow(/both declare revision 3/);
    // The honest pair still builds.
    expect(buildStatusMapRegistry([rev2OnDisk, a]).size).toBe(2);
  });
});

describe('revision 3 — archived is not done', () => {
  it('declares archived among the Muneral statuses', () => {
    expect([...STATUS_MAP.muneral_statuses].sort()).toEqual([
      'archived',
      'blocked',
      'cancelled',
      'done',
      'in_progress',
      'review',
      'todo',
    ]);
  });

  it.each(CONTRACT_ROWS_REV3)(
    'projects the raw status %s onto %s (asserted done: %s)',
    (raw, muneral, assertedDone) => {
      expect(mapHistoricalStatus(raw)).toEqual({
        taskStatus: muneral,
        historicalStatus: raw,
        historicalAssertedDone: assertedDone,
        currentVerification: NOT_REVALIDATED,
        unmapped: false,
        statusMapRevision: 3,
      });
    },
  );

  it('carries all 23 observed raw statuses and no others', () => {
    expect(Object.keys(STATUS_MAP.map).sort()).toEqual(
      CONTRACT_ROWS_REV3.map(([raw]) => raw).sort(),
    );
    expect(Object.keys(STATUS_MAP.map)).toHaveLength(23);
  });

  it('projects archived onto archived, never onto done', () => {
    for (const raw of ['archived', 'Archived', '  ARCHIVED  ']) {
      const mapped = mapHistoricalStatus(raw);
      expect(mapped.taskStatus).toBe('archived');
      expect(mapped.taskStatus).not.toBe('done');
      // The raw string still survives byte for byte.
      expect(mapped.historicalStatus).toBe(raw);
    }
  });

  it('keeps the source assertion that revision 3 no longer projects as done', () => {
    // The two facts are separate: the SOURCE asserted completion when it filed
    // the archive card, and the projection refuses to restate that as a Muneral
    // `done`. Dropping the assertion would lose the audit trail; keeping the
    // projection would keep the totalisation. MUN-0043 does neither.
    const mapped = mapHistoricalStatus('archived');
    expect(mapped.historicalAssertedDone).toBe(true);
    expect(mapped.currentVerification).toBe(NOT_REVALIDATED);
    expect(mapped.taskStatus).toBe('archived');
  });

  it('asserts completion for exactly the four raw values, as before', () => {
    const asserting = CONTRACT_ROWS_REV3
      .filter(([raw]) => mapHistoricalStatus(raw).historicalAssertedDone)
      .map(([raw]) => raw)
      .sort();
    expect(asserting).toEqual(['archived', 'completed', 'done', 'done_pending_archive']);
  });

  it('leaves `done` meaning done — only the archive card moved', () => {
    for (const raw of ['done', 'done_pending_archive', 'completed']) {
      expect(mapHistoricalStatus(raw).taskStatus).toBe('done');
    }
  });

  it('changes exactly one row against revision 2', () => {
    const rev2 = statusMapForRevision(2)!;
    const differing = Object.keys(STATUS_MAP.map).filter(
      (raw) => STATUS_MAP.map[raw].muneral !== rev2.map[raw]?.muneral,
    );
    expect(differing).toEqual(['archived']);
    // ...and no row was added or removed while doing it.
    expect(Object.keys(STATUS_MAP.map).sort()).toEqual(Object.keys(rev2.map).sort());
  });

  it('still parks an unknown value in todo and flags it', () => {
    expect(mapHistoricalStatus('frobnicated')).toEqual({
      taskStatus: 'todo',
      historicalStatus: 'frobnicated',
      historicalAssertedDone: false,
      currentVerification: NOT_REVALIDATED,
      unmapped: true,
      statusMapRevision: 3,
    });
  });
});

describe('projecting under a named revision', () => {
  it('reproduces revision 2 for an occurrence written under revision 2', () => {
    expect(mapHistoricalStatus('archived', 2)).toEqual({
      taskStatus: 'done',
      historicalStatus: 'archived',
      historicalAssertedDone: true,
      currentVerification: NOT_REVALIDATED,
      unmapped: false,
      statusMapRevision: 2,
    });
  });

  it('gives the same answer as the default when revision 3 is named explicitly', () => {
    for (const [raw] of CONTRACT_ROWS_REV3) {
      expect(mapHistoricalStatus(raw, 3)).toEqual(mapHistoricalStatus(raw));
    }
  });

  it('refuses a revision this build does not carry, instead of falling back', () => {
    for (const missing of [0, 1, 4, 99]) {
      expect(() => mapHistoricalStatus('archived', missing)).toThrow(
        UnknownStatusMapRevisionError,
      );
    }
    // The refusal names what IS available, so an importer can act on it.
    expect(() => mapHistoricalStatus('archived', 7)).toThrow(/revision 7 is not vendored/);
    expect(() => mapHistoricalStatus('archived', 7)).toThrow(/available: 2, 3/);
  });

  it('never answers a pinned revision with a different one', () => {
    for (const revision of [2, 3]) {
      for (const [raw] of CONTRACT_ROWS_REV3) {
        expect(mapHistoricalStatus(raw, revision).statusMapRevision).toBe(revision);
      }
    }
  });
});

describe('the loader under revision 3', () => {
  it('accepts a completion assertion on archived, and still refuses it elsewhere', () => {
    const artefact = JSON.parse(readFileSync(REV3_FILE, 'utf8'));
    expect(() => loadStatusMap(artefact)).not.toThrow();

    artefact.map.blocked = { muneral: 'blocked', asserted_done: true };
    expect(() => loadStatusMap(artefact)).toThrow(StatusMapError);
    expect(() => loadStatusMap(artefact)).toThrow(/asserts done while projecting/);
  });

  it('refuses a revision-3 artefact that forgets to declare archived', () => {
    const artefact = JSON.parse(readFileSync(REV3_FILE, 'utf8'));
    artefact.muneral_statuses = (artefact.muneral_statuses as string[]).filter(
      (s: string) => s !== 'archived',
    );
    expect(() => loadStatusMap(artefact)).toThrow(/muneral_statuses does not declare/);
  });
});

describe('vendoring parity with the program contract', () => {
  // The artefacts are byte-identical copies of
  // `arcanada-universal-program/contracts/status-mapping/status-map-v1-rev<N>.json`.
  // These digests are what the program's own receipt records, so a drifting
  // copy fails here rather than at the next import.
  it('pins revision 2 to the bytes MUN-0041 vendored', () => {
    expect(createHash('sha256').update(readFileSync(REV2_FILE)).digest('hex')).toBe(
      '8ea5bc468328083d618e51561fb4606251fd72b99a55fa3b3b5b77af021e8414',
    );
    expect(semanticCore(rev2OnDisk)).toBe(
      '48c04f4d8923d97628e620b541b299b9abee7460f08da12353cafad5d6e487f3',
    );
  });

  it('pins revision 3 to the bytes MUN-0043 vendored', () => {
    expect(createHash('sha256').update(readFileSync(REV3_FILE)).digest('hex')).toBe(
      'a57044b1a4607584183eafb64716372f8b1890ae361457425c90abe4e25972b6',
    );
    expect(semanticCore(rev3OnDisk)).toBe(
      '0d5efdb161e33a04e80e43d25f3b440d090df20773f78f6c613870a2e4952ba7',
    );
  });

  it('keeps each artefact traceable to the task that issued it', () => {
    expect(rev2OnDisk.revision).toBe(2);
    expect(rev2OnDisk.task).toContain('AUP-DAT-006');
    expect(rev3OnDisk.revision).toBe(3);
    expect(rev3OnDisk.task).toContain('MUN-0043');
    expect(Array.isArray(rev3OnDisk.negative_controls)).toBe(true);
    expect(String(rev3OnDisk.revision_note)).toContain('DEC-AUP-0014');
  });
});
