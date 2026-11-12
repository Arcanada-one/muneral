# Process canary: regenerate-derived-artefacts workflow shell-input contract

`contour=candidate-local`. Subject: candidate commit `a81b59dcb8495ed366755d95aa309d3081ef3f30`, tree `b3e3ec25c80fa7a7ac56f106324799fa2796913a`; base `main` was `df0df15d6081cfcfa19a11ff87790a5f942645e6`. The source was clean at the measured subject (`source-evidence.json`). This is not a GitHub Actions run or a production probe. No exemption is written.

## Entities and outcomes

| Entity | Probe | Outcome |
|---|---|---|
| `code_unit:.github/workflows/regenerate-derived-artefacts.yml` | `workflow-no-inline-expression-contract` | verified |
| `code_unit:apps/api/test/regenerate-derived-artefacts.workflow.contract.spec.ts` | `workflow-no-inline-expression-contract` | verified |

The process probe ran the real API Jest configuration in a bubblewrap user, network, PID, IPC and UTS namespace. Source was read-only at `/repo`; `/tmp` was a private tmpfs and network was disabled. The exact command, executable and selected source hashes are recorded in `plan.json` and `result.json`. It ran two contract cases: no untrusted GitHub expression is directly interpolated into any `run:` block, and a hostile PR ref remains literal when passed through quoted environment variables.

## Limits

The canary used the host Node `v24.20.0`; the repository CI workflow pins Node `26.13.0`. It did not execute the GitHub Actions workflow, exercise GitHub's expression engine or token permissions, observe a hosted CI run on the exact PR head, or establish production behavior. Hosted exact-head CI remains `NOT_MEASURED` under the task's local-only instruction. The graph verifier's workflow-shell closure uncertainty is not erased by this candidate-local test.

## Negative controls and harness calibration

`negative-controls.txt` records the successful fixed candidate, the earlier red control against the original `origin/main` workflow (the static test failed on five direct shell interpolations), and the first sandbox invocation's wrong working directory. The sandbox plan was corrected to run from `apps/api`; the final recorded process result is the succeeding invocation only.
