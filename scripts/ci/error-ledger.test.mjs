import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildLedger,
  classifyCluster,
  fixHintFor,
  normalizeErrorLine,
} from './error-ledger.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const lintLog = path.join(repoRoot, 'data/pr108_lint_and_test.log');
const graphLog = path.join(repoRoot, 'data/pr108_graph_admission.log');
const cli = path.join(here, 'error-ledger.mjs');

test('normalizeErrorLine replaces sha, numbers and paths with placeholders', () => {
  const raw =
    'refuse RECEIPT_MISSING — no ChangeAdmissionReceipt/v1 bound to a4d1a1b92b14c1eae2a6b339deadbeef01cafe..c1eae2a6b339deadbeef01cafe00aabbccddee at /home/ci-isolated/runner-general/_work/muneral/muneral/x';
  const n = normalizeErrorLine(raw);
  assert.match(n, /<(?:SHA|HEX)>/);
  assert.match(n, /<PATH>/);
  assert.equal(n.includes('a4d1a1b92b14'), false);
  assert.equal(n.includes('/home/ci-isolated'), false);
});

test('environment-class clusters receive no fix_hint', () => {
  const key = 'SyntaxError: Cannot use import statement outside a module';
  const cls = classifyCluster(key, key, { files: ['test/auth.service.spec.ts', '@nestjs/jwt'] });
  assert.equal(cls, 'environment');
  assert.equal(fixHintFor(cls, key), null);
});

test('PR #108 logs yield exactly C01/C02/C03 with required signatures', async () => {
  const lint = readFileSync(lintLog, 'utf8');
  const graph = readFileSync(graphLog, 'utf8');
  const ledger = await buildLedger({
    logs: [lint, graph],
    capturedAt: '2026-09-13T09:40:32Z',
    receipts: [],
  });

  assert.equal(ledger.schema, 'ErrorLedger/v1');
  assert.equal(ledger.clusters.length, 3, `clusters=${JSON.stringify(ledger.clusters.map((c) => ({ id: c.id, key: c.key, count: c.count, class: c.class })), null, 2)}`);

  const [c01, c02, c03] = ledger.clusters;
  assert.equal(c01.id, 'C01');
  assert.match(c01.key, /Cannot use import statement outside a module/);
  assert.equal(c01.class, 'environment');
  assert.equal(c01.count, 10, `C01 count=${c01.count} members=${JSON.stringify(c01.members)}`);
  assert.ok(c01.files.some((f) => f.includes('@nestjs/jwt') || f.includes('test/')));
  assert.equal(c01.fix_hint, null);

  assert.equal(c02.id, 'C02');
  assert.match(c02.key, /mutation-evidence/i);
  assert.equal(c02.class, 'baseline');
  assert.equal(c02.count, 3, `C02 count=${c02.count} members=${JSON.stringify(c02.members)}`);
  assert.ok(c02.fix_hint);

  assert.equal(c03.id, 'C03');
  assert.match(c03.key, /RECEIPT_MISSING/);
  assert.equal(c03.class, 'verdict');
  assert.ok(c03.fix_hint);
});

test('CLI writes error-ledger.json and error-ledger.md from #108 fixtures', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'error-ledger-'));
  try {
    const outJson = path.join(dir, 'error-ledger.json');
    const outMd = path.join(dir, 'error-ledger.md');
    const result = spawnSync(
      process.execPath,
      [
        cli,
        '--log',
        lintLog,
        '--log',
        graphLog,
        '--out',
        outJson,
        '--md',
        outMd,
        '--captured-at',
        '2026-09-13T09:40:32Z',
        '--receipts-dir',
        path.join(dir, 'empty-receipts'),
      ],
      { encoding: 'utf8', cwd: repoRoot, timeout: 15000 },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const ledger = JSON.parse(readFileSync(outJson, 'utf8'));
    assert.equal(ledger.clusters.length, 3);
    const md = readFileSync(outMd, 'utf8');
    assert.match(md, /# ErrorLedger\/v1/);
    assert.match(md, /C01/);
    assert.match(md, /C03/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BATCH-004 reports dir + graph-admission-result.json are accepted inputs', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'error-ledger-reports-'));
  try {
    const reports = path.join(dir, 'reports');
    mkdirSync(reports, { recursive: true });
    // Minimal jest json encoding the jwt ESM failure for one suite (clustering still works with logs preferred in AC4)
    writeFileSync(
      path.join(reports, 'jest.json'),
      JSON.stringify({
        testResults: [
          {
            name: '/repo/apps/api/test/auth.service.spec.ts',
            status: 'failed',
            message: 'SyntaxError: Cannot use import statement outside a module\nimport { JwtService } from \'@nestjs/jwt\';',
          },
        ],
      }),
    );
    writeFileSync(
      path.join(dir, 'graph-admission-result.json'),
      JSON.stringify({
        reason_codes: ['RECEIPT_MISSING'],
        summary_lines: ['refuse RECEIPT_MISSING — no ChangeAdmissionReceipt/v1 bound'],
      }),
    );
    const reportsMap = {
      'reports/jest.json': readFileSync(path.join(reports, 'jest.json'), 'utf8'),
    };
    const ledger = await buildLedger({
      reports: reportsMap,
      graphAdmissionResult: JSON.parse(readFileSync(path.join(dir, 'graph-admission-result.json'), 'utf8')),
      capturedAt: '2026-11-07T00:00:00Z',
    });
    assert.ok(ledger.clusters.some((c) => /Cannot use import statement/.test(c.key)));
    assert.ok(ledger.clusters.some((c) => /RECEIPT_MISSING/.test(c.key)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
