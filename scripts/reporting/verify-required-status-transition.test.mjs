import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyRequiredTransition } from './verify-required-status-transition.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, 'verify-required-status-transition.mjs');
const taskA = '11111111-1111-4111-8111-111111111111';
const evidenceId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function runCli(args, input) {
  return spawnSync(process.execPath, [cli, ...args], {
    input,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
}

function base(events, completenessState = 'complete') {
  return {
    schemaVersion: 1,
    required: { taskId: taskA, from: 'in_progress', to: 'review' },
    completeness: { state: completenessState, evidenceId },
    events,
  };
}

test('PASS when required transition is present', () => {
  const report = verifyRequiredTransition(
    base([
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
        taskId: taskA,
        action: 'task:status_changed',
        createdAt: '2026-10-28T00:10:00Z',
        from: 'in_progress',
        to: 'review',
      },
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
        taskId: taskA,
        action: 'comment',
        createdAt: '2026-10-28T00:11:00Z',
      },
    ]),
  );
  assert.equal(report.verdict, 'PASS');
  assert.equal(report.matchedEventId, 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001');
});

test('FAIL when only comments exist under complete input', () => {
  const report = verifyRequiredTransition(
    base([
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
        taskId: taskA,
        action: 'comment',
        createdAt: '2026-10-28T00:11:00Z',
      },
    ]),
  );
  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.reason, 'REQUIRED_TRANSITION_ABSENT');
  assert.equal(report.matchedEventId, null);
});

test('NOT_MEASURED when completeness is incomplete', () => {
  const report = verifyRequiredTransition(base([], 'incomplete'));
  assert.equal(report.verdict, 'NOT_MEASURED');
  assert.equal(report.reason, 'INPUT_INCOMPLETE');
});

test('CLI exits 0 on PASS, 1 on FAIL, 3 on NOT_MEASURED', () => {
  const pass = runCli(
    ['-'],
    JSON.stringify(
      base([
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
          taskId: taskA,
          action: 'task:status_changed',
          createdAt: '2026-10-28T00:10:00Z',
          from: 'in_progress',
          to: 'review',
        },
      ]),
    ),
  );
  assert.equal(pass.status, 0);
  assert.equal(JSON.parse(pass.stdout).verdict, 'PASS');

  const fail = runCli(['-'], JSON.stringify(base([])));
  assert.equal(fail.status, 1);
  assert.equal(JSON.parse(fail.stdout).verdict, 'FAIL');

  const nm = runCli(['-'], JSON.stringify(base([], 'incomplete')));
  assert.equal(nm.status, 3);
  assert.equal(JSON.parse(nm.stdout).verdict, 'NOT_MEASURED');
});

test('CLI fails closed on malformed input without echoing payload', () => {
  const result = runCli(['-'], '{"schemaVersion":1, "not": "enough"}');
  assert.equal(result.status, 2);
  assert.equal(result.stderr, 'verify-required-status-transition: INPUT_INVALID\n');
  assert.equal(result.stdout, '');
});
