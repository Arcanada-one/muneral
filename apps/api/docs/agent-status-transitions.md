# Agent-key status transitions — `PATCH /tasks/:taskId/status` (MUN-0050)

## The gap this closes

An agent registers its own work with `POST /tasks` (MUN-0045): the row records
the agent as creator (`created_by_id`, `actor_type = 'agent'`) from the
credential. The status route was scoped `'task'` (MUN-0043), which admits a
key only when `task_agents` holds a row for (task, agent) — and creation
writes no such row. Measured live on 2026-09-13 against 0.4.1: every work item
the fleet had registered answered

```
403 {"message":"Agent \"aup-orchestrator\" is not assigned to task <id>."}
```

to the key that created it, so every card sat in `todo` after its work was
merged and deployed. The board showed nothing done, which is the reason the
tracker was not believed (ARCANADA-2-PIPELINE §2, second diagnosis).

## The rule

The route is now marked `@AgentScope('task-status')`. An agent key may move a
task's status when, inside the agent's **own workspace**, either

- the agent **created** the task — `tasks.created_by_id` is the agent's id
  **and** `tasks.actor_type = 'agent'` (the pair `POST /tasks` writes; a
  creator row under a human actor type is not a grant), or
- the agent is assigned to the task with **role `executor`** in `task_agents`.

A `lead` or `reviewer` assignment does not move a card (it still reads and
comments under `'task'`). A stranger, an agent of another workspace, an
unknown id and a malformed id all answer `403`, so the route cannot be used to
enumerate task ids. A JWT passes as on every task route.

The state machine is not part of the scope and binds every caller alike:
`TASK_TRANSITIONS` in `@muneral/types`. `done` is reachable only from `review`,
so an agent that finished a card makes three calls —
`todo → in_progress → review → done`. A card that must stop short of a claim
goes to `blocked` (from `in_progress`) and stays there; nothing turns
`blocked` into `done` directly. `todo → done` answers `400`.

## Answers

| status | when |
|---|---|
| 200 | the transition was made: the task row, attributed to the agent in `activity_log` (`task:status_changed`, `actorType 'agent'`, the agent's id) |
| 200 `idempotent: true` | the task is already in the requested status: the task as it is, and **nothing written** — no activity row, no field-state (ETag) move, no kanban event, no execution-authority recording |
| 400 | the map does not allow the move from the current status |
| 401 | no credential, or a key that does not validate |
| 403 | a valid key the scope does not admit (not creator, not executor, other workspace, unknown or malformed id) |

The idempotent answer exists for the unattended caller that retries after a
lost response: before MUN-0050 a repeat answered `400 Invalid status
transition: in_progress → in_progress`, indistinguishable from a real refusal.

## What stays as it was

- Every other route on the tasks controller keeps its scope or stays JWT-only:
  delete, checklists, dependencies, the migration CAS transition path
  (`tasks.revision` is moved by that path alone; this route leaves it at 0).
- The creator is **not** thereby admitted to `GET /tasks/:taskId`,
  `GET /tasks/:taskId/activity` or `POST /tasks/:taskId/comments` — those keep
  `'task'` (assignment). Recorded as a finding for a separate card.
- `POST /agents/tasks/:taskId/assign` is unchanged (and unscoped — a finding
  recorded by MUN-0050, not touched here).

## Proof

`test/tasks-agent-status.e2e.spec.ts` (real HTTP + Postgres) and the
`'task-status'` cases in `test/agent-task-scope.guard.spec.ts`; every check was
shown able to fail by a named mutant (see the MUN-0050 receipts in the program
repository).
