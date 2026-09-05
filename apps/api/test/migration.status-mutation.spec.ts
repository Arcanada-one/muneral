// MUN-0041: a mutation battery for the status projection.
//
// The suite in `migration.status.spec.ts` asserts what the mapper does. This
// one asserts that those assertions BITE: each mutant below is a plausible way
// the map could stop being applied — including the exact regression this task
// exists to remove, MUN-0040's hard-coded six-status lookup — and every one of
// them must make that suite fail. A green suite over a mapper that ignores the
// map is worth nothing, and 1,309 archive cards are riding on the difference.
//
// Mechanics follow `test/assembly/mutation-harness.js`: the source is copied
// aside, mutated in place, the target suite is run in a child process, and the
// original is restored — including from an `afterAll` and a process-exit hook,
// so an interrupted run cannot leave a mutant on disk. `pnpm test` runs
// `--runInBand`, so no other suite is executing while a file is mutated.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

jest.setTimeout(600_000);

const API_ROOT = path.resolve(__dirname, '..');
const MAPPER = path.join(API_ROOT, 'src', 'migration', 'migration.status.ts');
const LOADER = path.join(API_ROOT, 'src', 'migration', 'status-map', 'status-map.ts');
const ARTEFACT_REV3 = path.join(
  API_ROOT, 'src', 'migration', 'status-map', 'status-map-v1-rev3.json',
);
// MUN-0043: two suites, because the behaviour under test now spans two
// revisions — `migration.status.spec.ts` pins revision 2 (the replay guarantee)
// and `status-map-rev3.spec.ts` pins revision 3 (archived is not done). A
// mutant that only one of them can see is still killed.
const TARGET_SUITES = ['test/migration.status.spec.ts', 'test/status-map-rev3.spec.ts'];

interface Mutant {
  /** What the mutation represents — the way the map could stop being applied. */
  readonly name: string;
  readonly file: string;
  readonly from: string;
  readonly to: string;
}

const MUTANTS: readonly Mutant[] = [
  {
    // The brief's named mutant: the lookup is gone, everything is unmapped.
    name: 'the map lookup is dropped entirely',
    file: MAPPER,
    from: 'const entry = artefact.map[normalizeRawStatus(raw)];',
    to: 'const entry = undefined as undefined | (typeof artefact.map)[string];',
  },
  {
    // The regression this task removes: MUN-0040's six hard-coded statuses.
    name: 'the map lookup reverts to the hard-coded six statuses',
    file: MAPPER,
    from: 'const entry = artefact.map[normalizeRawStatus(raw)];',
    to:
      "const entry = (['todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled'] as string[])\n" +
      "    .includes(normalizeRawStatus(raw))\n" +
      "    ? { muneral: normalizeRawStatus(raw) as TaskStatus, asserted_done: normalizeRawStatus(raw) === 'done' }\n" +
      '    : undefined;',
  },
  {
    // MUN-0040's assertion rule: only a literal `done` asserts completion, so
    // `archived`, `completed` and `done_pending_archive` stop asserting.
    name: 'completion is asserted only for a literal done',
    file: MAPPER,
    from: 'historicalAssertedDone: entry ? entry.asserted_done : false,',
    to: "historicalAssertedDone: normalizeRawStatus(raw) === 'done',",
  },
  {
    name: 'the normalised value is stored instead of the raw string',
    file: MAPPER,
    from: 'historicalStatus: raw,',
    to: 'historicalStatus: normalizeRawStatus(raw),',
  },
  {
    name: 'normalisation is skipped before the lookup',
    file: MAPPER,
    from: 'const entry = artefact.map[normalizeRawStatus(raw)];',
    to: 'const entry = artefact.map[raw];',
  },
  {
    name: 'nothing is ever flagged unmapped',
    file: MAPPER,
    from: 'unmapped: entry === undefined,',
    to: 'unmapped: false,',
  },
  {
    name: 'the recorded revision is not the one that was applied',
    file: MAPPER,
    from: 'statusMapRevision: artefact.revision,',
    to: 'statusMapRevision: 0,',
  },
  {
    name: 'an unmapped value falls back to something plausible instead of todo',
    file: MAPPER,
    from: "taskStatus: entry ? entry.muneral : ('todo' as TaskStatus),",
    to: "taskStatus: entry ? entry.muneral : ('in_progress' as TaskStatus),",
  },
  {
    name: 'the loader accepts a projection target Muneral does not have',
    file: LOADER,
    from: '    const target = entry.muneral;\n    if (typeof target !== \'string\' || !TASK_STATUSES.includes(target as TaskStatus)) {',
    to: '    const target = entry.muneral;\n    if (typeof target !== \'string\' || false) {',
  },
  {
    name: 'the loader accepts any schema it is handed',
    file: LOADER,
    from: '  if (candidate.schema !== STATUS_MAP_SCHEMA) {',
    to: '  if (false) {',
  },
  {
    name: 'the loader accepts a completion assertion on a card that is not done',
    file: LOADER,
    from:
      '    if (entry.asserted_done && !ASSERTION_BEARING_STATUSES.includes(target as TaskStatus)) {',
    to: '    if (false) {',
  },
  {
    // MUN-0043's headline claim. If `archived` projects onto `done` again, the
    // 1,340 archive cards are once more asserted complete by a status nobody
    // re-verified, which is the totalisation DEC-AUP-0014 rule 3 removed.
    name: 'the revision 3 artefact projects archived back onto done',
    file: ARTEFACT_REV3,
    from: '"muneral": "archived"',
    to: '"muneral": "done"',
  },
  {
    // The replay guarantee. If a pinned revision is ignored, an occurrence
    // written under revision 2 replays under today's map and silently changes
    // the answer it originally recorded.
    name: 'a pinned revision is ignored and the current map is used anyway',
    file: MAPPER,
    from: '    revision === undefined ? STATUS_MAP : statusMapForRevision(revision);',
    to: '    STATUS_MAP;',
  },
  {
    // The current revision must be derived from what is vendored, not written
    // down: a hard-coded 2 would leave a build that ships revision 3 still
    // projecting with revision 2 and stamping every occurrence with it.
    name: 'the current revision is hard-coded instead of derived from the vendored set',
    file: LOADER,
    from: 'export const STATUS_MAP_REVISION: number = Math.max(...STATUS_MAP_REVISIONS.keys());',
    to: 'export const STATUS_MAP_REVISION: number = 2;',
  },
  {
    // Any status may bear a completion assertion — the invariant that keeps an
    // occurrence from claiming `blocked` work was finished.
    name: 'the loader lets any status bear a completion assertion',
    file: LOADER,
    from: "const ASSERTION_BEARING_STATUSES: readonly TaskStatus[] = ['done', 'archived'];",
    to: 'const ASSERTION_BEARING_STATUSES: readonly TaskStatus[] = TASK_STATUSES;',
  },
  {
    name: 'the loader accepts a key its own normalisation could never match',
    file: LOADER,
    from: '    if (normalizeRawStatus(raw) !== raw) {',
    to: '    if (false) {',
  },
];

function runTargetSuite(): { status: number | null; output: string } {
  const result = spawnSync(
    process.execPath,
    [
      path.join(API_ROOT, 'node_modules', 'jest', 'bin', 'jest.js'),
      '--runInBand',
      '--ci',
      ...TARGET_SUITES,
    ],
    { cwd: API_ROOT, encoding: 'utf8', env: { ...process.env, CI: 'true' } },
  );
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

describe('status projection mutation battery', () => {
  const originals = new Map<string, string>();
  let restore: () => void;

  beforeAll(() => {
    for (const file of new Set(MUTANTS.map((m) => m.file))) {
      originals.set(file, fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(`${file}.pristine`, originals.get(file) as string);
    }
    restore = () => {
      for (const [file, source] of originals) {
        if (fs.readFileSync(file, 'utf8') !== source) fs.writeFileSync(file, source);
        if (fs.existsSync(`${file}.pristine`)) fs.unlinkSync(`${file}.pristine`);
      }
    };
    process.on('exit', restore);
  });

  afterAll(() => {
    restore();
    process.removeListener('exit', restore);
  });

  afterEach(() => {
    for (const [file, source] of originals) {
      if (fs.readFileSync(file, 'utf8') !== source) fs.writeFileSync(file, source);
    }
  });

  it('passes against the unmutated source', () => {
    // Without this, every "killed" verdict below could be a failure the mutant
    // had nothing to do with.
    const baseline = runTargetSuite();
    if (baseline.status !== 0) {
      throw new Error(
        `baseline ${TARGET_SUITES.join(' + ')} does not pass:\n${baseline.output.slice(-4000)}`,
      );
    }
  });

  it.each(MUTANTS.map((m) => [m.name, m] as const))('kills the mutant where %s', (_name, mutant) => {
    const source = originals.get(mutant.file) as string;
    const occurrences = source.split(mutant.from).length - 1;
    // A mutation that does not apply is a mutation that proves nothing; a
    // refactor that moves the line must be noticed here rather than silently
    // turning this battery into a no-op.
    expect(occurrences).toBe(1);

    fs.writeFileSync(mutant.file, source.replace(mutant.from, mutant.to));
    const mutated = runTargetSuite();
    fs.writeFileSync(mutant.file, source);

    // Either the suite fails or the compiler refuses the mutant. Both are
    // kills; surviving means the projection is not actually pinned down.
    if (mutated.status === 0) {
      throw new Error(
        `mutant SURVIVED (${mutant.name}) — ${TARGET_SUITES.join(' + ')} passed against it:\n` +
          `${mutant.from}\n  ->\n${mutant.to}`,
      );
    }
  });
});
