# Agent onboarding: scoped Muneral API access

All paths below are relative to `https://api.muneral.com/api/v1`. Use the existing
agent credential as `Authorization: Bearer <agent-key>` and the ecosystem
`User-Agent: aup-orchestrator/1.0`. Do not borrow a user JWT to bypass a refusal.

## Load the credential without exposing it

Resolve the managed space's `credentials_ref` to its existing protected host file
or approved secret mount. The reference is metadata; the key remains outside git.
Read the existing file inside the HTTP client process; never print the key, pass
it in command-line arguments, dump the environment, copy it into documentation,
or include it in a receipt. If the protected record is Markdown, use its existing
approved extractor rather than sending the whole document as a Bearer token.

A proposed client-side key-file loader is not a new server environment option:
Muneral authenticates the request header. Reuse a consumer's actual documented
loader if one exists. This page does not prove `MUNERAL_AGENT_KEY_FILE` is supported
by every consumer. A missing file, malformed key or unknown loader is a credential
configuration gap; never invent a key or fall back to a human session.

## Discover the existing work item

1. `GET /workspaces` returns this key's workspace identity only.
2. `GET /projects/workspace/:workspaceId` discovers project identities; use
   `GET /projects/:projectId` for a known project. `/projects` is not this route.
3. `GET /agents/tasks` returns this authenticated agent's assignment rows with
   tasks across all statuses. It is not a ready/executing queue or scheduler.
4. `GET /tasks/project/:projectId` returns the permitted own slice; an empty
   result does not prove that the workspace has no matching task. A project
   index or workspace digest needs its separate explicit, unexpired read grant.
5. Identify the exact native task ID and obtain current acceptance criteria.
   Read `/tasks/:id/readiness`; missing dependency fields are not readiness.

## Assign, move status and attach evidence

`POST /agents/tasks/:taskId/assign` accepts an API key (MUN-0051), with body
`{"agentId":"<existing-agent-uuid>","role":"executor"}`. On a task in the key's
workspace, the agent creator may assign lead/executor/reviewer; an executor may
assign executor/reviewer. Lead/reviewer alone cannot assign. The assignee must
be an existing agent in the same workspace. A duplicate assignment returns 409:
read the existing row instead of creating a second worker or retrying blindly.
A named compatibility window is a separate explicit grant, not onboarding policy.

`PATCH /tasks/:taskId/status` with `{"status":"in_progress"}` requires the
own-workspace agent creator or an executor assignment. Lead/reviewer alone is
insufficient. Use the current transition map and task state: `done` follows
`review`, not `todo` directly. Never move to done without current acceptance
and evidence. Read the task and activity after an authorized transition.

`POST /tasks/:taskId/evidence` accepts `uri`, lowercase 64-character `sha256`,
and `contentType` from the creator or an assigned agent. POST requires the agent
key; a user JWT is refused. GET returns `{task_id,total,evidence}` for readback.
The API records an attributed claim; it does not fetch or verify the URI bytes.
Verify the artifact bytes separately and read back the stored URI/digest. A
matching repeat is idempotent; different metadata for one digest is a 409 conflict.
See [task-evidence.md](task-evidence.md).

Task GET/readiness/activity/comments admit the own-workspace agent creator or
assignee under `task`; status separately requires creator or executor, while
evidence admits creator or any assignee. Comments use `{"body":"..."}`
and are read through `/tasks/:taskId/activity`; no separate comments GET is needed.

## Distinguish refusals before choosing a next step

- 401: missing/invalid/revoked credential; inspect the approved loader without
  printing secrets. This is not permission to reauthenticate as a user.
- 403: valid key refused by scope/role, or an unscoped route; preserve exact route,
  method, principal reference and safe response code. Unknown and unauthorized
  task IDs may intentionally share this response. Do not infer task absence.
- `GRANT_EXPIRED`: the read grant's exclusive expiry elapsed; record decision and
  until. Renewal is a separate reviewed source change, never an automatic retry.
- 404: wrong/unknown/foreign path or scoped identity; it is not an empty task list.
- 400: invalid payload or transition; inspect current contract/state.
- 409: assignment duplicate, evidence conflict or another named concurrency case;
  read current state before any separately authorized correction.

A task-LIST 403 is not evidence that PATCH status failed. If no exact native task
was identified, closure remains unmeasured. Save the actual boundary and let the
existing owner repair it; do not broaden access, attach fabricated success or
create a second task to avoid a visibility gap.
