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
 *                      be assigned to that task (`task_agents`).
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
 */
export const AGENT_SCOPE_KEY = 'mun0043:agentScope';

export type AgentScopeKind = 'task' | 'project' | 'task-workspace';

export const AgentScope = (kind: AgentScopeKind) =>
  SetMetadata(AGENT_SCOPE_KEY, kind);
