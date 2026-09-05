// MUN-0040 (AUP-X03 HistoricalTaskImport) / MUN-0041 (AUP-DAT-006): the rules
// that keep an imported card's past from being restated as a present claim, now
// driven by the versioned HistoricalStatusMap rather than by a hard-coded list.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapHistoricalStatus, NOT_REVALIDATED } from '../src/migration/migration.status';
import {
  STATUS_MAP,
  STATUS_MAP_REVISION,
  STATUS_MAP_SCHEMA,
  StatusMapError,
  loadStatusMap,
  normalizeRawStatus,
} from '../src/migration/status-map/status-map';

const VENDORED = join(__dirname, '../src/migration/status-map/status-map-v1.json');

/**
 * Every raw value the contract at revision 2 carries, with the projection and
 * the completion assertion it demands. Written out longhand rather than looped
 * over `STATUS_MAP.map`, because a test that reads its expectations from the
 * artefact under test proves only that the artefact equals itself: a mutant
 * that swapped `archived` to `todo` in the JSON would pass such a loop.
 */
const CONTRACT_ROWS: ReadonlyArray<[raw: string, muneral: string, assertedDone: boolean]> = [
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
  ['archived', 'done', true],
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

describe('the vendored HistoricalStatusMap artefact', () => {
  it('is the revision 2 contract, at the schema this loader implements', () => {
    expect(STATUS_MAP.schema).toBe(STATUS_MAP_SCHEMA);
    expect(STATUS_MAP_SCHEMA).toBe('HistoricalStatusMap/v1');
    expect(STATUS_MAP_REVISION).toBe(2);
  });

  it('declares exactly the six Muneral statuses and nothing beyond them', () => {
    expect([...STATUS_MAP.muneral_statuses].sort()).toEqual([
      'blocked',
      'cancelled',
      'done',
      'in_progress',
      'review',
      'todo',
    ]);
  });

  it('carries all 23 observed raw statuses and no others', () => {
    expect(Object.keys(STATUS_MAP.map).sort()).toEqual(CONTRACT_ROWS.map(([raw]) => raw).sort());
    expect(Object.keys(STATUS_MAP.map)).toHaveLength(23);
  });

  it('is vendored as parseable JSON that still declares its own provenance', () => {
    // The file is a byte-identical copy of the program's contract; if a future
    // edit strips the fields that make it identifiable, the copy stops being
    // traceable to its source.
    const onDisk = JSON.parse(readFileSync(VENDORED, 'utf8'));
    expect(onDisk.schema).toBe('HistoricalStatusMap/v1');
    expect(onDisk.revision).toBe(2);
    expect(onDisk.task).toContain('AUP-DAT-006');
    expect(Array.isArray(onDisk.negative_controls)).toBe(true);
  });
});

describe('the status-map loader', () => {
  const good = () => JSON.parse(readFileSync(VENDORED, 'utf8'));

  it('accepts the vendored artefact', () => {
    expect(() => loadStatusMap(good())).not.toThrow();
  });

  it.each([
    [
      'a foreign schema',
      (a: Record<string, unknown>) => {
        a.schema = 'HistoricalStatusMap/v2';
      },
      /schema is/,
    ],
    [
      'a non-integer revision',
      (a: Record<string, unknown>) => {
        a.revision = '2';
      },
      /revision/,
    ],
    [
      'revision zero',
      (a: Record<string, unknown>) => {
        a.revision = 0;
      },
      /revision/,
    ],
    [
      'a declared status Muneral does not have',
      (a: Record<string, unknown>) => {
        (a.muneral_statuses as string[]).push('shipped');
      },
      /not a Muneral TaskStatus/,
    ],
    [
      'an entry projecting onto a status Muneral does not have',
      (a: Record<string, unknown>) => {
        (a.map as Record<string, unknown>).todo = { muneral: 'shipped', asserted_done: false };
      },
      /not a Muneral TaskStatus/,
    ],
    [
      'an entry with no boolean assertion',
      (a: Record<string, unknown>) => {
        (a.map as Record<string, unknown>).todo = { muneral: 'todo' };
      },
      /asserted_done/,
    ],
    [
      'a key that its own normalisation would never produce',
      (a: Record<string, unknown>) => {
        (a.map as Record<string, unknown>)['Done '] = { muneral: 'done', asserted_done: true };
      },
      /could never be matched/,
    ],
    [
      'an assertion of completion on a card that is not done',
      (a: Record<string, unknown>) => {
        (a.map as Record<string, unknown>).blocked = { muneral: 'blocked', asserted_done: true };
      },
      /asserts done while projecting/,
    ],
    [
      'an empty map',
      (a: Record<string, unknown>) => {
        a.map = {};
      },
      /map is missing or empty/,
    ],
  ])('refuses %s', (_label, break_, expected) => {
    const artefact = good();
    break_(artefact);
    expect(() => loadStatusMap(artefact)).toThrow(StatusMapError);
    expect(() => loadStatusMap(artefact)).toThrow(expected);
  });

  it('refuses something that is not an object at all', () => {
    for (const candidate of [null, undefined, 42, 'map', []]) {
      expect(() => loadStatusMap(candidate)).toThrow(StatusMapError);
    }
  });
});

describe('normalizeRawStatus', () => {
  it('applies NFC, trim and casefold — and nothing else', () => {
    expect(normalizeRawStatus('  DONE  ')).toBe('done');
    expect(normalizeRawStatus('Done ')).toBe('done');
    expect(normalizeRawStatus('\tIn_Progress\n')).toBe('in_progress');
    // NFC: a decomposed e-acute and its composed form must compare equal.
    expect(normalizeRawStatus('é')).toBe(normalizeRawStatus('é'));
    // No other rewriting: a hyphen does not become an underscore.
    expect(normalizeRawStatus('done-pending-archive')).toBe('done-pending-archive');
  });
});

describe('historical status mapping', () => {
  it.each(CONTRACT_ROWS)(
    'projects the raw status %s onto %s (asserted done: %s)',
    (raw, muneral, assertedDone) => {
      expect(mapHistoricalStatus(raw)).toEqual({
        taskStatus: muneral,
        historicalStatus: raw,
        historicalAssertedDone: assertedDone,
        currentVerification: NOT_REVALIDATED,
        unmapped: false,
        statusMapRevision: 2,
      });
    },
  );

  it('asserts completion for exactly the four raw values the contract says', () => {
    const asserting = CONTRACT_ROWS.filter(([raw]) => mapHistoricalStatus(raw).historicalAssertedDone)
      .map(([raw]) => raw)
      .sort();
    expect(asserting).toEqual(['archived', 'completed', 'done', 'done_pending_archive']);
  });

  it('treats an old done as an assertion about the past, never a fresh verdict', () => {
    for (const raw of ['done', 'archived', 'done_pending_archive', 'completed']) {
      const mapped = mapHistoricalStatus(raw);
      expect(mapped.historicalAssertedDone).toBe(true);
      expect(mapped.currentVerification).toBe(NOT_REVALIDATED);
      expect(mapped.taskStatus).toBe('done');
    }
  });

  it('never asserts done for anything else the map knows', () => {
    for (const [raw, , assertedDone] of CONTRACT_ROWS) {
      if (assertedDone) continue;
      expect(mapHistoricalStatus(raw).historicalAssertedDone).toBe(false);
    }
  });

  // The contract's own negative control.
  it('parks `frobnicated` in todo, flags it unmapped, and keeps the raw string', () => {
    expect(mapHistoricalStatus('frobnicated')).toEqual({
      taskStatus: 'todo',
      historicalStatus: 'frobnicated',
      historicalAssertedDone: false,
      currentVerification: NOT_REVALIDATED,
      unmapped: true,
      statusMapRevision: 2,
    });
  });

  it('flags unmapped only for values the map does not carry', () => {
    for (const [raw] of CONTRACT_ROWS) {
      expect(mapHistoricalStatus(raw).unmapped).toBe(false);
    }
    for (const raw of ['Wontfix-2019', 'frobnicated', '', 'done!', 'выполнено']) {
      expect(mapHistoricalStatus(raw).unmapped).toBe(true);
      expect(mapHistoricalStatus(raw).taskStatus).toBe('todo');
    }
  });

  // The contract's other negative control.
  it('normalizes `Done ` without rewriting what it stores', () => {
    const mapped = mapHistoricalStatus('Done ');
    expect(mapped.taskStatus).toBe('done');
    expect(mapped.historicalAssertedDone).toBe(true);
    expect(mapped.unmapped).toBe(false);
    // The source's own spelling survives for audit — byte for byte.
    expect(mapped.historicalStatus).toBe('Done ');
  });

  it('keeps the raw string verbatim for every shape of input', () => {
    for (const raw of [
      '  DONE  ',
      'Archived',
      'DONE_PENDING_ARCHIVE',
      '\tprd_done\n',
      'Frobnicated ',
      'éclair',
    ]) {
      // Not `toBe(normalizeRawStatus(raw))` — the point is that it is the
      // ORIGINAL, so this must fail if the normalised value were ever stored.
      expect(mapHistoricalStatus(raw).historicalStatus).toBe(raw);
      expect(mapHistoricalStatus(raw).historicalStatus).not.toBe(normalizeRawStatus(raw));
    }
  });

  it('stamps every projection with the revision that produced it', () => {
    for (const raw of ['done', 'archived', 'frobnicated', 'pending']) {
      expect(mapHistoricalStatus(raw).statusMapRevision).toBe(STATUS_MAP_REVISION);
    }
  });

  it('always reports not_revalidated — this path never re-verifies anything', () => {
    for (const raw of ['done', 'archived', 'todo', 'anything-at-all']) {
      expect(mapHistoricalStatus(raw).currentVerification).toBe('not_revalidated');
    }
  });
});
