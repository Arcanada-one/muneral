/**
 * A2-284 — which agent keys may read their workspace's task digest, and until
 * when (or, for a STANDING entry, until the entry is removed).
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
 *      than this one. A wider read does not get a longer window. The one
 *      exception is an entry marked `standing: true` (DEC-AUP-0049 A7,
 *      operator order 2026-10-27): it carries the sentinel
 *      `STANDING_DIGEST_GRANT_UNTIL` instead of a date and is revoked only by
 *      removing it in a reviewed pull request. Bounds 1, 3 and 4 still hold for
 *      it unchanged;
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
 *
 * Those answers did not stop the lapses; they only made them loud. The
 * assistant's entry was renewed by hand every 14–30 days (decision amendment,
 * scan, pull request, deploy) and the digest still went down on 2026-10-27 with
 * `GRANT_EXPIRED`. DEC-AUP-0049 A7 therefore replaced that entry's expiry with
 * a standing grant revoked by removal. A standing read has no end, so it
 * carries no `renewalDueAt`; a dated entry still does.
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
  /** Exclusive: the grant is closed at and after this instant. A standing
   *  entry holds `STANDING_DIGEST_GRANT_UNTIL` here — a string, because the
   *  consumer requires `grant.until` to be one. */
  until: string;
  /** DEC-AUP-0049 A7: no time expiry; revoked only by removing the entry.
   *  Set iff `until === STANDING_DIGEST_GRANT_UNTIL`. */
  standing?: true;
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
 * The `until` of a standing entry. A sentinel rather than `null` so every
 * reader that parses `until` keeps working and the instant still compares as
 * "ahead"; the cap above applies to every entry that is NOT standing.
 */
export const STANDING_DIGEST_GRANT_UNTIL = "9999-12-31T00:00:00Z";

/**
 * `standing === true` iff `until === STANDING_DIGEST_GRANT_UNTIL`. The pairing
 * is what stops a far-future date from passing as a dated grant, and a
 * `standing` flag from riding on an ordinary date. Returns the violation, or
 * null. An entry that fails it is never treated as live (fail closed).
 */
export function digestGrantInvariantViolation(
  entry: WorkspaceDigestGrantEntry,
): string | null {
  const sentinel = entry.until === STANDING_DIGEST_GRANT_UNTIL;
  if (entry.standing === true && !sentinel)
    return `standing entry must have until ${STANDING_DIGEST_GRANT_UNTIL}`;
  if (entry.standing !== true && sentinel)
    return `until ${STANDING_DIGEST_GRANT_UNTIL} is reserved for standing entries`;
  return null;
}

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
 * Under DEC-AUP-0049 A6 this entry carried a fixed `until` of
 * 2026-10-27T00:00:00Z and was to be replaced, never rolled. It lapsed at that
 * instant. DEC-AUP-0049 A7 (operator order 2026-10-27) replaced the expiry with
 * a STANDING grant: no `until` date, revocation = remove this entry by pull
 * request. Nothing else moved: the same (agent, workspace) pair, read-only, own
 * workspace, the same seven columns, one activity row per read. A6's title
 * slice (6602/6602 tasks, zero hits) still covers the only free-text column
 * returned; description is neither selected nor returned.
 */
export const WORKSPACE_DIGEST_GRANT_LIST: readonly WorkspaceDigestGrantEntry[] =
  [
    {
      agentId: "565171f7-a3ca-45a4-b50e-4d8b07cf0b86",
      agentName: "arcanada-assistant",
      workspaceId: "05f8cddf-e91f-430b-81e3-d67965aa4de3",
      until: STANDING_DIGEST_GRANT_UNTIL,
      standing: true,
      decision: "DEC-AUP-0049",
      evidence:
        "DEC-AUP-0049 A7 (operator order 2026-10-27): standing grant, no time expiry. " +
        "Projection unchanged at seven columns: id, projectId, title, status, priority, " +
        "createdAt, updatedAt; read-only, own workspace, one activity row per read. " +
        "Revocation = remove this entry by pull request. reverse_if: a secret is found in a " +
        "task title, this agent's key is compromised, or the consumer is retired. Prior basis: " +
        "A6 (Program PR445, merge d0a60fdc) title slice 6602/6602 zero hits; Muneral task 7b3b4703.",
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
  // A malformed entry is never live: it can only be cited as expired.
  const live = entries.find(
    (e) =>
      digestGrantInvariantViolation(e) === null &&
      (e.standing === true || now.getTime() < Date.parse(e.until)),
  );
  return live
    ? { kind: "live", entry: live }
    : { kind: "expired", entry: entries[0] };
}

/** When the holder should renew: `GRANT_RENEWAL_LEAD_DAYS` before `until`.
 *  A standing entry has no renewal, so it answers undefined. */
export function digestRenewalDueAt(
  entry: WorkspaceDigestGrantEntry,
): string | undefined {
  if (entry.standing === true) return undefined;
  return new Date(
    Date.parse(entry.until) - GRANT_RENEWAL_LEAD_DAYS * 86_400_000,
  ).toISOString();
}
