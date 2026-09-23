/**
 * MUN-0052 — which agent keys may read a project's task INDEX, and until when.
 *
 * Inside its workspace an agent key sees its own slice of a project: the tasks
 * it is assigned to or created (MUN-0043, MUN-0051). The Arcanada Universal
 * Program's board was registered on 2026-09-05 through a human JWT, so the
 * fleet's own key could not see 471 of the 477 program tasks and the program's
 * status-parity check could not be measured at all. Widening the own-slice rule
 * for every key of the workspace was rejected (program decision DEC-AUP-0029,
 * five-role consilium): the in-workspace `field-changes` read already returns a
 * task's title and description to anybody who knows its id, and the one thing a
 * key cannot do today is list the ids — a workspace-wide list would hand every
 * key of the workspace the whole board, including titles known to carry secrets.
 *
 * So the read is granted per key and per project, here, and it opens exactly one
 * route: `GET /tasks/project/:projectId/index` (`@AgentScope('project-index')`),
 * which answers ids, status and a sha256 of the title — no free text. Every other
 * route keeps the own-slice rule, and nothing here is consulted by any write.
 *
 * The list lives in code, not in a table or the environment, on purpose — the
 * same choice as `assign-compat-window.ts`: a grant is a reviewed change that
 * names its decision, and it lapses by itself at `until` without a deploy.
 *
 * MUN-0055 (DEC-AUP-0033) changed three things about the list and none about
 * what it opens:
 *
 *  1. At most ONE entry per (agentId, projectId) — pinned by a test. A renewal
 *     REPLACES the expired entry, it does not append a second one. If two ever
 *     coexist, every lookup here takes the one with the LATEST `until`, so a
 *     refusal can never cite a superseded decision.
 *  2. The ids are compared case-insensitively. `projects.id` is a PostgreSQL
 *     `uuid`, which accepts and matches any case; a JS `===` against a literal
 *     typed in another case matched nothing, so a live grant could be refused
 *     by a spelling the database considers identical.
 *  3. An expired entry is distinguishable from no entry at all — see
 *     `projectReadGrantState`. The guard turns that into 403 `GRANT_EXPIRED`
 *     instead of the blanket 404, which told a legitimate holder nothing.
 */
export interface ProjectReadGrantEntry {
  agentId: string;
  agentName: string;
  projectId: string;
  /** Exclusive: the grant is closed at and after this instant. */
  until: string;
  /** The program decision that admitted the grant. */
  decision: string;
  evidence: string;
}

/** Injection token, so a test module can supply its own list. */
export const PROJECT_READ_GRANTS = 'mun0052:projectReadGrants';

/**
 * DEC-AUP-0029 R1: an entry's window is at most 30 days from the day it merges.
 * Pinned here so the invariant test and any future renewal read one number.
 */
export const MAX_GRANT_WINDOW_DAYS = 30;

/**
 * DEC-AUP-0033: how long before `until` a holder should be told to renew.
 * Surfaced to the caller as `grant.renewalDueAt` on every index read, because
 * the first grant (DEC-AUP-0029) lapsed at 2026-09-21T00:00Z and nothing
 * noticed for two days — the board read simply went quiet.
 */
export const GRANT_RENEWAL_LEAD_DAYS = 7;

export const PROJECT_READ_GRANT_LIST: readonly ProjectReadGrantEntry[] = [
  {
    agentId: '9437639a-5f7c-4fe4-be04-18112ba0bada',
    agentName: 'aup-orchestrator',
    projectId: '08a50f9a-a735-4605-91ce-ce4a41193fbb',
    until: '2026-10-14T00:00:00Z',
    decision: 'DEC-AUP-0033',
    evidence:
      'DEC-AUP-0029 renewal: the first window (until 2026-09-21) was used — two live readings 886/887 rows an hour apart and the step-13 status parity re-run, receipts/mun0052/live-reading{1,2}-20260914T*.json and status-parity-20260914T111224Z.md — then lapsed silently. 2026-10-14 is the ceiling DEC-AUP-0029 R1 set for this entry.',
  },
];

/** Case-insensitive: `projects.id` is a PostgreSQL `uuid`, which is. */
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Every entry for this (agent, project), newest window first. Time is NOT a
 * filter here: the caller decides what an expired entry means. The ordering is
 * what keeps a refusal from citing a superseded decision if the one-entry
 * invariant below is ever broken by a bad merge.
 */
function entriesFor(
  agentId: string,
  projectId: string,
  grants: readonly ProjectReadGrantEntry[],
): ProjectReadGrantEntry[] {
  return grants
    .filter((g) => sameId(g.agentId, agentId) && sameId(g.projectId, projectId))
    .sort((a, b) => Date.parse(b.until) - Date.parse(a.until));
}

/** What the grant list says about this (agent, project) at `now`. */
export type ProjectReadGrantState =
  /** No entry has ever named this pair — the caller must not learn any more. */
  | { kind: 'none' }
  /** An entry names the pair and its window is open. */
  | { kind: 'live'; entry: ProjectReadGrantEntry }
  /** An entry names the pair and its window has closed. */
  | { kind: 'expired'; entry: ProjectReadGrantEntry };

export function projectReadGrantState(
  agentId: string,
  projectId: string,
  now: Date,
  grants: readonly ProjectReadGrantEntry[] = PROJECT_READ_GRANT_LIST,
): ProjectReadGrantState {
  const [entry] = entriesFor(agentId, projectId, grants);
  if (!entry) return { kind: 'none' };
  return now.getTime() < Date.parse(entry.until)
    ? { kind: 'live', entry }
    : { kind: 'expired', entry };
}

/** The grant that admits `agentId` to `projectId` at `now`, if any. */
export function projectReadGrantFor(
  agentId: string,
  projectId: string,
  now: Date,
  grants: readonly ProjectReadGrantEntry[] = PROJECT_READ_GRANT_LIST,
): ProjectReadGrantEntry | undefined {
  const state = projectReadGrantState(agentId, projectId, now, grants);
  return state.kind === 'live' ? state.entry : undefined;
}

/**
 * MUN-0055 (DEC-AUP-0033 R4): does this key hold a LIVE index grant anywhere?
 * The `task-workspace` field-change read asks first, and when the answer is no
 * — which it is for every key but the one in the list — it does no extra work
 * and behaves exactly as before.
 */
export function agentHoldsAnyLiveProjectReadGrant(
  agentId: string,
  now: Date,
  grants: readonly ProjectReadGrantEntry[] = PROJECT_READ_GRANT_LIST,
): boolean {
  return grants.some(
    (g) => sameId(g.agentId, agentId) && now.getTime() < Date.parse(g.until),
  );
}

/**
 * MUN-0055 (DEC-AUP-0033 R4): is there a live entry for this exact pair?
 * Used by the field-change read once it knows which project the task is in.
 */
export function projectHasLiveGrantForAgent(
  agentId: string,
  projectId: string,
  now: Date,
  grants: readonly ProjectReadGrantEntry[] = PROJECT_READ_GRANT_LIST,
): boolean {
  return projectReadGrantState(agentId, projectId, now, grants).kind === 'live';
}

/** When the holder should renew: `GRANT_RENEWAL_LEAD_DAYS` before `until`. */
export function renewalDueAt(entry: ProjectReadGrantEntry): string {
  return new Date(
    Date.parse(entry.until) - GRANT_RENEWAL_LEAD_DAYS * 86_400_000,
  ).toISOString();
}
