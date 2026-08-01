// MUN-0022: the independent Python validator must fail through its real CLI.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const apiRoot = path.join(__dirname, '..', '..');
const validator = path.join('test', 'assembly', 'validate_assembly_fixtures.py');
const realFixtures = path.join(__dirname, 'fixtures');

type Run = { status: number; stdout: string };

function runValidator(fixturesDir: string): Run {
  try {
    return {
      status: 0,
      stdout: execFileSync(
        'python3',
        [validator, '--fixtures-dir', fixturesDir],
        { cwd: apiRoot, encoding: 'utf8' },
      ),
    };
  } catch (err) {
    const failure = err as { status?: number; stdout?: string };
    return { status: failure.status ?? -1, stdout: failure.stdout ?? '' };
  }
}

function copyCorpus(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mun0022-corpus-'));
  for (const sub of ['positive', 'negative']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
    for (const file of fs.readdirSync(path.join(realFixtures, sub))) {
      fs.copyFileSync(path.join(realFixtures, sub, file), path.join(dir, sub, file));
    }
  }
  return dir;
}

function mutate(
  dir: string,
  file: string,
  edit: (fixture: Record<string, unknown>) => void,
): void {
  const fixturePath = path.join(dir, 'positive', file);
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
  edit(fixture);
  fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
}

describe('Python validator CLI negative controls', () => {
  let dir: string;
  beforeEach(() => { dir = copyCorpus(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('passes the pristine corpus', () => {
    const run = runValidator(dir);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('0 failed');
  });

  it('fails when the request digest pin is corrupted', () => {
    mutate(dir, 'minimal-request.json', (fixture) => {
      fixture.expectedDigest = '0'.repeat(64);
    });
    const run = runValidator(dir);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('minimal-request.json');
    expect(run.stdout).toMatch(/digest mismatch/);
  });

  it('fails when the artifact identity pin is corrupted', () => {
    mutate(dir, 'full-request.json', (fixture) => {
      fixture.expectedArtifactId = 'f'.repeat(64);
    });
    const run = runValidator(dir);
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('full-request.json');
    expect(run.stdout).toMatch(/artifactId mismatch/);
  });

  it('fails rather than reporting a silent pass', () => {
    mutate(dir, 'narrow-scope.json', (fixture) => {
      fixture.expectedDigest = '1'.repeat(64);
    });
    expect(runValidator(dir).stdout).not.toMatch(/0 failed/);
  });
});
