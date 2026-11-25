// MUN-0022: the independent evidence verifier must reject every material
// alteration to the source-bound mutation record.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { canonicalJsonV1 } from '../src/execution-authority/canonical-json-v1.js';
import * as url from 'node:url';
// ESM has no injected globals, so `jest` must be imported for the RUNTIME.
// Its type, though, comes from @types/jest (already in tsconfig `types`),
// which is what the 339 existing jest.fn() call sites are written against —
// @jest/globals ships a stricter generic whose bare jest.fn() infers `never`
// and would red 416 lines that are not otherwise wrong. Value from one,
// type from the other.
import { jest as _jestRuntime } from '@jest/globals';
const jest = _jestRuntime as unknown as typeof globalThis.jest;
// The harness is ESM now, so it is imported once here rather than require()d
// in six separate test bodies: a CommonJS bridge cannot load an ES module
// synchronously. The namespace import also drops six hand-written local
// shapes in favour of the harness's own exported signatures.
import * as harness from './assembly/mutation-harness.js';


// ESM has no __dirname, and declaring that NAME would mark the module CommonJS.
const thisDir = path.dirname(url.fileURLToPath(import.meta.url));

jest.setTimeout(30_000);

const API_ROOT = path.resolve(thisDir, '..');
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
    const supplement = harness.gitSupplement();
    expect(supplement).toEqual(original.supplementalGit);
    expect(Object.keys(supplement).sort()).toEqual([
      'includedPaths',
      'trackedSnapshotDiffSha256',
      'trackedTreeWithoutEvidence',
    ]);
    expect(supplement.trackedTreeWithoutEvidence).toMatch(/^[0-9a-f]{40,64}$/);
    expect(supplement.trackedSnapshotDiffSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  // muneral#57 / A2-307 follow-up. The supplement used to hash (almost) the
  // whole tracked tree, so SECURITY.md or other out-of-battery bytes staled
  // mutation evidence. Scope is now an ALLOWLIST equal to bindingPaths() —
  // the real inputs the evidence already hashes in `binding`. A real input
  // change must still invalidate; an unrelated tree change must not.
  const FIXTURE_SCOPE = [
    'apps/api/src/assembly/assembly.compiler.ts',
    'apps/api/src/execution-authority/evidence-ref.validator.ts',
    'apps/api/src/execution-authority/execution-authority.reducer.ts',
    'apps/api/test/assembly/mutation-harness.js',
    'apps/api/test/setup-env.ts',
    'pnpm-lock.yaml',
  ];

  function scopeFixture(root: string) {
    fs.mkdirSync(root);
    git(root, ['init', '--quiet']);
    for (const file of [
      ...FIXTURE_SCOPE,
      'apps/api/test/assembly/mutation-results.json',
      'README.md',
      'SECURITY.md',
      'docs/policy.md',
      'docker-compose.prod.yml',
      'receipts/graph/change-admission.json',
      '.github/workflows/ci.yml',
      'apps/web/app/page.tsx',
    ]) {
      fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), `${file}\n`);
    }
    git(root, ['add', '.']);
    git(root, [
      '-c', 'user.name=MUN-57 Fixture',
      '-c', 'user.email=mun57-fixture.invalid@example.invalid',
      'commit', '--quiet', '-m', 'fixture',
    ]);
  }

  it('declares its included paths in the evidence it records', () => {
    const expected = harness.evidenceScopePaths();
    const included = original.supplementalGit.includedPaths as string[];
    expect(expected.length).toBeGreaterThan(10);
    expect(included).toEqual([...included].sort());
    expect(included).toEqual(expect.arrayContaining(expected));
    for (const rel of included) {
      expect(fs.existsSync(path.join(path.resolve(API_ROOT, '..', '..'), rel))).toBe(true);
    }
    expect(expected).toEqual(expect.arrayContaining([
      'apps/api/src/assembly/assembly.validator.ts',
      'apps/api/src/execution-authority/evidence-ref.validator.ts',
      'apps/api/src/execution-authority/execution-authority.reducer.ts',
      'apps/api/src/execution-authority/execution-authority.replay.ts',
      'apps/api/test/assembly/mutation-harness.js',
      'apps/api/test/mutation-evidence.spec.ts',
      'apps/api/test/setup-env.ts',
      'pnpm-lock.yaml',
    ]));
    expect(included).not.toContain('SECURITY.md');
  });

  it('does not stale when a file outside the allowlist changes (incl. SECURITY.md)', () => {
    const repo = path.join(directory, 'scope-unrelated');
    scopeFixture(repo);
    const before = harness.gitSupplement(
      repo,
      'apps/api/test/assembly/mutation-results.json',
      FIXTURE_SCOPE,
    );
    // A whole-index refresh would run this required clean filter and fail.
    fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), 'SECURITY.md filter=reject-unrelated\n');
    git(repo, ['config', 'filter.reject-unrelated.clean', 'false']);
    git(repo, ['config', 'filter.reject-unrelated.required', 'true']);
    for (const unrelated of [
      'README.md',
      'SECURITY.md',
      'docs/policy.md',
      'docker-compose.prod.yml',
      'receipts/graph/change-admission.json',
      '.github/workflows/ci.yml',
      'apps/web/app/page.tsx',
    ]) {
      fs.appendFileSync(path.join(repo, unrelated), 'a merge landed on main\n');
    }
    const after = harness.gitSupplement(
      repo,
      'apps/api/test/assembly/mutation-results.json',
      FIXTURE_SCOPE,
    );
    expect(after).toEqual(before);
  });

  it.each([
    ['README.md', 'README.md.bak'],
    ['SECURITY.md', 'SECURITY.mdx'],
    ['docs/policy.md', 'docs-extra/policy.md'],
  ])('excludes %s but tracks edits to %s', (documentation, nearName) => {
    const repo = path.join(directory, `scope-near-${path.basename(nearName)}`);
    scopeFixture(repo);
    const snapshot = () => harness.gitSupplement(
      repo,
      'apps/api/test/assembly/mutation-results.json',
      FIXTURE_SCOPE,
    );
    const nearPath = path.join(repo, nearName);
    fs.mkdirSync(path.dirname(nearPath), { recursive: true });
    const withoutNearName = snapshot();
    fs.writeFileSync(nearPath, 'untracked content\n');
    expect(snapshot()).toEqual(withoutNearName);
    git(repo, ['add', '--', nearName]);

    const before = snapshot();
    fs.appendFileSync(path.join(repo, documentation), 'documentation edit\n');
    expect(snapshot()).toEqual(before);
    fs.appendFileSync(nearPath, 'tracked edit\n');
    const after = snapshot();
    expect(after.trackedSnapshotDiffSha256).not.toBe(before.trackedSnapshotDiffSha256);
    expect(after.includedPaths).toContain(nearName);
    expect(after.includedPaths).not.toContain(documentation);
  });

  it('hashes raw allowlisted input bytes even when excluded attributes would normalize them', () => {
    const repo = path.join(directory, 'scope-attributes');
    fs.mkdirSync(repo);
    git(repo, ['init', '--quiet']);
    git(repo, ['config', 'core.autocrlf', 'false']);
    const input = Buffer.from('first line\r\nsecond line\r\n');
    fs.writeFileSync(path.join(repo, 'input.txt'), input);
    fs.writeFileSync(path.join(repo, '.gitattributes'), '# no conversions\n');
    git(repo, ['add', 'input.txt', '.gitattributes']);
    const before = harness.gitSupplement(repo, 'mutation-results.json', ['input.txt']);
    const index = fs.readFileSync(path.join(repo, '.git', 'index'));

    fs.writeFileSync(path.join(repo, '.gitattributes'), 'input.txt text eol=lf\n');
    const raw = git(repo, ['hash-object', '--no-filters', 'input.txt']);
    expect(git(repo, ['hash-object', '--path=input.txt', 'input.txt'])).not.toBe(raw);
    expect(harness.gitSupplement(repo, 'mutation-results.json', ['input.txt'])).toEqual(before);
    expect(git(repo, ['ls-tree', '-r', before.trackedTreeWithoutEvidence]))
      .toBe(`100644 blob ${raw}\tinput.txt`);
    expect(fs.readFileSync(path.join(repo, 'input.txt'))).toEqual(input);
    expect(fs.readFileSync(path.join(repo, '.git', 'index'))).toEqual(index);
  });

  it('still stales when a real allowlisted input changes', () => {
    const repo = path.join(directory, 'scope-bound');
    scopeFixture(repo);
    const before = harness.gitSupplement(
      repo,
      'apps/api/test/assembly/mutation-results.json',
      FIXTURE_SCOPE,
    );
    for (const bound of FIXTURE_SCOPE) {
      const probe = path.join(repo, bound);
      const pristine = fs.readFileSync(probe);
      fs.appendFileSync(probe, 'one byte the battery could read\n');
      expect(harness.gitSupplement(
        repo,
        'apps/api/test/assembly/mutation-results.json',
        FIXTURE_SCOPE,
      )).not.toEqual(before);
      fs.writeFileSync(probe, pristine);
    }
    expect(harness.gitSupplement(
      repo,
      'apps/api/test/assembly/mutation-results.json',
      FIXTURE_SCOPE,
    )).toEqual(before);
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
    fs.writeFileSync(path.join(repo, 'staged-executable.sh'), '#!/bin/sh\n', { mode: 0o755 });
    git(repo, ['update-index', '--add', '--chmod=+x', 'staged-executable.sh']);
    const index = fs.readFileSync(path.join(repo, '.git', 'index'));

    const supplement = harness.gitSupplement(repo, 'mutation-results.json', [
      'stable.txt',
      'removed.txt',
      'renamed-source.txt',
      'untracked-rename-destination.txt',
      'staged-then-deleted.txt',
      'staged-executable.sh',
    ]);
    expect(git(repo, [
      'ls-tree', '-r', supplement.trackedTreeWithoutEvidence,
    ])).toBe([
      `100644 blob ${git(repo, ['hash-object', '--no-filters', 'stable.txt'])}\tstable.txt`,
      `100755 blob ${git(repo, ['hash-object', '--no-filters', 'staged-executable.sh'])}\tstaged-executable.sh`,
    ].join('\n'));
    expect(fs.readFileSync(path.join(repo, '.git', 'index'))).toEqual(index);
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
    const recorded = original.sites[0] as Evidence;
    const actual = { outcome: recorded.outcome, detail: recorded.detail };
    const substituted = {
      ...recorded,
      outcome: recorded.outcome === 'KILLED_BY_TEST' ? 'KILLED_BY_TYPECHECK' : 'KILLED_BY_TEST',
    };
    expect(harness.recordedOutcomeMatches(substituted, actual)).toBe(false);
  });

  it('requires a fresh run to match a replaced detail even when its self-hash is updated', () => {
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
