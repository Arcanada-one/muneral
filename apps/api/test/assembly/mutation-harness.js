#!/usr/bin/env node
/**
 * MUN-0022 — E3: scripted mutation harness (V-AC-17 / D-REQ-18).
 *
 * WHY THIS EXISTS
 * ---------------
 * A passing suite alone is not an exit criterion. The exit criterion is: every
 * mechanically discovered refusal in the shipped compiler-only package is
 * killed by a test or made unrepresentable by the type checker.
 * A site that can be disabled with the suite still green is a site nothing
 * actually checks.
 *
 * WHAT A "REJECTION SITE" IS
 * --------------------------
 * Every statement in the target files that constructs an `AssemblyErrorV0` —
 * whether returned bare (`return createAssemblyError(...)`),
 * wrapped (`return fail(createAssemblyError(...))`), or carried in a result
 * object (`return { ok: false, error: createAssemblyError(...) }` /
 * `{ refusal: createAssemblyError(...) }`).
 *
 * Sites are enumerated MECHANICALLY from the TypeScript AST, not from a
 * hand-maintained list. A hand-maintained count goes stale the moment the
 * module changes, and a stale count silently excludes sites — which is the
 * failure mode this harness exists to prevent. `--list` prints what the current
 * source actually contains.
 *
 * SCOPE — read this before generalising a result
 * ----------------------------------------------
 * "No site is excluded" is true WITHIN the scope below, and the scope is
 * narrower than the sentence sounds:
 *
 *   * FIVE FILES. `TARGETS` covers assembly.errors.ts,
 *     assembly.validator.ts, assembly.canonical.ts, assembly.compiler.ts, and
 *     the shared execution-authority/canonical-json-v1.ts boundary.
 *     The deleted runtime/guards module is deliberately absent. The compiler
 *     and error factory can contribute zero sites: neither decides whether to
 *     refuse; the validator and canonical boundary do.
 *   * REFUSAL, NOT PROPAGATION. A site is a statement that REFUSES: it either
 *     constructs an AssemblyErrorV0 (directly or through a local factory) or
 *     throws an Error from a `throw` statement. Throw-based refusals were
 *     previously excluded, which silently exempted all 16 of
 *     assembly.canonical.ts's `throw new AssemblyCanonicalJsonError(…)` sites —
 *     including the numeric-domain and ordering enforcement — while this
 *     docstring claimed they were covered.
 *
 *     Statements that merely propagate an already-built error are not
 *     enumerated; this harness measures refusal construction, not full branch
 *     or statement mutation coverage.
 *
 * A zero-survivor result therefore means "every discovered error-constructing
 * statement is observed by a test or enforced by types", not "the package is
 * fully mutation-covered".
 *
 * THE MUTATION
 * ------------
 * For each site, the whole enclosing statement is deleted. Control flow then
 * falls through and the rejection does not occur. This is a stronger and more
 * uniform mutation than negating a predicate: it removes the refusal itself
 * rather than one route to it.
 *
 * Where one statement carries several `createAssemblyError` calls (a ternary,
 * say), the sites collapse into one mutant — recorded explicitly in `calls`,
 * never silently merged.
 *
 * OUTCOMES
 * --------
 *   KILLED_BY_TEST      — the suite ran and a test failed. Real coverage.
 *   KILLED_BY_TYPECHECK — ts-jest refused to compile the mutant, so the suite
 *                         could not run. This is a genuine defence (the type
 *                         system forbids removing the site) but it is NOT
 *                         evidence that any test observes the behaviour, so it
 *                         is reported separately rather than folded into the
 *                         kill count.
 *   SURVIVED            — the suite stayed green with the rejection removed.
 *                         Each survivor must be fixed or listed with a named
 *                         reason.
 *
 * USAGE
 *   node test/assembly/mutation-harness.js --list
 *   node test/assembly/mutation-harness.js [--site <id>] [--json <path>]
 *
 * Run from `apps/api/`. Restores the source on every exit path, including
 * SIGINT — a crashed harness must never leave a mutant on disk.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const ts = require('typescript');

const API_ROOT = path.resolve(__dirname, '..', '..');
const REPO_ROOT = path.resolve(API_ROOT, '..', '..');
// Every shipped compiler-only source file that can construct or propagate a
// refusal. Contract-only types and the root barrel have no executable sites.
const TARGETS = [
  path.join(API_ROOT, 'src', 'assembly', 'assembly.errors.ts'),
  path.join(API_ROOT, 'src', 'assembly', 'assembly.validator.ts'),
  path.join(API_ROOT, 'src', 'assembly', 'assembly.canonical.ts'),
  path.join(API_ROOT, 'src', 'assembly', 'assembly.compiler.ts'),
  path.join(API_ROOT, 'src', 'execution-authority', 'canonical-json-v1.ts'),
];
const JEST = path.join(API_ROOT, 'node_modules', '.bin', 'jest');
const pristineFor = (t) => `${t}.pristine`;

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

/**
 * Every statement in the target that constructs an AssemblyErrorV0.
 * Returns one entry per enclosing statement, with the calls it carries.
 */
function enumerateSites(sourceText, fileName = 'source.ts') {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2022, true);
  const byStatement = new Map();

  // Local error FACTORIES — `const outOfBand = (...) => ({ ok: false, error:
  // createAssemblyError(...) })` and friends. The declaration is not a
  // rejection: nothing is refused where a helper is defined. Its CALL SITES
  // are the rejections, and there are many more of them than declarations.
  //
  // Treating the declaration as the site both mislabels it (deleting a
  // declaration is a trivial compile error, which scores as a free "kill") and
  // silently swallows every real site that calls it — 12 of them here behind 2
  // declarations. The plan's "no site is excluded" is only true if these are
  // enumerated, so factories are collected first and skipped below.
  const factoryNames = new Set();
  const collectFactories = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      buildsErrorFromOwnParams(node.initializer, sf)
    ) {
      factoryNames.add(node.name.text);
    }
    // …and factories written as function DECLARATIONS. Missing this form made
    // assembly.validator.ts report a single site: it refuses through
    // `function makeError(...)`, so every one of its rejections was invisible.
    //
    // A FACTORY is precisely a function that builds an error FROM ITS OWN
    // PARAMETERS — `makeError(code, …)` — not any function that happens to
    // refuse. Detecting it by "body mentions createAssemblyError" swept up
    // every refusing function, and
    // then the enclosing-function skip below removed all of their sites: 93
    // became 1. The discriminator is that the error CODE is a parameter rather
    // than a string literal.
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      node.body &&
      (buildsErrorFromOwnParams(node, sf) || (
        node.name.text === 'fail' && /throw\s+new\s+\w*Error/.test(node.body.getText(sf))
      ))
    ) {
      factoryNames.add(node.name.text);
    }
    ts.forEachChild(node, collectFactories);
  };
  collectFactories(sf);

  const enclosingStatement = (node) => {
    let n = node;
    while (n.parent) {
      // A statement whose own parent is a block/source file is the unit we can
      // delete without leaving a syntactic fragment behind.
      if (
        ts.isStatement(n) &&
        (ts.isBlock(n.parent) || ts.isSourceFile(n.parent) || ts.isCaseClause(n.parent) || ts.isDefaultClause(n.parent))
      ) {
        return n;
      }
      n = n.parent;
    }
    return null;
  };

  const visit = (node) => {
    const isDirect =
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'createAssemblyError';
    // THROW-BASED REFUSALS COUNT TOO.
    //
    // assembly.canonical.ts refuses by `throw new AssemblyCanonicalJsonError(…)`
    // — 16 sites — and none of them constructs an AssemblyErrorV0. Enumerating
    // only constructed errors meant every one of them was invisible, while the
    // docstring once claimed widening the target list had brought the numeric
    // domain and ordering comparators under mutation. It had not: the shared
    // canonical boundary itself was still outside the target list.
    //
    // A refusal is a refusal whatever its mechanism, and the serializer's throws
    // ARE the enforcement for values that never reach a typed gate.
    const isThrow =
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      /Error$/.test(node.expression.text) &&
      node.parent && ts.isThrowStatement(node.parent);
    const isViaFactory =
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      factoryNames.has(node.expression.text);

    if (isDirect || isViaFactory || isThrow) {
      const stmt = enclosingStatement(node);
      // Skip the factory's own declaration — defining a helper refuses nothing.
      // A site INSIDE a factory's own body refuses nothing — the factory only
      // builds the error its callers return. The variable-statement form was
      // skipped correctly, but the function-declaration form never was: the
      // enclosing STATEMENT of the inner call is the `return` inside the body,
      // not the declaration, so the test never matched. That scored
      // `makeError`'s own return as a site and collected a free
      // KILLED_BY_TYPECHECK ("must return a value") for a statement that refuses
      // nothing — inflating both the site count and the compiler-kill count.
      const enclosingFn = enclosingFunctionName(node, sf);
      const declaresFactory =
        factoryNames.has(enclosingFn) ||
        (stmt &&
         ((ts.isVariableStatement(stmt) &&
           stmt.declarationList.declarations.some(
             (d) => d.name && ts.isIdentifier(d.name) && factoryNames.has(d.name.text),
           )) ||
          (ts.isFunctionDeclaration(stmt) && stmt.name && factoryNames.has(stmt.name.text))));
      if (stmt && !declaresFactory) {
        const key = `${stmt.getStart(sf)}:${stmt.getEnd()}`;
        const callLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        // First argument is the error code literal when it is written inline.
        // A factory call carries its code inside the helper, so it reads as the
        // helper's name rather than a literal.
        const codeArg = node.arguments[0];
        const code = isThrow
          ? `throw ${node.expression.text}`
          : isViaFactory
            ? `via ${node.expression.text}()`
            : codeArg && ts.isStringLiteral(codeArg) ? codeArg.text : '(computed)';
        if (!byStatement.has(key)) {
          const preservesIfCondition = ts.isIfStatement(stmt) && !stmt.elseStatement;
          byStatement.set(key, {
            start: stmt.getStart(sf),
            end: stmt.getEnd(),
            mutationStart: preservesIfCondition ? stmt.thenStatement.getStart(sf) : stmt.getStart(sf),
            mutationEnd: preservesIfCondition ? stmt.thenStatement.getEnd() : stmt.getEnd(),
            mutationKind: preservesIfCondition ? 'empty-if-body' : 'delete-statement',
            line: sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1,
            enclosingFunction: enclosingFunctionName(stmt, sf),
            calls: [],
          });
        }
        byStatement.get(key).calls.push({ line: callLine, code });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return [...byStatement.values()]
    .sort((a, b) => a.start - b.start)
    .map((s, i) => ({ id: i + 1, ...s }));
}

/**
 * True when `fn` is an error FACTORY: its whole body is one expression that
 * builds an AssemblyErrorV0. `makeError(code, …)`, `outOfBand(reason, …)` and
 * `refuse(code, …)` all match; ordinary validators do not, because they contain
 * the checks that decide WHETHER to refuse.
 *
 * Two wrong discriminators were tried first, and both are worth recording:
 *   - "body mentions createAssemblyError" swept up every refusing function, so
 *     the enclosing-function skip then deleted all of their sites (93 → 1).
 *   - "the error code is one of the function's parameters" missed `outOfBand`,
 *     whose code is a literal, silently dropping its 12 real call sites.
 * A factory decides nothing; that is what makes it not a refusal site.
 */
function buildsErrorFromOwnParams(fn, sf) {
  if (!fn.body) return false;
  const mentionsCreate = /createAssemblyError\s*\(/.test(fn.body.getText(sf));
  if (!mentionsCreate) return false;
  // A factory RETURNS THE ERROR. A higher-order function that returns a closure
  // is not one, however short its body: `createExecutionAdapter` is a single
  // `return async (...) => {...}` mentioning createAssemblyError deep inside,
  // and classifying it as a factory silently removed every one of its refusal
  // sites.
  const returnsAFunction = (expr) =>
    expr && (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr));

  // Arrow with an expression body: `(...) => ({ ok: false, error: … })`
  if (!ts.isBlock(fn.body)) return !returnsAFunction(fn.body);

  // Block body: a factory is a single `return <error-ish>;` and nothing else.
  const statements = fn.body.statements;
  if (statements.length !== 1 || !ts.isReturnStatement(statements[0])) return false;
  return !returnsAFunction(statements[0].expression);
}

function enclosingFunctionName(node, sf) {
  let n = node;
  const names = [];
  while (n) {
    if (ts.isFunctionDeclaration(n) && n.name) names.push(n.name.text);
    else if (ts.isMethodDeclaration(n) && n.name) names.push(n.name.getText(sf));
    else if (
      (ts.isFunctionExpression(n) || ts.isArrowFunction(n)) &&
      n.parent &&
      ts.isVariableDeclaration(n.parent) &&
      n.parent.name
    ) {
      names.push(n.parent.name.getText(sf));
    }
    n = n.parent;
  }
  return names.length ? names[0] : '(top level)';
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

function applyMutant(original, site) {
  const banner = `/* MUTANT ${site.id}: rejection site disabled (${site.calls
    .map((c) => c.code)
    .join(', ')}) */`;
  // An explicit empty block matters for an unbraced `if (condition) refuse()`:
  // a comment-only replacement would capture the following statement as the
  // new branch body, while an empty statement is rejected by the TypeScript
  // compiler and manufactures a flattering compiler kill. The block compiles,
  // preserves condition side effects, and removes only the refusal body.
  const replacement = site.mutationKind === 'empty-if-body' ? `${banner}{}` : `${banner};`;
  return original.slice(0, site.mutationStart) + replacement + original.slice(site.mutationEnd);
}

function runSuite() {
  // --runInBand deliberately. On a loaded host the parallel workers produce
  // intermittent failures that have nothing to do with the mutation, and a
  // spurious failure reads as a KILL — which would inflate the result in the
  // flattering direction. Do not use --bail: more than one test may observe a
  // mutant, and whichever suite Jest reaches first is not a stable evidence
  // identity. Running the complete suite lets canonicalFailureDetail bind the
  // record to the sorted set of every observing test.
  const res = spawnSync(
    JEST,
    ['test/assembly', '--silent', '--ci', '--runInBand'],
    { cwd: API_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  return { code: res.status, signal: res.signal, error: res.error || null, out };
}

/**
 * ts-jest colourises diagnostics, so the raw bytes read
 * `error\x1b[0m\x1b[90m TS18047:` — a naive /error TS\d+/ never matches and
 * every compiler kill is misfiled as a test kill. Strip SGR sequences first.
 */
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function classify({ code, signal, error, out }) {
  if (error || signal || code === null) return 'HARNESS_ERROR';
  if (code === 0) return 'SURVIVED';
  // ts-jest reports a type error as a suite that never ran. That is not a test
  // observing the behaviour, so it is kept distinct from a real kill.
  const plain = stripAnsi(out);
  if (/error TS\d+/.test(plain) && /Test suite failed to run/.test(plain)) {
    return 'KILLED_BY_TYPECHECK';
  }
  if (/^\s*●/m.test(plain) || /Test Suites:\s+\d+ failed/.test(plain)) {
    return 'KILLED_BY_TEST';
  }
  return 'HARNESS_ERROR';
}

function firstFailureLine(out) {
  const plain = stripAnsi(out);
  // Prefer a named failing test over the generic "suite failed to run" banner,
  // which says nothing about which behaviour noticed the mutation.
  const named = plain.match(/^\s*●(?!\s*Test suite failed to run).*$/m);
  const m = named || plain.match(/error TS\d+:.*$/m) || plain.match(/^\s*●.*$/m);
  return m ? m[0].trim().slice(0, 200) : '';
}

function canonicalFailureDetail(out, outcome) {
  const plain = stripAnsi(out);
  const matches = outcome === 'KILLED_BY_TEST'
    ? plain.match(/^\s*●(?!\s*Test suite failed to run).*$/gm) || []
    : outcome === 'KILLED_BY_TYPECHECK'
      ? plain.match(/error TS\d+:.*$/gm) || []
      : [];
  const normalized = matches.map((line) => line.trim().replace(/\s+/g, ' '));
  const canonical = [...new Set(normalized)].sort().join(' | ');
  return canonical || firstFailureLine(out);
}

// ---------------------------------------------------------------------------
// Source-bound evidence
// ---------------------------------------------------------------------------

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function recursiveFiles(root) {
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '__pycache__') continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...recursiveFiles(absolute));
    else output.push(absolute);
  }
  return output;
}

function bindingPaths() {
  const paths = [
    ...recursiveFiles(path.join(API_ROOT, 'src', 'assembly')).filter((file) => file.endsWith('.ts')),
    path.join(API_ROOT, 'src', 'execution-authority', 'canonical-json-v1.ts'),
    path.join(API_ROOT, 'src', 'execution-authority', 'canonical-json.ts'),
    ...recursiveFiles(path.join(API_ROOT, 'test', 'assembly')).filter((file) => {
      if (file.endsWith('mutation-results.json')) return false;
      return /\.(ts|js|py|json)$/.test(file);
    }),
    path.join(API_ROOT, 'test', 'mutation-evidence.spec.ts'),
    path.join(API_ROOT, 'tsconfig.json'),
    path.join(API_ROOT, 'tsconfig.test.json'),
    path.join(API_ROOT, 'package.json'),
    path.join(REPO_ROOT, 'package.json'),
    path.join(REPO_ROOT, 'pnpm-lock.yaml'),
  ];
  return [...new Set(paths)].sort();
}

function buildBinding() {
  const files = bindingPaths().map((absolute) => ({
    path: path.relative(REPO_ROOT, absolute),
    sha256: sha256Bytes(fs.readFileSync(absolute)),
  }));
  const material = files.map((entry) => `${entry.path}\x00${entry.sha256}\n`).join('');
  return { algorithm: 'sha256', aggregateSha256: sha256Bytes(material), files };
}

function siteMapFor(sites) {
  return sites.map((site) => ({
    id: site.id,
    path: path.relative(REPO_ROOT, site.target),
    line: site.line,
    fn: site.enclosingFunction,
    codes: site.calls.map((call) => call.code),
    mutationKind: site.mutationKind,
    pristineStatementSha256: sha256Bytes(
      fs.readFileSync(site.target, 'utf8').slice(site.start, site.end),
    ),
  }));
}

function siteMapDigest(sites) {
  return sha256Bytes(JSON.stringify(siteMapFor(sites)));
}

function standaloneSiteMap(sites) {
  return {
    targets: TARGETS.map((target) => path.relative(REPO_ROOT, target)),
    count: sites.length,
    siteMapSha256: siteMapDigest(sites),
    sites: siteMapFor(sites),
  };
}

function parseJestCounts(out) {
  const plain = stripAnsi(out);
  const tests = plain.match(/Tests:\s+(\d+) passed,\s+(\d+) total/);
  const suites = plain.match(/Test Suites:\s+(\d+) passed,\s+(\d+) total/);
  return {
    testsPassed: tests ? Number(tests[1]) : null,
    testsTotal: tests ? Number(tests[2]) : null,
    suitesPassed: suites ? Number(suites[1]) : null,
    suitesTotal: suites ? Number(suites[2]) : null,
  };
}

function baselineEvidence(run) {
  const counts = parseJestCounts(run.out);
  const core = {
    outcome: classify(run),
    exitCode: run.code,
    ...counts,
  };
  return { ...core, summarySha256: sha256Bytes(JSON.stringify(core)) };
}

function currentTools() {
  const pnpmVersion = spawnSync('pnpm', ['--version'], { encoding: 'utf8' });
  return {
    node: process.version,
    jest: require('jest/package.json').version,
    typescript: ts.version,
    pnpm: pnpmVersion.status === 0 ? pnpmVersion.stdout.trim() : null,
  };
}

/**
 * F9 (REPORT-PROJ-RULE0): evidence bound to the exact node PATCH that produced
 * it re-pins the toolchain on every regeneration — green on a dev host, red on
 * the CI runner's differing patch, for identical source. The toolchain a
 * mutation record is actually valid FOR is wider than the single point that
 * produced it: node agrees at major.minor (the patch stream a runtime engine
 * ships within), pnpm at major (its lockfile/CLI contract). The exact patches
 * stay in `tools` as provenance; this is the range verification checks.
 */
function toolchainCompatibility(tools) {
  const node = /^v(\d+)\.(\d+)\.\d+/.exec(tools?.node || '');
  const pnpm = /^(\d+)\./.exec(tools?.pnpm || '');
  return {
    nodeMajorMinor: node ? `${node[1]}.${node[2]}` : null,
    pnpmMajor: pnpm ? Number(pnpm[1]) : null,
  };
}

function canonicalInvocation(jsonPath) {
  return {
    cwd: '.',
    argv: [
      'node',
      path.relative(REPO_ROOT, fs.realpathSync(__filename)),
      '--json',
      path.relative(REPO_ROOT, path.resolve(jsonPath)),
    ],
  };
}

function observedInvocation(jsonPath) {
  return {
    cwd: path.relative(REPO_ROOT, fs.realpathSync(process.cwd())) || '.',
    argv: [
      path.basename(fs.realpathSync(process.execPath)),
      path.relative(REPO_ROOT, fs.realpathSync(__filename)),
      '--json',
      path.relative(REPO_ROOT, path.resolve(jsonPath)),
    ],
  };
}

function gitSupplement(repoRoot = REPO_ROOT, evidencePath = 'apps/api/test/assembly/mutation-results.json') {
  // A commit id cannot be embedded in a file contained by that commit: adding
  // the id changes the commit again. It is also unstable after a squash merge.
  // Freeze the effective tracked snapshot instead. A temporary index captures
  // current tracked bytes (including staged new files) and deliberately omits
  // this evidence file, avoiding self-reference while remaining identical in
  // the generation worktree, a clean PR checkout, and the eventual main tree.
  const indexed = spawnSync('git', ['write-tree'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (indexed.status !== 0) throw new Error('cannot read the tracked index for Git supplement');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mun0022-git-snapshot-'));
  const index = path.join(temporary, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const run = (args, options = {}) => {
    const { input, trim = true } = options;
    const result = spawnSync('git', args, {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      input,
    });
    if (result.status !== 0) {
      const reason = String(result.stderr || '').trim().replace(/\s+/g, ' ').slice(0, 300);
      throw new Error(`Git supplement command failed: git ${args[0]}${reason ? `: ${reason}` : ''}`);
    }
    return trim ? result.stdout.trim() : result.stdout;
  };
  try {
    // Seed from the real index so staged additions/deletions are preserved,
    // then update only paths Git already tracks. This represents unstaged
    // deletions by absence and excludes ordinary untracked files (including a
    // rename destination) instead of failing on a missing explicit pathspec.
    run(['read-tree', indexed.stdout.trim()]);
    run(['add', '-u', '--', '.']);
    run(['rm', '--cached', '-f', '--ignore-unmatch', '--', evidencePath]);
    const tree = run(['write-tree']);
    const emptyTree = run(['hash-object', '-w', '-t', 'tree', '--stdin'], { input: '' });
    // Raw recursive diff is a compact Git-native manifest of mode/path/blob
    // changes. Hashing it binds the same bytes as a binary patch without
    // buffering the whole repository-sized patch in memory.
    const diff = run([
      'diff-tree', '--no-commit-id', '--raw', '-r', '-z', '--no-renames', emptyTree, tree,
    ], { trim: false });
    return {
      trackedTreeWithoutEvidence: tree,
      trackedSnapshotDiffSha256: sha256Bytes(diff),
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function enumerateCurrentSites() {
  const originals = new Map(TARGETS.map((target) => [target, fs.readFileSync(target, 'utf8')]));
  const sites = [];
  for (const target of TARGETS) {
    for (const site of enumerateSites(originals.get(target), target)) {
      sites.push({ ...site, target, file: path.relative(REPO_ROOT, target) });
    }
  }
  sites.forEach((site, index) => { site.id = index + 1; });
  return { originals, sites };
}

function recordedOutcomeMatches(recorded, actual) {
  return recorded.outcome === actual.outcome
    && recorded.detail === actual.detail
    && recorded.detailSha256 === sha256Bytes(actual.detail);
}

function verifyRecordedOutcomes(evidence, sites) {
  const originals = new Map(TARGETS.map((target) => [target, fs.readFileSync(target, 'utf8')]));
  const failures = [];
  let dirty = null;
  let stopRequested = null;
  for (const target of TARGETS) fs.writeFileSync(pristineFor(target), originals.get(target));
  const restore = () => {
    if (dirty !== null) {
      fs.writeFileSync(dirty, originals.get(dirty));
      dirty = null;
    }
  };
  const cleanup = () => {
    restore();
    for (const target of TARGETS) {
      const pristine = pristineFor(target);
      if (fs.existsSync(pristine)) fs.unlinkSync(pristine);
    }
  };
  const exitHandler = () => cleanup();
  const signalHandlers = new Map();
  process.once('exit', exitHandler);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => { stopRequested = signal; cleanup(); };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  try {
    for (const site of sites) {
      const recorded = evidence.sites.find((result) => result.id === site.id);
      if (!recorded) {
        failures.push(`fresh outcome missing ${site.id}`);
        continue;
      }
      process.stdout.write(`verify mutant #${String(site.id).padStart(3)} ... `);
      const mutantSource = applyMutant(originals.get(site.target), site);
      fs.writeFileSync(site.target, mutantSource);
      dirty = site.target;
      const run = runSuite();
      restore();
      const outcome = classify(run);
      const detail = outcome === 'SURVIVED' ? '' : canonicalFailureDetail(run.out, outcome);
      const actual = { outcome, detail };
      if (outcome === 'HARNESS_ERROR' || !recordedOutcomeMatches(recorded, actual)) {
        failures.push(`fresh outcome ${site.id}`);
        console.log(`MISMATCH (${outcome}${detail ? `: ${detail}` : ''})`);
      } else {
        console.log(outcome);
      }
      if (stopRequested !== null) {
        failures.push(`verification interrupted by ${stopRequested}`);
        break;
      }
    }
  } finally {
    cleanup();
    process.removeListener('exit', exitHandler);
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  }
  return failures;
}

function verifyResults(jsonPath, replayOutcomes = true) {
  const evidence = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const binding = buildBinding();
  const { sites } = enumerateCurrentSites();
  const failures = [];
  if (evidence.formatVersion !== 'assembly-mutation-evidence-v4') failures.push('formatVersion');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(evidence.generatedAt || '')) {
    failures.push('generatedAt');
  }
  const canonicalEvidencePath = path.join(__dirname, 'mutation-results.json');
  if (JSON.stringify(evidence.invocation) !== JSON.stringify(canonicalInvocation(canonicalEvidencePath))) {
    failures.push('invocation');
  }
  // Exact fingerprints stay pinned for jest/typescript (their outputs are
  // asserted byte-for-byte elsewhere in this evidence); node/pnpm are checked
  // as a compatibility RANGE below, not by exact patch — see
  // toolchainCompatibility().
  const actualTools = currentTools();
  if (evidence.tools?.jest !== actualTools.jest || evidence.tools?.typescript !== actualTools.typescript) {
    failures.push('tools');
  }
  const recordedCompat = evidence.toolchainCompatibility;
  const expectedCompat = toolchainCompatibility(evidence.tools);
  if (JSON.stringify(recordedCompat) !== JSON.stringify(expectedCompat)) {
    failures.push('toolchain compatibility record');
  }
  const actualCompat = toolchainCompatibility(actualTools);
  if (
    !recordedCompat?.nodeMajorMinor || !recordedCompat?.pnpmMajor
    || recordedCompat.nodeMajorMinor !== actualCompat.nodeMajorMinor
    || recordedCompat.pnpmMajor !== actualCompat.pnpmMajor
  ) {
    console.error(
      `TOOLCHAIN_MISMATCH recorded=${JSON.stringify(evidence.tools)} actual=${JSON.stringify(actualTools)}`,
    );
    failures.push('TOOLCHAIN_MISMATCH');
  }
  if (evidence.binding?.aggregateSha256 !== binding.aggregateSha256) failures.push('binding aggregate');
  if (JSON.stringify(evidence.binding?.files) !== JSON.stringify(binding.files)) failures.push('binding files');
  if (evidence.siteMapSha256 !== siteMapDigest(sites)) failures.push('site map digest');
  if (!Array.isArray(evidence.sites) || evidence.sites.length !== sites.length) failures.push('site count');
  try {
    const mapPath = path.join(__dirname, 'mutation-sites.json');
    const actualMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    if (JSON.stringify(actualMap) !== JSON.stringify(standaloneSiteMap(sites))) {
      failures.push('standalone site map');
    }
  } catch {
    failures.push('standalone site map');
  }

  const baselineCore = evidence.baseline && {
    outcome: evidence.baseline.outcome,
    exitCode: evidence.baseline.exitCode,
    testsPassed: evidence.baseline.testsPassed,
    testsTotal: evidence.baseline.testsTotal,
    suitesPassed: evidence.baseline.suitesPassed,
    suitesTotal: evidence.baseline.suitesTotal,
  };
  if (
    !baselineCore ||
    baselineCore.outcome !== 'SURVIVED' ||
    baselineCore.exitCode !== 0 ||
    !Number.isInteger(baselineCore.testsPassed) ||
    baselineCore.testsPassed !== baselineCore.testsTotal ||
    !Number.isInteger(baselineCore.suitesPassed) ||
    baselineCore.suitesPassed !== baselineCore.suitesTotal ||
    evidence.baseline.summarySha256 !== sha256Bytes(JSON.stringify(baselineCore))
  ) {
    failures.push('baseline structure');
  }
  if (JSON.stringify(evidence.supplementalGit) !== JSON.stringify(gitSupplement())) {
    failures.push('supplemental git');
  }

  const actualIds = (evidence.sites || []).map((result) => result.id);
  const expectedIds = sites.map((site) => site.id);
  if (new Set(actualIds).size !== actualIds.length || JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    failures.push('site ids');
  }
  for (const result of evidence.sites || []) {
    const expectedKeys = [
      'id', 'file', 'line', 'enclosingFunction', 'calls', 'mutationKind',
      'pristineSha256', 'mutantSha256', 'outcome', 'detail', 'detailSha256',
    ].sort();
    if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(expectedKeys)) {
      failures.push(`site keys ${result.id}`);
    }
    if (!['KILLED_BY_TEST', 'KILLED_BY_TYPECHECK'].includes(result.outcome)) failures.push(`outcome ${result.id}`);
    if (typeof result.detail !== 'string' || result.detail.length === 0) failures.push(`detail empty ${result.id}`);
    if (sha256Bytes(result.detail || '') !== result.detailSha256) failures.push(`detail ${result.id}`);
    const site = sites.find((candidate) => candidate.id === result.id);
    if (!site) {
      failures.push(`site ${result.id}`);
      continue;
    }
    const source = fs.readFileSync(site.target, 'utf8');
    const expectedSite = {
      file: path.relative(REPO_ROOT, site.target),
      line: site.line,
      enclosingFunction: site.enclosingFunction,
      calls: site.calls,
      mutationKind: site.mutationKind,
      pristineSha256: sha256Bytes(source),
      mutantSha256: sha256Bytes(applyMutant(source, site)),
    };
    for (const [field, expected] of Object.entries(expectedSite)) {
      if (JSON.stringify(result[field]) !== JSON.stringify(expected)) failures.push(`${field} ${result.id}`);
    }
  }
  const expectedSummary = {
    total: (evidence.sites || []).length,
    killedByTest: (evidence.sites || []).filter((result) => result.outcome === 'KILLED_BY_TEST').length,
    killedByTypecheck: (evidence.sites || []).filter((result) => result.outcome === 'KILLED_BY_TYPECHECK').length,
    survived: (evidence.sites || []).filter((result) => result.outcome === 'SURVIVED').length,
  };
  if (JSON.stringify(evidence.summary) !== JSON.stringify(expectedSummary)) failures.push('summary');
  if (evidence.restoration?.verified !== true) failures.push('restoration verified');
  const restorationKeys = Object.keys(evidence.restoration?.files || {}).sort();
  const targetKeys = TARGETS.map((target) => path.relative(REPO_ROOT, target)).sort();
  if (JSON.stringify(restorationKeys) !== JSON.stringify(targetKeys)) failures.push('restoration files');
  for (const target of TARGETS) {
    const relative = path.relative(REPO_ROOT, target);
    if (evidence.restoration?.files?.[relative] !== sha256Bytes(fs.readFileSync(target))) {
      failures.push(`restoration ${relative}`);
    }
  }
  // The authoritative verifier replays the unmutated baseline and EVERY
  // recorded mutant. Hashes alone bind bytes but cannot authenticate whether a
  // mutant was really test-killed or type-killed, nor its observed failure.
  if (failures.length === 0 && replayOutcomes) {
    const baseline = runSuite();
    if (JSON.stringify(evidence.baseline) !== JSON.stringify(baselineEvidence(baseline))) {
      failures.push('baseline');
    }
    if (failures.length === 0) failures.push(...verifyRecordedOutcomes(evidence, sites));
  }
  const freshness = spawnSync('node', [path.join(__dirname, 'generate-credential-policy.js'), '--check'], {
    cwd: REPO_ROOT, encoding: 'utf8',
  });
  if (freshness.status !== 0) failures.push('credential generated freshness');
  if (failures.length) {
    console.error(`mutation evidence verification failed: ${[...new Set(failures)].join(', ')}`);
    return 1;
  }
  if (replayOutcomes) {
    console.log(`Replayed and verified ${evidence.sites.length} source-bound mutation outcomes; no survivors.`);
  } else {
    console.log(`Structurally verified ${evidence.sites.length} source-bound mutation records.`);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);

  // Recover any mutant stranded by a SIGKILLed previous generation OR
  // verification run before inspecting bindings or source hashes.
  for (const target of TARGETS) {
    const pristine = pristineFor(target);
    if (fs.existsSync(pristine)) {
      fs.copyFileSync(pristine, target);
      fs.unlinkSync(pristine);
      console.log(`recovered a stranded mutant in ${path.basename(target)}`);
    }
  }

  if (argv.includes('--verify-results')) {
    const jsonPath = argv[argv.indexOf('--verify-results') + 1];
    return verifyResults(path.resolve(jsonPath));
  }
  if (argv.includes('--verify-structure')) {
    const jsonPath = argv[argv.indexOf('--verify-structure') + 1];
    return verifyResults(path.resolve(jsonPath), false);
  }

  // One flat list across every target, so ids are stable within a run and the
  // map records which file each site lives in.
  const { originals, sites } = enumerateCurrentSites();

  if (argv.includes('--map')) {
    const out = argv[argv.indexOf('--map') + 1];
    fs.writeFileSync(out, `${JSON.stringify(standaloneSiteMap(sites), null, 2)}\n`);
    console.log(`wrote ${out} (${sites.length} sites across ${TARGETS.length} files)`);
    return 0;
  }

  if (argv.includes('--list')) {
    for (const s of sites) {
      console.log(
        `#${String(s.id).padStart(3)}  ${s.file.padEnd(56)} line ${String(s.line).padStart(4)}  ${s.enclosingFunction}  ` +
        `[${s.calls.map((c) => c.code).join(', ')}]`,
      );
    }
    console.log(`\n${sites.length} rejection sites across ${TARGETS.length} files.`);
    return 0;
  }

  const only = argv.includes('--site') ? Number(argv[argv.indexOf('--site') + 1]) : null;
  const jsonPath = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null;

  let dirty = null;
  for (const t of TARGETS) fs.writeFileSync(pristineFor(t), originals.get(t));
  const restore = () => {
    if (dirty) { fs.writeFileSync(dirty, originals.get(dirty)); dirty = null; }
  };
  const dropPristine = () => {
    for (const t of TARGETS) {
      const pr = pristineFor(t);
      if (fs.existsSync(pr)) fs.unlinkSync(pr);
    }
  };
  let stopRequested = null;
  process.on('exit', () => { restore(); dropPristine(); });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { stopRequested = sig; });
  }
  process.on('uncaughtException', (e) => { restore(); console.error(e); process.exit(1); });

  process.stdout.write('baseline: ');
  const baseline = runSuite();
  if (classify(baseline) !== 'SURVIVED') {
    console.log('FAIL — the unmutated suite is not green; fix that first.');
    console.log(firstFailureLine(baseline.out));
    return 2;
  }
  console.log('green');
  const binding = buildBinding();
  const mapSha256 = siteMapDigest(sites);

  const targets = only ? sites.filter((s) => s.id === only) : sites;
  const results = [];

  for (const site of targets) {
    const label = `#${String(site.id).padStart(3)} ${site.file.padEnd(24)} line ${String(site.line).padStart(4)} ${site.calls.map((c) => c.code).join(',')}`;
    process.stdout.write(`${label} ... `);

    const pristineSha256 = sha256Bytes(originals.get(site.target));
    const mutantSource = applyMutant(originals.get(site.target), site);
    const mutantSha256 = sha256Bytes(mutantSource);
    fs.writeFileSync(site.target, mutantSource);
    dirty = site.target;
    const run = runSuite();
    restore();
    await new Promise((r) => setImmediate(r));
    if (stopRequested) {
      console.log(`\nstopped on ${stopRequested} after ${results.length + 1} of ${targets.length} mutants; sources restored`);
      return 130;
    }

    const outcome = classify(run);
    if (outcome === 'HARNESS_ERROR') {
      console.log('HARNESS_ERROR — mutation result is not evidence.');
      console.log(firstFailureLine(run.out));
      return 3;
    }
    const detail = outcome === 'SURVIVED' ? '' : canonicalFailureDetail(run.out, outcome);
    results.push({
      id: site.id,
      file: path.relative(REPO_ROOT, site.target),
      line: site.line,
      enclosingFunction: site.enclosingFunction,
      calls: site.calls,
      mutationKind: site.mutationKind,
      pristineSha256,
      mutantSha256,
      outcome,
      detail,
      detailSha256: sha256Bytes(detail),
    });
    console.log(outcome + (detail ? `  (${detail})` : ''));
  }

  const survived = results.filter((r) => r.outcome === 'SURVIVED');
  const byTest = results.filter((r) => r.outcome === 'KILLED_BY_TEST');
  const byType = results.filter((r) => r.outcome === 'KILLED_BY_TYPECHECK');

  console.log('\n--- mutation summary ---');
  console.log(`files              ${TARGETS.length}`);
  console.log(`sites              ${results.length}`);
  console.log(`killed by test     ${byTest.length}`);
  console.log(`killed by compiler ${byType.length}`);
  console.log(`survived           ${survived.length}`);
  for (const t of TARGETS) {
    const f = path.relative(REPO_ROOT, t);
    const inFile = results.filter((r) => r.file === f);
    if (inFile.length) {
      console.log(`  ${f.padEnd(24)} ${inFile.length} sites, ${inFile.filter((r) => r.outcome === 'SURVIVED').length} survived`);
    }
  }

  if (jsonPath) {
    const restorationFiles = Object.fromEntries(TARGETS.map((target) => [
      path.relative(REPO_ROOT, target), sha256Bytes(fs.readFileSync(target)),
    ]));
    const generatedTools = currentTools();
    const evidence = {
      formatVersion: 'assembly-mutation-evidence-v4',
      generatedAt: new Date().toISOString(),
      invocation: observedInvocation(jsonPath),
      tools: generatedTools,
      toolchainCompatibility: toolchainCompatibility(generatedTools),
      binding,
      supplementalGit: gitSupplement(),
      baseline: baselineEvidence(baseline),
      siteMapSha256: mapSha256,
      sites: results,
      summary: {
        total: results.length,
        killedByTest: byTest.length,
        killedByTypecheck: byType.length,
        survived: survived.length,
      },
      restoration: { verified: true, files: restorationFiles },
    };
    fs.writeFileSync(jsonPath, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`\nwrote ${jsonPath}`);
  }

  if (survived.length) {
    console.log('\nSURVIVING MUTANTS — each must be fixed or given a named reason:');
    for (const s of survived) {
      console.log(`  #${s.id} ${s.file} line ${s.line} ${s.enclosingFunction} [${s.calls.map((c) => c.code).join(', ')}]`);
    }
    return 1;
  }
  console.log('\nNo surviving mutant.');
  return 0;
}

module.exports = {
  applyMutant,
  canonicalFailureDetail,
  classify,
  currentTools,
  enumerateSites,
  gitSupplement,
  recordedOutcomeMatches,
  toolchainCompatibility,
};

if (require.main === module) {
  main().then((c) => { process.exitCode = c; });
}
