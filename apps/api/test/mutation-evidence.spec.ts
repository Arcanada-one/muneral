// MUN-0022: the independent evidence verifier must reject every material
// alteration to the source-bound mutation record.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { canonicalJsonV1 } from '../src/execution-authority/canonical-json-v1';

jest.setTimeout(30_000);

const API_ROOT = path.resolve(__dirname, '..');
const HARNESS = path.join(API_ROOT, 'test', 'assembly', 'mutation-harness.js');
const EVIDENCE = path.join(API_ROOT, 'test', 'assembly', 'mutation-results.json');
const SITE_MAP = path.join(API_ROOT, 'test', 'assembly', 'mutation-sites.json');

type Evidence = Record<string, any>;

function verify(file: string) {
  return spawnSync('node', [HARNESS, '--verify-structure', file], {
    cwd: path.resolve(API_ROOT, '..', '..'),
    encoding: 'utf8',
  });
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed in fixture`);
  return result.stdout.trim();
}

describe('Assembly mutation evidence verification', () => {
  let directory: string;
  let original: Evidence;

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mun0022-mutation-evidence-'));
    original = JSON.parse(fs.readFileSync(EVIDENCE, 'utf8')) as Evidence;
  });

  afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('accepts the exact current evidence structure', () => {
    expect(verify(EVIDENCE).status).toBe(0);
  });

  // F9 (REPORT-PROJ-RULE0): the evidence document itself must still satisfy
  // the canonical-JSON constraints (no floats, byte budget) after gaining the
  // toolchain-compatibility fields — that contract does not get relaxed by
  // this fix, only the exact-node-patch fingerprint check does.
  it('satisfies the canonical JSON v1 verifier on the running node', () => {
    expect(() => canonicalJsonV1(original)).not.toThrow();
  });

  // (a) same major/minor, different patch — still the toolchain the evidence
  // is valid FOR.
  it('accepts a node/pnpm record that differs only in patch version', () => {
    const tampered = structuredClone(original);
    const [major, minor, patch] = tampered.tools.node.replace(/^v/, '').split('.').map(Number);
    tampered.tools.node = `v${major}.${minor}.${patch + 1}`;
    const [pnpmMajor, pnpmMinor, pnpmPatch] = tampered.tools.pnpm.split('.').map(Number);
    tampered.tools.pnpm = `${pnpmMajor}.${pnpmMinor}.${pnpmPatch + 1}`;
    const file = path.join(directory, 'same-major-minor-different-patch.json');
    fs.writeFileSync(file, `${JSON.stringify(tampered)}\n`);
    expect(verify(file).status).toBe(0);
  });

  // (b) a different major is outside the recorded compatibility range and
  // must fail with the typed TOOLCHAIN_MISMATCH reason, naming both
  // fingerprints.
  it('rejects a different-major node record as a typed TOOLCHAIN_MISMATCH', () => {
    const tampered = structuredClone(original);
    tampered.tools.node = 'v0.0.0';
    tampered.toolchainCompatibility = { ...tampered.toolchainCompatibility, nodeMajorMinor: '0.0' };
    const file = path.join(directory, 'different-major.json');
    fs.writeFileSync(file, `${JSON.stringify(tampered)}\n`);
    const result = verify(file);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TOOLCHAIN_MISMATCH');
    expect(result.stderr).toContain('v0.0.0');
  });

  // (c) tampered evidence still fails — the toolchain range widens only
  // node/pnpm; jest/typescript stay pinned exact, so a plain tamper of
  // either is still rejected the same as any other field.
  it('still rejects tampered evidence unrelated to the toolchain range', () => {
    const tampered = structuredClone(original);
    tampered.tools.typescript = '0.0.0';
    const file = path.join(directory, 'tampered-exact-tool.json');
    fs.writeFileSync(file, `${JSON.stringify(tampered)}\n`);
    const result = verify(file);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('mutation evidence verification failed');
  });

  it('uses a non-self-referential Git snapshot supplement', () => {
    const harness = require('./assembly/mutation-harness.js') as {
      gitSupplement(repoRoot?: string, evidencePath?: string): Record<string, unknown>;
    };
    const supplement = harness.gitSupplement();
    expect(supplement).toEqual(original.supplementalGit);
    expect(Object.keys(supplement).sort()).toEqual([
      'trackedSnapshotDiffSha256',
      'trackedTreeWithoutEvidence',
    ]);
    expect(supplement.trackedTreeWithoutEvidence).toMatch(/^[0-9a-f]{40,64}$/);
    expect(supplement.trackedSnapshotDiffSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records an exact repository-relative invocation that survives checkout relocation', () => {
    expect(original.invocation).toEqual({
      cwd: '.',
      argv: [
        'node',
        'apps/api/test/assembly/mutation-harness.js',
        '--json',
        'apps/api/test/assembly/mutation-results.json',
      ],
    });
  });

  it('represents tracked deletions while excluding untracked rename destinations', () => {
    const harness = require('./assembly/mutation-harness.js') as {
      gitSupplement(repoRoot?: string, evidencePath?: string): Record<string, string>;
    };
    const repo = path.join(directory, 'git-snapshot-deletions');
    fs.mkdirSync(repo);
    git(repo, ['init', '--quiet']);
    fs.writeFileSync(path.join(repo, 'stable.txt'), 'stable\n');
    fs.writeFileSync(path.join(repo, 'removed.txt'), 'removed\n');
    fs.writeFileSync(path.join(repo, 'renamed-source.txt'), 'rename me\n');
    fs.writeFileSync(path.join(repo, 'mutation-results.json'), '{}\n');
    git(repo, ['add', '.']);
    git(repo, [
      '-c', 'user.name=MUN-0022 Fixture',
      '-c', 'user.email=mun0022-fixture.invalid@example.invalid',
      'commit', '--quiet', '-m', 'fixture',
    ]);
    fs.rmSync(path.join(repo, 'removed.txt'));
    fs.renameSync(
      path.join(repo, 'renamed-source.txt'),
      path.join(repo, 'untracked-rename-destination.txt'),
    );
    fs.writeFileSync(path.join(repo, 'staged-then-deleted.txt'), 'temporary\n');
    git(repo, ['add', 'staged-then-deleted.txt']);
    fs.rmSync(path.join(repo, 'staged-then-deleted.txt'));

    const supplement = harness.gitSupplement(repo, 'mutation-results.json');
    expect(git(repo, [
      'ls-tree', '-r', '--name-only', supplement.trackedTreeWithoutEvidence,
    ])).toBe('stable.txt');
  });

  it('keeps the standalone site map semantically identical to the result map', () => {
    const map = JSON.parse(fs.readFileSync(SITE_MAP, 'utf8')) as Evidence;
    expect(map.siteMapSha256).toBe(original.siteMapSha256);
    expect(map.count).toBe(original.sites.length);
    expect(map.sites).toEqual(original.sites.map((site: Evidence) => ({
      id: site.id,
      path: site.file,
      line: site.line,
      fn: site.enclosingFunction,
      codes: site.calls.map((call: Evidence) => call.code),
      mutationKind: site.mutationKind,
      pristineStatementSha256: map.sites[site.id - 1]?.pristineStatementSha256,
    })));
  });

  it.each([
    ['invocation', (value: Evidence) => { value.invocation = ['not-the-recorded-command']; }],
    ['tool version', (value: Evidence) => { value.tools.node = 'v0.0.0'; }],
    ['baseline outcome', (value: Evidence) => { value.baseline.outcome = 'HARNESS_ERROR'; }],
    ['baseline count', (value: Evidence) => { value.baseline.testsTotal += 1; }],
    ['summary', (value: Evidence) => { value.summary.survived = value.summary.total; }],
    ['restoration verdict', (value: Evidence) => { value.restoration.verified = false; }],
    ['duplicate site id', (value: Evidence) => { value.sites[1].id = value.sites[0].id; }],
    ['site line', (value: Evidence) => { value.sites[0].line += 1; }],
    ['site function', (value: Evidence) => { value.sites[0].enclosingFunction = 'tampered'; }],
    ['site calls', (value: Evidence) => { value.sites[0].calls = []; }],
    ['pristine hash', (value: Evidence) => { value.sites[0].pristineSha256 = '0'.repeat(64); }],
    ['mutant hash', (value: Evidence) => { value.sites[0].mutantSha256 = '0'.repeat(64); }],
    ['outcome', (value: Evidence) => { value.sites[0].outcome = 'SURVIVED'; }],
    ['detail hash', (value: Evidence) => { value.sites[0].detailSha256 = '0'.repeat(64); }],
  ])('rejects tampered %s evidence', (label, mutate) => {
    const tampered = structuredClone(original);
    mutate(tampered);
    const file = path.join(directory, `${String(label).replace(/\s+/g, '-')}.json`);
    fs.writeFileSync(file, `${JSON.stringify(tampered)}\n`);
    const result = verify(file);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('mutation evidence verification failed');
  });

  it('requires a fresh run to match allowed killed-label substitutions exactly', () => {
    const harness = require('./assembly/mutation-harness.js') as {
      recordedOutcomeMatches(recorded: Evidence, actual: Evidence): boolean;
    };
    const recorded = original.sites[0] as Evidence;
    const actual = { outcome: recorded.outcome, detail: recorded.detail };
    const substituted = {
      ...recorded,
      outcome: recorded.outcome === 'KILLED_BY_TEST' ? 'KILLED_BY_TYPECHECK' : 'KILLED_BY_TEST',
    };
    expect(harness.recordedOutcomeMatches(substituted, actual)).toBe(false);
  });

  it('requires a fresh run to match a replaced detail even when its self-hash is updated', () => {
    const harness = require('./assembly/mutation-harness.js') as {
      recordedOutcomeMatches(recorded: Evidence, actual: Evidence): boolean;
    };
    const recorded = original.sites[0] as Evidence;
    const actual = { outcome: recorded.outcome, detail: recorded.detail };
    const detail = 'different but internally self-consistent detail';
    const substituted = {
      ...recorded,
      detail,
      detailSha256: createHash('sha256').update(detail).digest('hex'),
    };
    expect(harness.recordedOutcomeMatches(substituted, actual)).toBe(false);
  });

  it('canonicalizes all failing test identities independently of Jest output order', () => {
    const harness = require('./assembly/mutation-harness.js') as {
      canonicalFailureDetail(out: string, outcome: string): string;
    };
    const first = [
      '  [31m● suite z › rejects z[0m',
      '  ● suite a › rejects a',
      '  ● suite z › rejects z',
    ].join('\n');
    const second = [
      '  ● suite z › rejects z',
      '  ● suite a › rejects a',
    ].join('\n');
    const expected = '● suite a › rejects a | ● suite z › rejects z';
    expect(harness.canonicalFailureDetail(first, 'KILLED_BY_TEST')).toBe(expected);
    expect(harness.canonicalFailureDetail(second, 'KILLED_BY_TEST')).toBe(expected);
  });

  it('canonicalizes unique compiler diagnostics independently of repetition and order', () => {
    const harness = require('./assembly/mutation-harness.js') as {
      canonicalFailureDetail(out: string, outcome: string): string;
    };
    const output = [
      'error TS2366: Function lacks ending return statement.',
      'error TS18047: value is possibly null.',
      'error TS2366: Function lacks ending return statement.',
    ].join('\n');
    expect(harness.canonicalFailureDetail(output, 'KILLED_BY_TYPECHECK')).toBe(
      'error TS18047: value is possibly null. | error TS2366: Function lacks ending return statement.',
    );
  });
});
