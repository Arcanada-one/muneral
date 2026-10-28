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
 *
 * DEC-AUP-0033 A3 (operator order 2026-10-27, applied 2026-10-28) adds one
 * thing and widens nothing: an entry may be STANDING — `standing: true` with
 * `until` set to `STANDING_PROJECT_READ_GRANT_UNTIL`. A standing entry has no
 * time expiry and no renewal; it is revoked only by removing it in a PR. The
 * dated windows had lapsed on 2026-09-21, 2026-10-14 and 2026-10-28, and each
 * lapse silently stopped the fleet's backlog reads until a new decision, a
 * scan and a Muneral PR landed. The route, the projection (ids, status, title
 * hash) and every other rule above are unchanged.
 */
export interface ProjectReadGrantEntry {
  agentId: string;
  agentName: string;
  projectId: string;
  /** Exclusive: the grant is closed at and after this instant. A standing
   *  entry holds `STANDING_PROJECT_READ_GRANT_UNTIL` here — still a string,
   *  so every reader that parses `until` keeps working. */
  until: string;
  /** DEC-AUP-0033 A3: no time expiry; revoked only by removal in a PR.
   *  Set iff `until === STANDING_PROJECT_READ_GRANT_UNTIL`. */
  standing?: true;
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
 * The `until` of a standing entry (DEC-AUP-0033 A3). A sentinel rather than
 * `null`, the same choice as `STANDING_DIGEST_GRANT_UNTIL`; the 30-day cap
 * above applies to every entry that is NOT standing.
 */
export const STANDING_PROJECT_READ_GRANT_UNTIL = '9999-12-31T00:00:00Z';

/**
 * `standing === true` iff `until === STANDING_PROJECT_READ_GRANT_UNTIL`. The
 * pairing stops a far-future date from passing as a dated grant and a
 * `standing` flag from riding on an ordinary date. Returns the violation, or
 * null. An entry that fails it is never live (fail closed).
 */
export function projectReadGrantInvariantViolation(
  entry: ProjectReadGrantEntry,
): string | null {
  const sentinel = entry.until === STANDING_PROJECT_READ_GRANT_UNTIL;
  if (entry.standing === true && !sentinel)
    return `standing entry must have until ${STANDING_PROJECT_READ_GRANT_UNTIL}`;
  if (entry.standing !== true && sentinel)
    return `until ${STANDING_PROJECT_READ_GRANT_UNTIL} is reserved for standing entries`;
  return null;
}

/** Is this entry's window open at `now`? Standing entries skip the time
 *  check; an entry that breaks the standing invariant is never open. */
function isLive(entry: ProjectReadGrantEntry, now: Date): boolean {
  if (projectReadGrantInvariantViolation(entry) !== null) return false;
  return entry.standing === true || now.getTime() < Date.parse(entry.until);
}

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
    until: STANDING_PROJECT_READ_GRANT_UNTIL,
    standing: true,
    decision: 'DEC-AUP-0033',
    evidence:
      'DEC-AUP-0033 A3 (operator order 2026-10-27, applied 2026-10-28): standing grant, no time expiry, revoked only by removing this entry in a PR. The dated window of DEC-AUP-0162 lapsed at 2026-10-28T00:00:00Z and the same-key index GET answered 403 GRANT_EXPIRED again, blocking backlog selection. Prior history — DEC-AUP-0162: same-key project-index GET returned 403 GRANT_EXPIRED after the prior window ended; controlled requests and Root-reported D5A/TALOMNIA backlog-read failures are recorded in Muneral task 971d0143-8549-47a9-b89b-19f0a4023a53 comment d8e9d0f2-db1e-4278-80b5-589858c26905. This replaces the prior entry only; MUN-0054 remains separate and open.',
  },
  {
    agentId: '9437639a-5f7c-4fe4-be04-18112ba0bada',
    agentName: 'aup-orchestrator',
    projectId: 'a28ad0ac-c4ab-497b-b93c-4f576a06b9fb',
    until: STANDING_PROJECT_READ_GRANT_UNTIL,
    standing: true,
    decision: 'DEC-AUP-0033',
    evidence:
      'DEC-AUP-0033 A3 (operator order 2026-10-27, applied 2026-10-28): standing grant, no time expiry, revoked only by removing this entry in a PR. Replaces the DEC-AUP-0096 window that would have lapsed at 2026-11-04T00:00:00Z. Prior history — MUNERAL-IMPORT-AUDIT 2026-10-06: project datarim-history holds ~2,600 imported Datarim work items (DEC-AUP-0005) that no agent key can list — GET /tasks/project/:id answers the own slice only (12 rows, MUN-0043) and GET /tasks/:id is 403 — so lanes cannot see their historical backlog; measured in /home/dev/aup/import-audit/IMPORT-GAP.md and lookup-after.json. The index route answers ids, status and title hashes only (no free text), so the DEC-AUP-0029 R7 title precondition of the digest route does not arise; window 2026-10-06..2026-11-04 is within the 30-day ceiling.',
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
  return isLive(entry, now) ? { kind: 'live', entry } : { kind: 'expired', entry };
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
  return grants.some((g) => sameId(g.agentId, agentId) && isLive(g, now));
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

/** When the holder should renew: `GRANT_RENEWAL_LEAD_DAYS` before `until`.
 *  A standing entry has no renewal, so it answers undefined. */
export function renewalDueAt(entry: ProjectReadGrantEntry): string | undefined {
  if (entry.standing === true) return undefined;
  return new Date(
    Date.parse(entry.until) - GRANT_RENEWAL_LEAD_DAYS * 86_400_000,
  ).toISOString();
}
