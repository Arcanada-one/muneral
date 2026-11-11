# Process canary: scripts/ci/tested_tree.py (muneral#427 pin update)

contour=candidate-local. Subject: branch `mun-hyg/mun-ci-head-ref-env-20261112` at commit
`d62cea754d2d1ac1dcdabd69694a5f9c1b1d491f`, tree `1aef16b9191bc48e86139f219e69e24151d94656` (clean detached worktree,
`dirty=false`, see `source-evidence.json`); base Muneral `main` at `84938538ecd10a4b8ebaf371adeb2e8f4443cd91`. This is NOT a production probe and
MUST NOT be reported as one. No exemption is written by this record.

## Entity and outcome (CanaryResult/v2, `result.json`)

| Entity | Probe | Outcome |
|--------|-------|---------|
| `code_unit:scripts/ci/tested_tree.py` | `ci-tested-tree-qualification-unit-tests` | verified |

The probe runs `/usr/bin/python3.12 -I scripts/ci/test_tested_tree.py` (the command of ci.yml step "tested_tree_unit") inside
bubblewrap private user/net/pid/ipc/uts namespaces (`run_sandbox.sh.txt`), source read-only at `/repo`, no network.
Expectation: exit 0, stderr contains "Ran 14 tests" and a line "OK". Producer: `harness.py.txt` (vendored
`process_observation.run`); plan: `plan.json`.

## What it measures, and what it does not

The 14 cases exercise the module's qualification logic with the real `.github/workflows/ci.yml` bytes of the measured
tree: the pinned-workflow identity check (sha256 of the whole workflow against QUALIFIED_WORKFLOW_SHA256,
tested_tree.py:45-47) returns true for those bytes, refuses changed effective fields and identity operands, refuses
foreign repo / wrong base / wrong tree / failed proofs, and the deploy-readiness decision stays false unless reuse or cold
success and every gate hold. LIMITS: the GitHub API client (`GitHubAPI`) is exercised with stubs only, no network;
the CI step wiring that consumes the module and a deployed run are NOT measured; the input manifest is a named set, not
a full import closure.

## Execution-input attribution

Product files under `/repo` are `product_source`. The interpreter is `/usr/bin/python3.12` (the real file, because the
producer opens the executable with O_NOFOLLOW and refuses the `python3` symlink), attributed as `system_executable`
with its measured sha256.

## Negative controls (supplementary, not part of the CanaryResult)

`negative-controls.txt` (verbatim): the same raw command in the same sandbox over copies of the tree. NEG0 unmodified:
14 OK, exit 0. NEG1 first hex char of QUALIFIED_WORKFLOW_SHA256 changed: 2 of 14 failed, exit 1. NEG2 one byte appended
to the ci.yml copy: 2 of 14 failed (identity mismatch; qualification false), exit 1. The mutants ran the raw commands,
not the plan, so their digests are not part of any CanaryResult.

## Other limits

Escaped descendants are not proven absent (tool wording). Whether graph-admission on the PR accepts a
candidate-local result for this entity is NOT_MEASURED until it runs on the PR head.
