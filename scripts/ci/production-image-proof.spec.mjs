import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

// Parse the actual program delivered to the image's Node process, without
// Docker, database access, or importing Prisma on the test host.
test('candidate image receives a syntax-valid Prisma query program', () => {
  const source = readFileSync(new URL('./production-image-proof.mjs', import.meta.url), 'utf8');
  const expression = source.match(/const query = JSON.parse\(inImage\(network,\s*((?:String.raw)?`[\s\S]*?`)\)\);/);
  assert(expression, 'actual query transport expression must be inspected');
  const program = runInNewContext(expression[1], Object.create(null), { timeout: 1000 });
  const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: program, encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
