/**
 * MUN-0051 — the dated compatibility window for `POST /agents/tasks/:taskId/assign`.
 *
 * Before MUN-0051 that route accepted any valid agent key for any task and any
 * assignee. The rule that replaces it (AgentTaskScopeGuard.assertMayAssign) lets
 * a key assign only on a task it created or executes. One live caller is known
 * to depend on the open behaviour, measured on 2026-09-14 from the key's own
 * `GET /agents/tasks` (the route wrote no activity row, so nothing else records
 * who called it): the Arcanada Universal Program fleet agent `aup-orchestrator`
 * assigned ITSELF as executor to 13 tasks it did not create — 10 human-created
 * cards on 2026-09-05 and 3 imported cards on 2026-09-13 (the MUN-0049
 * redaction flow). Breaking that silently on deploy is what this file prevents.
 *
 * What the window still admits, and only for the agents listed here, only until
 * `until`: the agent assigning ITSELF, as executor or reviewer, to a task in its
 * own workspace. Assigning anybody else, granting lead, and every other
 * workspace are closed for every key from the first deploy. Every assignment the
 * window admits writes an activity row whose payload says `basis:
 * 'compat-window'`, so its use is countable before the window closes.
 *
 * The expiry lives in code, not in configuration, on purpose: extending the
 * window is a reviewed change with its own card, never an environment edit.
 */
export interface AssignCompatWindowEntry {
  agentId: string;
  agentName: string;
  /** Exclusive: the window is closed at and after this instant. */
  until: string;
  evidence: string;
}

export const ASSIGN_COMPAT_WINDOW: readonly AssignCompatWindowEntry[] = [
  {
    agentId: '9437639a-5f7c-4fe4-be04-18112ba0bada',
    agentName: 'aup-orchestrator',
    until: '2026-09-28T00:00:00Z',
    evidence:
      'MUN-0051 step 1: 13 executor self-assignments on tasks the agent did not create (2026-09-05 ×10, 2026-09-13 ×3)',
  },
];

/** Roles the window may still let an agent give itself: never lead. */
export const COMPAT_WINDOW_ROLES: readonly string[] = ['executor', 'reviewer'];

export function assignCompatWindowAdmits(
  callerAgentId: string,
  assigneeAgentId: string | undefined,
  role: string | undefined,
  now: Date,
  window: readonly AssignCompatWindowEntry[] = ASSIGN_COMPAT_WINDOW,
): boolean {
  if (assigneeAgentId !== callerAgentId) return false;
  if (role === undefined || !COMPAT_WINDOW_ROLES.includes(role)) return false;
  const entry = window.find((e) => e.agentId === callerAgentId);
  if (!entry) return false;
  return now.getTime() < Date.parse(entry.until);
}
