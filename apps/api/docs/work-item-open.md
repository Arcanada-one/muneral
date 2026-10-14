# Whole work-item content read

`GET /api/v1/tasks/:taskId/open` returns `WorkItemOpen/v1`. It uses the existing
task-evidence scope. An agent must currently belong to the workspace and be
assigned to this task; a human must currently be a workspace member. The service
rechecks this custody in the same repeatable-read transaction as the data.

The response contains the native task row, ordered task activity, checklist,
assigned agent identity/name/role, existing native execution attempts, all artifact
revisions with `contentBase64`, server SHA256 and immutable revision metadata,
both graph document histories, evidence records, and a dependency graph derived
from existing `TaskDependency` rows. It never selects agent API-key material.

`graphs.task_graph` and `graphs.agent_graph` each contain `state`,
`latestRevision` and `revisions`. An absent graph has `state: "absent"`,
`latestRevision: null` and an empty revision list. Every stored graph revision
includes its parsed `document`, bytes and SHA256. An absence is not a verified
plan. The read does not issue an attempt, lease, assignment or permission.

`completeness` declares the database snapshot and exact returned counts. There
is no metadata pagination or chronology truncation on this endpoint. Content
remains bounded by the existing per-task upload quota. Every revision's size and
digest are checked before returning any response; a mismatch refuses the whole
read. Evidence `availability` distinguishes `server_content` from
`legacy_pointer`; a legacy URI is never fetched and is not proof of stored bytes.

Dependencies retain same-workspace endpoints even when another executor owns
the counterpart. Following MUN-0055, an agent receives its ID/status/project ID,
without a title unless the existing creator-or-assignee predicate permits text.
Both edge directions remain present. Human membership is rechecked in the same
snapshot. Any cross-workspace endpoint refuses the whole read. Activity and assigned-agent workspace custody are
also checked. Concurrent uploads cannot mix later bytes with earlier chronology:
all data comes from the original database snapshot. No read audit is invented.
