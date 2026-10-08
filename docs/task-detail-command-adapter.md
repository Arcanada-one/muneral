# Read-only task-detail command adapter

I05 (`7d2dadd3-8cf0-47fb-925e-71b9e2962bab`) implements the accepted F08 planning contract. The existing HTTP client owns transport, Query owns task content, Next owns committed navigation, and the per-session controller owns selection generation and read outcome. There are no task/dependency writes or persisted controller state.

`openTask({workspaceSlug, projectSlug, taskId})` requests local navigation and a replace-read. The page observes direct route changes without manufacturing a navigation acknowledgement. A read becomes ready only after the committed tuple and the validated backend task ID/project agree. Workspace and project slugs are resolved through authorized GET responses; URL strings confer no authority. Missing, denied, unavailable and loading are distinct outcomes.

The provider replaces its QueryClient on session loading, logout or access-token replacement using an opaque lifetime counter. Credentials never enter query keys or snapshots. A route change immediately hides mismatched content before its effect runs. Cancellation, generation, committed-route and session-lifetime checks fence late responses. The total read deadline is ten seconds, with at most one transport/5xx retry; 401/403, missing and malformed responses are not retried. These reads opt out of the legacy Axios refresh interceptor, avoiding refresh POST/sign-out side effects in the command.

The internal snapshot contains one selection, outcome, generation, optional validated backend revision and update timestamp. `readback` freshness means a successful completed GET, not a continuous authorization guarantee. Missing revision stays unknown. No task title, description, dependencies, credentials or evidence locator is exposed. No automation port is installed: F06 remains unaccepted. Existing TaskDetail editing components retain their existing authorization contract outside this pilot.

The tests control API responses that ignore cancellation, late A after B, the same task under distinct session lifetimes, logout/loading invalidation, tuple mismatches, malformed payloads, navigation commit mismatch, deadlines, bounded retry, duplicate commands and double disposal. React tests mount the real page/provider/controller/Query integration in jsdom, including StrictMode. They do not prove real Next URL hydration. Mutation controls run in disposable copies, never against production.

E4 backend evidence is the separately accepted production synthetic principal-pair receipt on deployed `43e79c97`: own 200 16/16, foreign 403 16/16 without foreign title, anonymous 401 8/8, exact teardown verified. It does not prove this frontend adapter is deployed. E5 real-engine direct URL/hydration and production rollout of this adapter remain NOT_MEASURED. Graph admission and exact-head CI must independently pass before merge; this source PR grants no merge/deploy authority.

## Task-owner registry note

Root explicitly transferred I05 from the wound-down FRONTEND lane to MUNERAL on 2026-10-08 at 11:31Z. The existing worktree `/home/dev/aup/frontend-work/muneral-ui-read-errors` and branch `Arcanada/frontend-read-adapter-7d2dadd3-20261008` were reused from `b961414`. No competing branch or owner was created; `muneral-f08-task-detail-passport` is untouched. The transfer and `in_progress` status were recorded in Muneral with GET readback. Root's separate source implementation dispatch supersedes the discovery-only restriction, without granting deployment or Canon activation.

The inherited carrier was merged with current main. Fourteen historical branch-only preparation documents/receipts were omitted from this source delta; their bytes remain in commit history at `898468d` and in the lane's SHA256 archive manifest. They are not reissued as verification of this adapter. Knowledge-contract runtime admission remains NOT_MEASURED (`runtime_authorized=false`); the explicit source dispatch is not relabelled as knowledge admission.

Rollback removes this adapter, restores the original page/provider and removes the read-only interceptor opt-out. No data migration, backend edit, new credential system or production effect is involved.
