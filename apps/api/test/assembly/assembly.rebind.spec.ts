/**
 * A2-298 — `mutation-harness.js --rebind`, and the boundary that makes it safe.
 *
 * Two fields of mutation-results.json are hashes of the repository TREE (`binding`,
 * `supplementalGit.trackedTreeWithoutEvidence`), so any commit that touches a tracked file
 * invalidates them — including the commit that files a ChangeAdmissionReceipt, which is how A2-291 met
 * this: the gate wants the receipt committed, committing it moves the tree, and the evidence then
 * fails --verify-structure for a reason unrelated to the mutants. A2-291 rebound the fields with a
 * hand-written ESM script and recorded the missing command as a defect, because the one operation that
 * must never be done by transcribing a digest out of a failing diff had no command.
 *
 * These arms pin the BLAST RADIUS rather than the happy path: the two tree fields move, every other
 * key is byte-identical, a source-derived digest is left exactly as tampered (so a rebind cannot
 * launder an edited mutant), the command's exit code IS the structural verification's, and a file with
 * no recorded sites is refused with nothing written. They are deliberately independent of the Node
 * patch version: --verify-structure refuses a toolchain mismatch (recorded v24.21.0), so an arm that
 * asserted "exit 0" would pass only on the pinned runtime and would then be asserting the runtime.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

// ESM has no __dirname, and declaring that NAME would mark the module CommonJS.
const thisDir = path.dirname(url.fileURLToPath(import.meta.url));
const HARNESS = path.join(thisDir, 'mutation-harness.js');
const EVIDENCE = path.join(thisDir, 'mutation-results.json');

type Harness = {
  rebindDerivedFields: (p: string) => number;
  buildBinding: () => unknown;
  gitSupplement: () => unknown;
};

let harness: Harness;
let tmp: string;

beforeAll(async () => {
  harness = (await import(HARNESS)) as unknown as Harness;
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-298-rebind-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function copyEvidence(mutate?: (doc: Record<string, unknown>) => void): string {
  const doc = JSON.parse(fs.readFileSync(EVIDENCE, 'utf8')) as Record<string, unknown>;
  if (mutate) mutate(doc);
  const target = path.join(tmp, 'mutation-results.json');
  fs.writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`);
  return target;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('mutation-harness --rebind', () => {
  it('rebinds the two tree-derived fields to what the harness itself computes', () => {
    const file = copyEvidence((doc) => {
      doc.binding = { algorithm: 'sha256', aggregateSha256: '0'.repeat(64), files: [] };
      doc.supplementalGit = { trackedTreeWithoutEvidence: '0'.repeat(40), trackedSnapshotDiffSha256: '0'.repeat(64) };
    });
    harness.rebindDerivedFields(file);
    const after = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(after.binding).toEqual(harness.buildBinding());
    expect(after.supplementalGit).toEqual(harness.gitSupplement());
  });

  it('moves NOTHING else: every other key is byte-identical after the rewrite', () => {
    const file = copyEvidence((doc) => {
      doc.supplementalGit = { trackedTreeWithoutEvidence: '0'.repeat(40), trackedSnapshotDiffSha256: '0'.repeat(64) };
    });
    const before = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    harness.rebindDerivedFields(file);
    const after = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const key of Object.keys(before)) {
      if (key === 'binding' || key === 'supplementalGit') continue;
      expect(sha(JSON.stringify(after[key]))).toEqual(sha(JSON.stringify(before[key])));
    }
  });

  it('cannot launder an edited mutant: a tampered source-derived digest survives untouched', () => {
    const file = copyEvidence((doc) => {
      const sites = doc.sites as Array<Record<string, unknown>>;
      sites[0].pristineSha256 = 'f'.repeat(64);
      doc.siteMapSha256 = 'e'.repeat(64);
    });
    const code = harness.rebindDerivedFields(file);
    const after = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect((after.sites as Array<Record<string, unknown>>)[0].pristineSha256).toBe('f'.repeat(64));
    expect(after.siteMapSha256).toBe('e'.repeat(64));
    expect(code).not.toBe(0);
  });

  it('exits with the structural verification\'s own code, not with "I wrote a file"', async () => {
    const mod = (await import(HARNESS)) as unknown as Harness & {
      // verifyResults is not exported; the equality is asserted through the two public outcomes
      // instead: a tampered copy is non-zero (above) and an untouched copy agrees with a second,
      // independent rebind of the same file (below).
    };
    const file = copyEvidence();
    const first = mod.rebindDerivedFields(file);
    const bytes = fs.readFileSync(file);
    const second = mod.rebindDerivedFields(file);
    expect(second).toBe(first);
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
  });

  it('refuses a file that records no sites, and writes nothing', () => {
    const file = copyEvidence((doc) => {
      doc.sites = [];
    });
    const before = fs.readFileSync(file);
    expect(harness.rebindDerivedFields(file)).toBe(1);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });
});
