import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { spawnSync } from 'node:child_process';

const WORKFLOW = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..', '.github/workflows/regenerate-derived-artefacts.yml');

function runBlockExpressions(source: string): string[] {
  const lines = source.split(/\r?\n/);
  const found: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const run = lines[index].match(/^(\s*)run:\s*(.*)$/);
    if (!run) continue;

    const indent = run[1].length;
    const block = [run[2]];
    while (index + 1 < lines.length) {
      const next = lines[index + 1];
      if (next.trim() && (next.match(/^\s*/)?.[0].length ?? 0) <= indent) break;
      block.push(next);
      index += 1;
    }

    for (const line of block) {
      const expression = line.match(/\$\{\{[^}]+\}\}/)?.[0];
      if (expression && /\b(?:steps\.[\w-]+\.outputs\.|github\.event\.|github\.head_ref\b|inputs\.)/.test(expression)) {
        found.push(expression);
      }
    }
  }
  return found;
}

describe('regenerate-derived-artefacts workflow shell inputs', () => {
  it('does not interpolate event data or step outputs directly in run blocks', () => {
    const source = fs.readFileSync(WORKFLOW, 'utf8');
    expect(runBlockExpressions(source)).toEqual([]);
  });

  it('keeps a shell metacharacter in a PR ref literal when passed through the environment', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-contract-'));
    const marker = path.join(scratch, 'executed');
    const hostileRef = `branch"$(touch '${marker}')"`;

    try {
      const oldExpansion = `git() { :; }\ngit push --force-with-lease="${hostileRef}:base" origin HEAD:"${hostileRef}"`;
      const oldResult = spawnSync('bash', ['-c', oldExpansion], { encoding: 'utf8' });
      expect(oldResult.status).toBe(0);
      expect(fs.existsSync(marker)).toBe(true);

      fs.rmSync(marker);
      const safeScript = 'git() { :; }\ngit push --force-with-lease="${PR_REF}:${BASE_SHA}" origin "HEAD:${PR_REF}"';
      const safeResult = spawnSync('bash', ['-c', safeScript], {
        encoding: 'utf8',
        env: { ...process.env, PR_REF: hostileRef, BASE_SHA: 'measured-head' },
      });
      expect(safeResult.status).toBe(0);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
