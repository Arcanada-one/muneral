# Program grant task and evidence reads

A project index grant enumerates metadata. It does not authorize task text or evidence pointers.

The additional named program capability is limited to `GET /tasks/:taskId` and `GET /tasks/:taskId/evidence`. An ordinary creator or assignee keeps existing access. A nonowner must hold both the separately admitted task-read capability and a live index grant for the task's current project. Both bind to the authenticated principal's current workspace; the capability independently checks its fixed anchor and current excluded project slugs. The effective window ends at the earlier expiry. An expired exact index entry never falls back to a workspace grant.

Nonowner admission is rechecked with a fresh time after actor, task and sorted project/anchor shared locks, inside the same transaction as response selection and audit. This protects custody until commit. It does not retract earlier disclosures or guarantee that wall-clock expiry cannot pass during network delivery. Serialization or audit failure aborts the entire read.

Task and evidence response schemas are unchanged. Task ETag is calculated from the same authorized snapshot. Conditional `304` and authorized empty evidence reads still authorize and audit. `X-Muneral-Read-Audit` identifies the committed broad-read event; `X-Muneral-Read-Audit-Count` returns the server count for this actor, task and action. Under concurrency a count is not a unique sequence; event IDs identify separate reads. Audits omit task text and evidence pointers. Evidence URI/hash records are claims and are never fetched or executed by this route.

The capability gives no activity, comment, assignment, status, evidence POST or other permission. JWT behavior and ordinary owner access are unchanged. No credential or native assignment is created. Index-only DEC-AUP-0114 remains separate; DEC-AUP-0117 admits the additional full task/evidence schema. Separate canonical adoption, required source CI, deployment identity and bounded native acceptance must precede a delivery claim. Removing or expiring only the new capability revokes future broad reads without renewing or removing the existing index grants.
