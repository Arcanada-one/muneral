# Process canary: regenerate-derived-artefacts workflow shell-input contract

`contour=candidate-local`. Subject commit `b96914f0c658cdbe3ce9512868634ff6946c038f`, tree `91b45b59d8c0e7a0a5d0dcb047178d885dfee2dd`; base `origin/main` was `df0df15d6081cfcfa19a11ff87790a5f942645e6`. The source worktree was clean at the measured commit (`source-evidence.json`). This is not a GitHub Actions run or a production probe. No exemption is written.

## Entities and outcomes

| Entity | Probe | Outcome |
|---|---|---|
| `code_unit:.github/workflows/regenerate-derived-artefacts.yml` | `workflow-no-inline-expression-contract` | verified |
| `code_unit:apps/api/test/regenerate-derived-artefacts.workflow.contract.spec.ts` | `workflow-no-inline-expression-contract` | verified |

The process probe ran the API Jest configuration in bubblewrap with private user, network, PID, IPC and UTS namespaces. Candidate source was read-only at `/repo`; Git metadata was read-only and exposed only to load `origin/main` for the regression control; `/tmp` was private tmpfs and network was disabled. The Node 24.20.0 executable and its SHA256, command, source hashes and plan digest are recorded in `plan.json` and `result.json`. The exact contract suite completed with exit 0: one suite, seven tests.

The seven cases cover: no hazardous GitHub expression in the candidate's `run:` blocks; detection of all five direct interpolations in the original `origin/main` workflow; safe-then-unsafe expressions on one line; no-space step-output syntax; an expression in a heredoc; an expression later in a multiline run block; and literal handling of a hostile PR ref passed through quoted environment variables.

## Limits

The candidate-local process canary used Node 24.20.0; repository CI pins Node 26.13.0. The same test passed locally on Node 26.13.0, but this canary does not establish Node 26 equivalence. It did not execute the GitHub Actions workflow, exercise GitHub's expression engine or token permissions, observe hosted CI on the exact PR head, or establish production behavior. Hosted exact-head CI remains `NOT_MEASURED` under the local-only instruction. The graph verifier's workflow-shell closure uncertainty is not erased by this candidate-local test.

## Negative controls and harness calibration

`negative-controls.txt` retains the original-main RED control, all four adversarial scanner controls, the first candidate-local sandbox failure caused by linked-worktree Git metadata being outside the `/repo` mount, and the corrected `BASE_SHA` placement. The sandbox plan exposes Git metadata read-only for the original-main control. An earlier wrong-working-directory calibration from the prior candidate remains historical harness evidence. The recorded process result is the succeeding invocation for this subject commit only.
