# Task graph content reference

Graph documents belong to their Muneral work item. They reuse immutable
`TaskArtifactRevision` bytes, server SHA256, `TaskEvidenceAttachment`, task quotas
and authenticated actor audit. They do not create assignments, execution attempts,
dependencies or lifecycle transitions. Dependency graphs remain derived from
`TaskDependency`.

| Method | Route | Result |
| --- | --- | --- |
| POST | `/tasks/:taskId/graphs/:kind` | Immutable graph revision with server hash |
| GET | `/tasks/:taskId/graphs/:kind` | Latest revision, document and base64 content |
| GET | `/tasks/:taskId/graphs/:kind/:revision` | Historical revision with content |
| GET | `/tasks/:taskId/graphs/:kind/revisions?page=1` | Metadata, total and next page |

`kind` is `task_graph` or `agent_graph`. Reads require current dashboard membership
or actual assigned-agent workspace custody. Writes require an assigned agent key;
the service rechecks custody independently of the route guard. The actor comes
from credentials. Clients cannot submit actor attribution.

The POST body is `{ "expectedRevision": 0, "document": ... }`. Zero means no
existing graph of that kind. The document's `graph_revision` must be
`expectedRevision + 1`. Under the task lock the server compares the current
revision; a stale writer or concurrent loser gets HTTP 409 without an audit,
evidence or byte write. Graphs use fixed name `graph` and media type
`application/json`. Documents are limited to 64 KiB; existing task content quotas
include graph revisions. Server serialization of the validated JSON determines
the stored bytes and hash; preserve `contentBase64` to verify that exact hash.
The existing artifact get-by-ID and get-by-SHA routes also resolve graph content
for `ReadArtifact(ref)`. Artifact references may pin any immutable content kind
inside this task, including an earlier graph revision. Metadata listing retains
the separate kind-specific routes. Hash lookup identifies equivalent bytes and
may return the oldest equivalent revision; use the ID to pin one exact revision.

`WorkItemTaskGraph/v1` physically represents CTR-008 and AEAS-0503/0505. It requires
`schema`, `kind`, `work_id`, `graph_revision`, `root_goal_digest`, `nodes`, `edges`
and `decomposition`. The goal digest is lowercase SHA256 of the current task
description in UTF-8, or title when the description is null. It pins the observed
intent at this revision; it does not enforce lifecycle amendments.

Nodes have `node_id`, `node_version`, nullable `task_id`, `dependencies`, `inputs`,
`expected_outputs`, `verifier`, nonempty `acceptance`, `risk`, `state` and nullable
`budget`. A non-null native task ID must be this task or a direct child in the same
workspace. Inputs are artifact references `{artifact_id, sha256}`. Expected
outputs have `name`, `schema`, positive `version` and `artifact_refs`.

Edges have `from`, `to`, the existing dependency vocabulary
`depends_on|blocks|related_to|duplicates`, `accepted_outcome_predicate`, `schema`,
positive `version` and `artifact_refs`. Their direction is producer to consumer.
Each node's dependencies exactly match its incoming graph edges; each edge's
schema/version matches a declared producer output. Duplicate pairs, cycles,
self-edges and dangling nodes are rejected. Predicates and node state are stored
assertions; this API neither executes predicates nor changes native readiness.
Decomposition is `{decision: "split"|"no_split", reason: ...}`.

`WorkItemAgentGraph/v1` represents CTR-009/010 and the AEAS-1503 ID separation. It
requires `schema`, `kind`, `work_id`, `graph_revision`, `runs` and `delegations`.
A run has `node_id`, `run_id`, `agent_id`, `task_id`, nullable `attempt_id`,
nullable `attempt_binding_reason`, `node_version`, nullable `retry_ordinal`,
nullable `lease_ref`, `fence` and `package_digest`, `state`, nullable `session_id`,
`dispatch_id` and `terminal_id`, and `invocation_ids`. The tuple of observed run,
agent, session and dispatch is unique; an orchestration run may span several
distinct dispatch nodes. Invocation IDs are unique in the document. Its agent must be assigned to this task in the actual
workspace. A native attempt ID must already belong to the task; `retry_ordinal`
equals its one-based native ordinal minus one, and its state matches at the write.
An absent native attempt requires a reason and
null ordinal, and never causes an attempt to be issued. Lease, fence, package and
session observations do not grant authority or control Orca lifecycle.

Delegations have `parent_node_id`, `child_node_id`, `objective`, nonempty
`invariants`, `context_refs`, `tools`, nullable `budget`, `stop_escalation` and
`return_schema`. They form a DAG over the run node IDs. A budget is
`{unit, limit}` with a finite nonnegative limit; storing it does not allocate or
enforce that budget. Artifact references resolve actual artifact revisions and
hashes inside this work item. Native references are checked in the same write
transaction. Both schemas reject unknown fields, cap nodes/runs at 200 and
edges/delegations at 1000, and bound text and reference lists.

Task and agent graphs are independently versioned. Every successful graph write
records `task:content_uploaded` with kind, name, revision, server hash and byte
size. Audit failure rolls back the graph revision and linked evidence together.
SQL updates to existing revisions remain forbidden.
