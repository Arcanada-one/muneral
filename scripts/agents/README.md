# Fleet task custody instruction — MUN-ARTIFACTS migration draft

Status: preparation only. The content API is reviewed but has not shipped.
Do not describe this draft, a successful local canary, or a queued deployment as
fleet adoption. Later checklist, typed graph and open-task routes remain separate
delivery stages. DEC-AUP-0153 is merged; the source and deployment gates still apply.

Read the assigned Muneral work item before execution. Store every plan, task-local
graph, agent history, artifact and verification receipt as full content in that
work item. A local file can be a working copy, but a `file://` pointer does not
deliver its contents to the work item. Do not attach a pointer as the substitute
for a refused or unavailable content upload.

Until the content route ships, store content in task comments. Larger documents
may use ordered `WorkItemCommentContentChunk/v1` records with full-document SHA256,
size, chunk index/count, chunk SHA256 and actual base64 bytes. Read the comments
back, reconstruct every chunk, and compare the original bytes. These comment
digests are client-computed; do not label them server-computed artifact digests.

After the route ships, use `POST /api/v1/tasks/:taskId/artifacts/bytes` for one
bounded multipart `content` file and `name`, `contentType`, optional expected
`sha256` metadata. The server cap is 1 MiB; JSON/base64 uploads retain their
64 KiB cap. Per-task quotas are 16 MiB and 1000 revisions. Do not silently split
or truncate a document to make it fit. Return a specific unresolved disposition
for oversize or missing legacy evidence and retain its original reference.

Use the task's assigned agent credential from a protected key file. The dispatcher
must establish the authorized task assignment; the helper must not create a new
identity or obtain a wider grant to work around a refusal. Never print a key,
include it in a receipt, forward it through redirects, or put it in a URL.

Compare the upload's server SHA256 and size with the actual input bytes. Read the
new revision by ID and compare its bytes, then read by SHA and compare its bytes.
A SHA can identify an older equivalent revision, so ID readback establishes the
specific appended revision. Follow every metadata-list page when completeness is
required. A to B to A creates revisions 1, 2 and 3; only a retry of the latest
bytes is idempotent. Preserve earlier revision IDs and their immutable contents.

Maintain task-local graph and agent-history content with the existing vocabulary:
CTR-007 WorkItem, CTR-008 TaskNode, CTR-009 Attempt, CTR-010 DelegationCard and
AEAS-1503 causal IDs. Link the existing Task, Dispatch, Run, terminal and session.
Record a native TaskExecutionAttempt ID only if its actual binding is known.
Do not mint an attempt from a restart, reinterpret a trace ID as business identity,
or treat the graph as permission to launch a new worker. Orca remains the process
and dispatch lifecycle authority. Dependency graphs remain derived from Muneral
dependencies. Until typed graph/CAS routes ship, label comment-held graph content
as drafts and record schema validation/CAS as not measured.

When typed graph routes ship, send the expected graph revision, preserve accepted
history, and treat a CAS conflict as a fresh-read/reconciliation requirement.
Do not overwrite a concurrent writer's graph. Checklist writes use the assigned
task scope and credential-derived actor, with atomic audit; marking a checkbox
does not substitute for an acceptance receipt.

Keep source review, graph admission, CI, merge, resulting main, deployment and
production readback as separate observations. Store their complete receipts in
the work item. Report finite results to the existing coordinator with the current
Task/Dispatch IDs. Do not close a work item on local source evidence alone.

Migration delivery must verify one real fleet helper and one coordinator tick or
agent brief use this flow after deployment. Backfill high-value pointer evidence
through a follow-up work item after checking for an existing owner and deduplicating; report missing
files, permission refusals and oversize documents rather than claiming success.

## Reviewed content helper

The canonical source candidate is `scripts/agents/attach.py`. It is the existing
reviewed content helper, published without a second implementation. The following
command requires the shipped content API and an assigned-task key; it does not
install the helper into any live fleet lane or restart a coordinator.

```sh
python3 scripts/agents/attach.py --task-id "$TASK_ID" --file "$ARTIFACT_PATH" \
  --content-type application/json --credentials "$MUNERAL_AGENT_KEY_FILE"
```

Set the MIME type to the actual document type. The command prints a
`MuneralContentUploadReadback/v1` only after upload and exact ID/SHA byte readback.
A transport error, refusal or mismatched readback exits nonzero with a fixed
credential-free message; it never attaches a legacy pointer. Keep the receipt as
content in the same work item. Before activating an existing helper or Root tick,
verify its current owner, source and named Run/Dispatch; a historical copy is not
proof of the running source.
