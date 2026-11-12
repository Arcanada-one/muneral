# Process canary: apps/api/scripts/{jest-list-tests,run-jest-isolated,run-jest-isolated.test}.mjs (muneral#428, MUN-JEST)

contour=candidate-local. Subject: branch `fix/api-jest-suite-really-runs` at commit `c585def401af0888e7c94a7d7ca7f3beed5c8932`, tree `c99e23f684304f8e9ace9b4f9a2ab312b248a2fa`
(clean detached worktree, `dirty=false`, see `source-evidence.json`; base Muneral `main` at `335a500a717b87aa308daa43fd4f15c659ee484d`).
This is NOT a production probe and MUST NOT be reported as one. No exemption is written by this record.

## Entities and outcomes (CanaryResult/v2, `result.json`)

| Entity | Probes | Outcome |
|--------|--------|---------|
| `code_unit:apps/api/scripts/jest-list-tests.mjs` | contract-unit-tests, runner-refuses-below-minimum | verified |
| `code_unit:apps/api/scripts/run-jest-isolated.test.mjs` | contract-unit-tests | verified |
| `code_unit:apps/api/scripts/run-jest-isolated.mjs` | runner-refuses-below-minimum, runner-refuses-zero-files-old-ci-flags, runner-real-run-json-report | verified |

Probes (all non-mutating; `/usr/bin/node`, real jest from the installed workspace, inside bubblewrap private user/net/pid/ipc/uts namespaces,
source read-only at `/repo`, private tmpfs `/tmp`, no network; `run_sandbox.sh.txt`, producer `harness.py.txt`, plan `plan.json`):
1. `contract-unit-tests`: `node --test apps/api/scripts/run-jest-isolated.test.mjs` -> exit 0, "pass 5", "fail 0".
2. `runner-refuses-below-minimum`: `run-jest-isolated.mjs --min-test-files 1000 --json` -> exit 1, "only 127 Jest test files discovered", "expected at least 1000" (real jest `--listTests --json`).
3. `runner-refuses-zero-files-old-ci-flags`: `run-jest-isolated.mjs --passWithNoTests --json nosuchtestpattern_xyz` (the old CI flags, no match) -> exit 1, "no Jest test files were discovered (0 found)". Before the fix this exited 0.
4. `runner-real-run-json-report`: `run-jest-isolated.mjs --min-test-files 1 --json --outputFile /tmp/jest-report.json src/activity/comment-body-from-payload.spec.ts` -> exit 0, "1 test files discovered", "6 passed".

## What it measures, and what it does not

It measures the parser, the fail-closed rule, the minimum-count flag and one real end-to-end run of the runner through the `--json` form on the exact tree.
LIMITS: the input manifest is a named set (node, the three scripts, apps/api/package.json), not a full import closure (jest, ts-jest and node_modules are not hashed);
the merged `--outputFile` report is produced in the sandbox `/tmp` but its content is not asserted by the plan (only exit and the printed counts);
the full 127-file suite is NOT run here (it needs a disposable PostgreSQL): it is measured by the CI step `Jest machine report` on the PR head.

## Negative controls (supplementary, not part of the CanaryResult)

`negative-controls.txt` (verbatim) runs the same raw commands in the same sandbox with one file overlaid by a mutant (`mutants/*.txt`; sandbox script `negative-control-sandbox.sh.txt`).
NEG0 unmodified: 5 pass, exit 0. NEG1 parser treats every line as a path (the original --json defect): 3 of 5 contract tests fail, exit 1.
NEG2 zero-files check removed from `assertEnoughTestFiles`: 1 of 5 fails, exit 1. NEG3 runner without the zero-files check, probe 3 command: exit 0 (the probe expects 1, so it would be refused).
NEG4 runner splitting the listTests text by lines (the original defect), probe 4 command: exit 0 as well; this mutant is NOT detected by the exit code. It is detected by the
content expectation of probe 4: it prints "Invalid testPattern [...]" and "Running all tests instead" and does not print "6 passed". So probe 4 relies on its `stderr_contains`, not on the exit code.

## Other limits

Escaped descendants are not proven absent (tool wording). Whether graph-admission accepts a candidate-local result for these entities is NOT_MEASURED until it runs on the PR head.
