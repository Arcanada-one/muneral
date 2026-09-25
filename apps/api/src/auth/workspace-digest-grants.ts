/**
 * A2-284 — which agent keys may read their workspace's task digest, and until
 * when.
 *
 * ## What this opens, and what it does not
 *
 * Exactly one route: `GET /tasks/digest` (`@AgentScope('workspace-digest')`).
 * It answers the tasks of the KEY'S OWN workspace, filtered by status and an
 * `updatedAt` window, as the seven columns a digest renders — id, projectId,
 * title, status, priority, createdAt, updatedAt. No description, no comments,
 * no evidence bodies, no other workspace, and no write: nothing in this file is
 * consulted by any route that changes anything, which is the same rule
 * `project-read-grants.ts` states for its own list.
 *
 * ## Why a grant list rather than a bare `@AgentScope`
 *
 * A scope marker alone would open the route to EVERY key of every workspace the
 * moment it merged — an agent gains a capability without anyone deciding it
 * should. The card that ordered this work says the grant must be explicit per
 * agent, so the marker is necessary and not sufficient: the guard also requires
 * an entry here for (this agent, its workspace). The list below ships EMPTY, so
 * merging this change grants nothing to anybody; the first entry is a separate,
 * reviewable pull request. `workspace-digest-grants.spec.ts` pins that emptiness
 * so a later merge cannot slip an entry in as a formatting change.
 *
 * ## Why it is wider than `project-read-grants.ts`, said plainly
 *
 * The project index (MUN-0052, DEC-AUP-0029) deliberately answers a sha256 of
 * each title and no free text, because "titles known to carry secrets" was the
 * stated reason for refusing a workspace-wide list to every key. This route
 * returns those titles in the clear, to a granted key, for the whole workspace.
 * That IS a widening and it is the point: a digest whose lines read
 * "3 задачи завершено" without naming them is not a digest, and the titles it
 * prints go to the same operator who would otherwise read the board.
 *
 * What bounds it instead:
 *   1. per (agent, workspace), named here, merged through review;
 *   2. an expiry — `until` is required, and the ceiling is the same
 *      `MAX_GRANT_WINDOW_DAYS` DEC-AUP-0029 set for a read that is narrower
 *      than this one. A wider read does not get a longer window;
 *   3. read-only, own workspace, seven columns chosen by the consumer that was
 *      measured (`arcanada-assistant#76`), not by what the table happens to
 *      hold;
 *   4. every read writes an activity row naming the agent, the decision and
 *      the row count, and the answer carries that row's id.
 *
 * ## The lapse, which is a known failure mode here
 *
 * DEC-AUP-0029's first grant expired at 2026-09-21T00:00Z and nothing noticed
 * for two days: the board read simply went quiet. A daily digest is exactly the
 * consumer that fails that way. Two things answer it, both borrowed from
 * MUN-0055: an expired entry is distinguishable from no entry at all
 * (`GRANT_EXPIRED`, with `until` and the decision, not a blanket refusal), and
 * every successful read carries `grant.renewalDueAt`, `GRANT_RENEWAL_LEAD_DAYS`
 * before the end. The consumer already renders the cause of a refusal into the
 * message it publishes, so a lapse prints itself in Telegram rather than
 * becoming a silent zero.
 */
import {
  GRANT_RENEWAL_LEAD_DAYS,
  MAX_GRANT_WINDOW_DAYS,
} from "./project-read-grants.js";

export interface WorkspaceDigestGrantEntry {
  agentId: string;
  agentName: string;
  /** The agent's own workspace. Stated rather than derived so an entry that
   *  names the wrong workspace is refused instead of quietly following the
   *  agent if it is ever moved. */
  workspaceId: string;
  /** Exclusive: the grant is closed at and after this instant. */
  until: string;
  /** The program decision that admitted the grant. */
  decision: string;
  evidence: string;
}

/** Injection token, so a test module can supply its own list. */
export const WORKSPACE_DIGEST_GRANTS = "a2284:workspaceDigestGrants";

/**
 * The ceiling on an entry's window, in days from the day it merges. Imported,
 * not restated: this read is wider than the one DEC-AUP-0029 capped at 30 days,
 * and a wider read taking a longer window would be the wrong way round.
 */
export const MAX_DIGEST_GRANT_WINDOW_DAYS = MAX_GRANT_WINDOW_DAYS;

/**
 * ONE entry, added by A2-294 under DEC-AUP-0049.
 *
 * A2-284 shipped this list EMPTY and said the first entry would be its own
 * reviewed pull request naming its decision. This is that pull request.
 *
 * What the decision blocked it on, and why the reader should care: granting a
 * workspace-wide PLAINTEXT title read to a key also hands it an id for every
 * task of the workspace, and `GET /tasks/:taskId/field-changes` answers by id.
 * As shipped, that route withheld `title`/`description` only from a key holding
 * a project-read grant (DEC-AUP-0033 R4), so a digest-only key would have read
 * every title AND description in the workspace — measured live, 926 of them.
 *
 * That door is closed by a SEPARATE, EARLIER pull request (muneral#172, A2-294b:
 * `agent-task-scope.guard.ts`, `assertTaskInWorkspace`), which this branch is
 * rebased onto. An earlier draft of this entry closed it in the same commit and
 * said so; blind review (A2-294 F3) pointed out that atomicity and ordering are
 * alternatives, not both, and that a decision whose whole control is an ORDER
 * must not also claim there is no window. The order is the control, and it is
 * enforced by the base of this branch rather than by prose: without #172 merged
 * and DEPLOYED, this entry is not a seven-column read — it is a workspace
 * free-text read. Its live verification is the probe
 * `runs/A2-294b/probe_withholding.py`, which must answer
 * `fields_not_withheld: 0` against the deployed API before this merges. Measured
 * before #172: 926 plaintext titles and 892 plaintext descriptions.
 *
 * `until` is 14 days, not the 30-day ceiling: the ceiling was set for the
 * NARROWER project index, this read's only no-merge reversal is `until` passing
 * (agent-key revocation is JWT-only), and 2026-10-09 lands before DEC-AUP-0033's
 * 2026-10-14 so the workspace's two grants do not outlive each other unobserved.
 */
export const WORKSPACE_DIGEST_GRANT_LIST: readonly WorkspaceDigestGrantEntry[] =
  [
    {
      agentId: "565171f7-a3ca-45a4-b50e-4d8b07cf0b86",
      agentName: "arcanada-assistant",
      workspaceId: "05f8cddf-e91f-430b-81e3-d67965aa4de3",
      until: "2026-10-09T00:00:00Z",
      decision: "DEC-AUP-0049",
      evidence:
        "Live 2026-09-24/25: this key reads GET /tasks/digest -> 403 DIGEST_GRANT_REQUIRED and " +
        "GET /agents/tasks -> 200, so the credential is valid and the refusal is real. Its measured " +
        "alternative, GET /tasks/project/:id, answers 200 [] on a board of 880+ rows — an authorised, " +
        'well-formed, completely false "nothing happened today" (runs/A2-281/probe-routes.txt). The three ' +
        "KBSYNC-0 secret-bearing titles were re-read live on 2026-09-25 and each is still redacted " +
        "(runs/A2-294/out/titles-today-*.json), discharging the DEC-AUP-0029 R7 title precondition.",
    },
  ];

/** Case-insensitive: the ids are PostgreSQL `uuid`s, which are. */
const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Every entry for this (agent, workspace), newest window first. Time is not a
 * filter here: the caller decides what an expired entry means. The ordering is
 * what keeps a refusal from citing a superseded decision if two entries ever
 * coexist after a bad merge.
 */
function entriesFor(
  agentId: string,
  workspaceId: string,
  grants: readonly WorkspaceDigestGrantEntry[],
): WorkspaceDigestGrantEntry[] {
  return grants
    .filter(
      (g) => sameId(g.agentId, agentId) && sameId(g.workspaceId, workspaceId),
    )
    .sort((a, b) => Date.parse(b.until) - Date.parse(a.until));
}

export type WorkspaceDigestGrantState =
  | { kind: "live"; entry: WorkspaceDigestGrantEntry }
  | { kind: "expired"; entry: WorkspaceDigestGrantEntry }
  | { kind: "none" };

/**
 * Live, expired, or never granted — three answers, not two. A holder whose
 * window ran out is told so; a key that was never named is told nothing about
 * the list at all.
 */
export function workspaceDigestGrantState(
  agentId: string,
  workspaceId: string,
  now: Date,
  grants: readonly WorkspaceDigestGrantEntry[] = WORKSPACE_DIGEST_GRANT_LIST,
): WorkspaceDigestGrantState {
  const entries = entriesFor(agentId, workspaceId, grants);
  if (entries.length === 0) return { kind: "none" };
  const live = entries.find((e) => now.getTime() < Date.parse(e.until));
  return live
    ? { kind: "live", entry: live }
    : { kind: "expired", entry: entries[0] };
}

/** When the holder should renew: `GRANT_RENEWAL_LEAD_DAYS` before `until`. */
export function digestRenewalDueAt(entry: WorkspaceDigestGrantEntry): string {
  return new Date(
    Date.parse(entry.until) - GRANT_RENEWAL_LEAD_DAYS * 86_400_000,
  ).toISOString();
}
