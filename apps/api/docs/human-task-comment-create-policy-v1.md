# Proposed human task-comment authorization policy

**Version:** 1  
**Policy owner:** Muneral  
**Enforcement integration owner:** ARC2 / Auth Arcana  
**Status:** `PROPOSED_NOT_ACCEPTED_NOT_IMPLEMENTED`  
**Source baseline:** Muneral `2c6f614e8442ecbd3940e87def3d8209c1a636a3`

The role, relationship, and route observations below are pinned to this source
baseline: `packages/types/src/index.ts` blob
`b41afdc71dc8c9cf913b76bcb2acf0ec35c52bda`,
`apps/api/prisma/schema.prisma` blob
`7d084228127f5c3232494e7b4d65453557023272`,
`apps/api/src/auth/guards/human-task-read.guard.ts` blob
`06d85da56760d15ad8381c9f334b398c547a3659`,
`apps/api/src/auth/guards/agent-task-scope.guard.ts` blob
`d032b7898edc7d86aae4d67158ee6a64214db184`,
`apps/api/src/tasks/tasks.controller.ts` blob
`d5f80a8080d301c04bb5aa0cdaaf84f524ffa140`, and
`apps/api/src/tasks/tasks.service.ts` blob
`38c4fa956aea595a8f42f2adfb01e7fbae22e5eb`.

This document records one proposed resource policy for a human creating a task
comment. It does not authorize a request, describe deployed behavior, or claim
that the policy is implemented. Adoption remains with the existing ARC2 Auth
review and adoption flow.

## Decision

The protected action is `task.comment.create`.

| Current workspace membership role | Proposed decision |
| --- | --- |
| `owner` | Allow, subject to the resource and membership binding below. |
| `manager` | Allow, subject to the resource and membership binding below. |
| `developer` | Allow, subject to the resource and membership binding below. |
| `viewer` | Deny. |
| Missing membership or any unlisted role | Deny. |

There is no `Workspace.ownerId`-only fallback. Workspace ownership without the
required current membership relation does not grant this action.

## Required subject and resource binding

Authorization must bind all of these values in one decision:

1. The human subject ID comes from the successfully authenticated Auth Arcana
   identity, not from the request body or a caller-selected header.
2. The target task is resolved from the route and belongs to the resolved
   project.
3. That project belongs to the resolved workspace.
4. The same authenticated human has a current membership in that workspace.
5. The membership role permits `task.comment.create` under the table above.

A membership in a different workspace, an assignment to the task, task
authorship, or a workspace owner field alone does not satisfy this binding.
Agent API-key authorization remains on its existing assigned-task scope and is
outside this human policy decision.

## Denial response

This proposal selects a **new uniform denial contract** for the human comment
POST. For an authenticated human, a missing task, project, or workspace and an
unauthorized membership or role all map to the same `403` response. The
response does not distinguish which resource or authorization check failed.
This uniform mapping is proposed and unimplemented; it is not the current
comment-route behavior.

```http
HTTP/1.1 403 Forbidden
```

```json
{"message":"Human task read forbidden","error":"Forbidden","statusCode":403}
```

The proposed body is Nest's canonical three-field `ForbiddenException` shape
with the selected generic message. Applying it uniformly requires the POST
path to normalize its current missing-resource `NotFoundException` cases to this
contract; that mapping is not implemented. No custom global exception mapper is
claimed. Authentication failure remains `401` under the existing
authentication contract and is not normalized by this policy.

## Current source boundary

At the source baseline, `POST /tasks/:taskId/comments` is marked
`@AgentScope('task')`; the controller attributes the comment to the server
resolved actor, and `TasksService.addComment` writes a `comment` activity row
after resolving the task and project. The task controller's
`HumanTaskReadGuard` checks only `GET` and `HEAD`, while
`AgentTaskScopeGuard` passes JWT requests through for human authorization to
other policy. The current route code therefore does not establish the proposed
human membership/role authorization for this POST. This is a source boundary,
not a claim about live production behavior or a complete security finding.

The ARC2 assessment supplied for this proposal is identified by SHA256
`f89058d58dcaef48300d17b8e449df952ce2b69ef67789f443279a17e5c7f5a7`. Its
contents were not available in the author's clone, so this document does not
quote or attribute additional conclusions to that assessment. The selected
policy choices above come from the explicit owner instruction accompanying the
assessment locator.

## Revocation and write ordering

The proposed guarantee is based on one authorization/write serialization
boundary. The task-to-project-to-workspace relationship, the same human's
current membership and role, the `task.comment.create` decision, and the
activity write must be evaluated or conditionally committed as one ordered
operation.

- A membership removal completed before the comment operation's authorization
  transaction begins must cause that operation to deny.
- If membership removal and comment creation are concurrent, their committed
  order determines the result: a removal ordered first denies the comment; a
  comment ordered first may commit before removal.
- The policy does not promise immediate cancellation of an in-flight operation
  or retroactive removal of an already committed comment.

The current source does not establish that Auth Arcana's ReBAC decision and
Muneral's activity write share a serializable or conditional transaction. The
enforcement mechanism and its ordering proof are therefore an explicit
implementation gap for ARC2/Auth integration to resolve before this guarantee
can be claimed as enforced. No implementation or runtime guarantee is asserted
here.

## Source limits and deferred scope

At the source baseline, Muneral defines the four workspace roles and stores a
workspace membership row keyed by workspace and user. The user model has no
disabled-user state, and the membership model has no separate active/deleted
state. Whether disabled identities are rejected is `NOT_MEASURED`; it is not a
decision or gate in this minimal policy. Current-membership revocation is
defined by the ordered-operation contract above, subject to the implementation
gap.

Broader audit-retention policy is deferred. Security logs must not copy comment
bodies or credentials.

## Ownership and adoption

Muneral owns this proposed product resource policy. Authorization enforcement
must use the Auth Arcana ReBAC/OpenFGA model and its RBAC facade; this proposal
does not create a standalone Muneral database role plane and does not treat a
local membership lookup by itself as the accepted Auth action relation. ARC2
owns the enforcement mapping, transaction-boundary evidence, and integration
custody.

This proposal remains `PROPOSED_NOT_ACCEPTED_NOT_IMPLEMENTED` until the existing
independent ARC2 Auth review/adoption flow records an accepted source version.
The approved source locator, if adopted, must name the merged commit and this
file's blob. Until then, no service behavior may be inferred from this
document.
