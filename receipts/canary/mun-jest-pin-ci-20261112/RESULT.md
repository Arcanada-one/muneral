# Process canary: scripts/ci/tested_tree.py (muneral#428 pin update, MUN-JEST)

contour=candidate-local. Subject: branch `fix/api-jest-suite-really-runs` at merge commit
`8e497274222bb7d9dd888b2f2c1ae60b8201d197`, tree `0fa96178dc9fd5ed00d9547e29a1d193fc567ab7` (clean detached worktree, `dirty=false`, see `source-evidence.json`); the commit is
the merge of Muneral `main` at `335a500a717b87aa308daa43fd4f15c659ee484d` (#429) into the PR head. This is NOT a production probe and
MUST NOT be reported as one. No exemption is written by this record.

## Entity and outcome (CanaryResult/v2, `result.json`)

| Entity | Probe | Outcome |
|--------|-------|---------|
| `code_unit:scripts/ci/tested_tree.py` | `ci-tested-tree-qualification-unit-tests` | verified |

The probe runs `/usr/bin/python3.12 -I scripts/ci/test_tested_tree.py` (the command of ci.yml step "tested_tree_unit") inside
bubblewrap private user/net/pid/ipc/uts namespaces (`run_sandbox.sh.txt`), source read-only at `/repo`, no network.
Expectation: exit 0, stderr contains "Ran 14 tests" and a line "OK". Producer: `harness.py.txt` (vendored
`process_observation.run`, copied from the MUN-HYG precedent receipts/canary/mun-hyg-pin-ci-20261112); plan: `plan.json`.

## What it measures, and what it does not

The 14 cases exercise the qualification logic with the real `.github/workflows/ci.yml` bytes of the measured tree: the pinned-workflow
identity check (sha256 of the whole workflow against QUALIFIED_WORKFLOW_SHA256 = 27793610e73665c8dc7b15e44d753f90bbe19c55c9a6accaa5a209984759dbc5)
returns true for those bytes and refuses changed effective fields, foreign repo, wrong base/tree and failed proofs. LIMITS: the
GitHub API client is exercised with stubs only, no network; the CI step wiring and a deployed run are NOT measured; the input manifest is a
named set, not a full import closure. The jest change itself (run-jest-isolated.mjs) is NOT covered by this canary; it is covered by the
node:test contract test and by the full-suite CI step on the PR head.

## Negative controls (supplementary, not part of the CanaryResult)

`negative-controls.txt` (verbatim): the same raw command in the same sandbox over copies of the tree (git archive of scripts/ci and
.github/workflows). NEG0 unmodified: 14 OK, exit 0. NEG1 first hex char of QUALIFIED_WORKFLOW_SHA256 changed: 2 of 14 failed, exit 1.
NEG2 one byte appended to the ci.yml copy: 2 of 14 failed, exit 1.

## Other limits

Escaped descendants are not proven absent (tool wording). Whether graph-admission on the PR accepts a candidate-local result for this entity is
NOT_MEASURED until it runs on the PR head. The graph receipt (verify.py --canary) is NOT part of this directory.
