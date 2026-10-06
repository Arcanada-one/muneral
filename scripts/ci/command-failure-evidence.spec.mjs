import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandFailureEvidence } from './command-failure-evidence.mjs';

test('command diagnostics preserve an actionable failure and redact credentials', () => {
  const token = ['mun', 'sk', 'ownedfixture'].join('_');
  const bearer = 'fixture-access';
  const key = ['-----BEGIN PRIVATE KEY-----', 'fixture-key', '-----END PRIVATE KEY-----'].join('\n');
  const result = commandFailureEvidence({ stderr: `Cannot load prisma/config\npostgresql://fixture:fixture@postgres:5432/test\nBearer ${bearer} ${token}\n${key}` });
  assert.match(result.stderr.text, /Cannot load prisma\/config/);
  for (const secret of [token, bearer, 'fixture:fixture', 'fixture-key'])
    assert(!result.stderr.text.includes(secret));
  assert.match(result.stderr.sha256, /^[0-9a-f]{64}$/);
});

test('diagnostics accept missing streams and bound retained output', () => {
  assert.equal(commandFailureEvidence({}).stdout.text, '');
  const result = commandFailureEvidence({stderr: 'x'.repeat(20000)});
  assert.equal(result.stderr.text.length, 8192);
  assert.equal(result.stderr.truncated, true);
});
