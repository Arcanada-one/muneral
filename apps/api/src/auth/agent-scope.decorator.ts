import { SetMetadata } from '@nestjs/common';

/**
 * MUN-0043: which routes an agent's `mun_sk_` API key may reach, and how far.
 *
 * The default for an API key is REFUSAL. A route is reachable by a key only
 * when it carries this decorator, and the decorator also names the scope the
 * key is checked against. An allowlist rather than a denylist, because the
 * failure mode of the other arrangement is a route added later that nobody
 * remembers to close: an agent key would reach it the day it merges, silently.
 *
 *   'task'           — the route names a task (`:taskId`). The key's agent must
 *                      be assigned to that task (`task_agents`) or, since
 *                      MUN-0051, have created it (`tasks.created_by_id` = the
 *                      agent, `actor_type` = 'agent'). Before MUN-0051 a creator
 *                      without an assignment row could not read or comment on
 *                      the task it had just created.
 *   'project'        — the route names a project (`:projectId`) and returns a
 *                      collection. The key's agent sees only the tasks it is
 *                      assigned to inside that project; an agent with no
 *                      assignment there gets an empty collection, not somebody
 *                      else's board.
 *   'task-workspace' — the route names a task and the agent must be in the
 *                      workspace that owns it, but need not be assigned to it.
 *                      Deliberately weaker than 'task', and used only where a
 *                      route was ALREADY open to any API key: it closes the
 *                      cross-tenant read without changing what an agent can see
 *                      inside its own workspace, which is what an unattended
 *                      poller depends on. See the field-change routes.
 *   'project-write'  — MUN-0045. The route names a project by `projectId` IN
 *                      THE REQUEST BODY (not a route param — `POST /tasks` has
 *                      no `:projectId` segment) and creates a task inside it.
 *                      The key's agent must be in the workspace that owns the
 *                      project; the agent need not be assigned to anything
 *                      yet, since the task being created is what it would be
 *                      assigned to. Bounds what the key can write to its own
 *                      workspace's projects — the same boundary 'project'
 *                      already draws for reads, extended to the one write
 *                      route an agent actually needs. Authorship of the
 *                      created task is never taken from this scope or from
 *                      the request body: it is `req.actor`, resolved by
 *                      `ActorInterceptor` from the credential itself, so a key
 *                      cannot claim a principal it is not (see
 *                      CreateTaskDto — it carries no owner/actor field at all).
 *   'task-redaction' — MUN-0049. The route names a task (`:taskId`) and
 *                      rewrites one span of its title or description. The
 *                      assignment check is exactly 'task' — the agent must be
 *                      assigned to that task inside its own workspace — but
 *                      the scope has its own name because rewriting a field is
 *                      a different act from reading or commenting, and an
 *                      allowlist entry that can be narrowed or revoked on its
 *                      own is worth one more enum value. The route never takes
 *                      the new value as free text: see TaskRedactionService.
 *   'task-status'    — MUN-0050. The route names a task (`:taskId`) and moves
 *                      its status. The key's agent must be in the workspace
 *                      that owns the task AND either have CREATED it
 *                      (`tasks.created_by_id` = the agent, `actor_type` =
 *                      'agent' — authorship `POST /tasks` records from the
 *                      credential, MUN-0045) or be assigned to it with role
 *                      `executor` (`task_agents`). Narrower than 'task' on
 *                      the role (a lead or reviewer assignment does not move
 *                      a card) and wider on authorship (a creator needs no
 *                      assignment row — the row it never got is why every
 *                      work item the fleet registered stayed `todo`). The
 *                      state machine is not part of the scope: the service
 *                      holds every caller, key or JWT, to TASK_TRANSITIONS.
 *   'task-assign'    — MUN-0051. The route names a task (`:taskId`) and writes
 *                      a `task_agents` row for the agent and role named in the
 *                      body. Before MUN-0051 the route had no scope at all: any
 *                      valid key could assign any agent, in any workspace, to
 *                      any task, with any role — and since MUN-0050 an executor
 *                      row moves status, so "assign yourself, then move the
 *                      card" was open to every key. The key's agent must be in
 *                      the workspace that owns the task and must either have
 *                      CREATED the task (it may then grant any role) or be its
 *                      EXECUTOR (it may grant executor or reviewer, never
 *                      lead); the assignee must be an agent of the same
 *                      workspace. A lead or reviewer assignment grants nothing.
 *                      See AgentTaskScopeGuard.assertMayAssign and the dated
 *                      compatibility window in assign-compat-window.ts.
 *   'project-index'  — MUN-0052 (DEC-AUP-0029). The route names a project
 *                      (`:projectId`) and returns its task INDEX — id, parent,
 *                      status, priority, actor type, timestamps and a sha256 of
 *                      the title, for every task of the project. The key's
 *                      agent must be in the workspace that owns the project AND
 *                      be named for that project, with `until` still ahead, in
 *                      `project-read-grants.ts`; otherwise 404, the answer an
 *                      unknown project gets. It is the only kind that reads
 *                      past the own slice, it returns no free text, and no
 *                      other kind — no write — consults the grant list.
 */
export const AGENT_SCOPE_KEY = 'mun0043:agentScope';

export type AgentScopeKind =
  | 'task'
  | 'project'
  | 'task-workspace'
  | 'project-write'
  | 'task-redaction'
  | 'task-status'
  | 'task-assign'
  | 'project-index';

export const AgentScope = (kind: AgentScopeKind) =>
  SetMetadata(AGENT_SCOPE_KEY, kind);
