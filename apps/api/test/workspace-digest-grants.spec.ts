/**
 * A2-284 — the invariants of the workspace-digest grant list itself.
 *
 * The list is the whole authorisation surface of `GET /tasks/digest` beyond the
 * `@AgentScope` marker, and it is a hand-written literal a pull request edits.
 * The properties a reviewer would otherwise have to check by eye are checked
 * here: the SHIPPED list is empty (merging the route grants nothing), one entry
 * per (agent, workspace), a window no wider than the protocol allows, and a
 * decision id that looks like one.
 *
 * The emptiness test is the one that answers the card's "existing agents must
 * NOT silently gain the scope". It is deliberately an equality on the array,
 * not a `toBeLessThan`: a pull request that adds the assistant's grant must
 * change this file too, which is where a reviewer is told what the entry buys.
 */
import { createHash } from "node:crypto";

import {
  WORKSPACE_DIGEST_GRANT_LIST,
  MAX_DIGEST_GRANT_WINDOW_DAYS,
  STANDING_DIGEST_GRANT_UNTIL,
  digestGrantInvariantViolation,
  workspaceDigestGrantState,
  digestRenewalDueAt,
} from "../src/auth/workspace-digest-grants.js";
import {
  MAX_GRANT_WINDOW_DAYS,
  GRANT_RENEWAL_LEAD_DAYS,
} from "../src/auth/project-read-grants.js";
import type { WorkspaceDigestGrantEntry } from "../src/auth/workspace-digest-grants.js";

const evidenceSha256Of = (evidence: string) =>
  createHash("sha256").update(evidence, "utf8").digest("hex").slice(0, 16);

/**
 * A LITERAL, not `evidenceSha256Of(WORKSPACE_DIGEST_GRANT_LIST[0].evidence)` —
 * that first draft compared the shipped entry against itself and would have
 * passed whatever `evidence` said. This is the sha256 prefix of the evidence
 * recorded under A7; editing the recorded basis fails the equality below.
 */
const EVIDENCE_SHA256_PREFIX = "89cf99b0f5966aee";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AGENT = "9437639a-5f7c-4fe4-be04-18112ba0bada";
const WS = "0a1f9d33-5f7c-4fe4-be04-18112ba0bada";
const entry = (
  over: Partial<WorkspaceDigestGrantEntry> = {},
): WorkspaceDigestGrantEntry => ({
  agentId: AGENT,
  agentName: "arcanada-assistant",
  workspaceId: WS,
  until: "2999-01-01T00:00:00Z",
  decision: "DEC-AUP-0099",
  evidence: "fixture",
  ...over,
});

describe("the shipped workspace-digest grant list", () => {
  /**
   * A2-294 (DEC-AUP-0049) — this WAS `toEqual([])`. The first entry has arrived,
   * so the assertion becomes what the emptiness test was standing in for: the
   * list holds EXACTLY the entries the program's decisions name, compared field
   * by field. An entry appended, removed, re-pointed at another agent or
   * workspace, or given a longer window or a different decision still fails
   * here, which is what the original equality bought and what a `length` or a
   * `toContain` would have thrown away.
   *
   * What this CANNOT check, said plainly rather than left to be assumed: that
   * `DEC-AUP-0049` exists, says what this entry claims, or is merged. The
   * decisions live in a private repository Muneral's CI cannot read
   * (DEC-AUP-0033 R5). That tie is made by the merge review and by the program
   * repository's own gate — not here. A green test on this file is evidence
   * about the literal, not about the authority behind it.
   */
  const ENTRIES_THE_DECISIONS_NAME = [
    {
      agentId: "565171f7-a3ca-45a4-b50e-4d8b07cf0b86",
      agentName: "arcanada-assistant",
      workspaceId: "05f8cddf-e91f-430b-81e3-d67965aa4de3",
      // DEC-AUP-0049 A7 (operator order 2026-10-27): standing, revoked only
      // by removing this entry.
      until: STANDING_DIGEST_GRANT_UNTIL,
      standing: true,
      decision: "DEC-AUP-0049",
      // A prefix of sha256(evidence), so the projection covers `evidence` too:
      // the string that tells a reviewer what the entry bought could otherwise
      // be rewritten freely without failing this equality.
      evidenceSha256: EVIDENCE_SHA256_PREFIX,
    },
  ];

  it("holds EXACTLY the entries the program decisions name", () => {
    expect(
      WORKSPACE_DIGEST_GRANT_LIST.map((g) => ({
        agentId: g.agentId,
        agentName: g.agentName,
        workspaceId: g.workspaceId,
        until: g.until,
        standing: g.standing,
        decision: g.decision,
        evidenceSha256: evidenceSha256Of(g.evidence),
      })),
    ).toEqual(ENTRIES_THE_DECISIONS_NAME);
  });

  it("requires every shipped grant to remain active", () => {
    for (const g of WORKSPACE_DIGEST_GRANT_LIST) {
      expect(digestGrantInvariantViolation(g)).toBeNull();
      const until = Date.parse(g.until);
      expect(Number.isNaN(until)).toBe(false);
      // Keep this wall-clock check: it is the renewal signal when a shipped
      // DATED grant expires, including after a future date passes.
      expect(until).toBeGreaterThan(Date.now());
      if (g.standing === true) continue;
      expect(until - Date.now()).toBeLessThanOrEqual(
        MAX_DIGEST_GRANT_WINDOW_DAYS * 86_400_000,
      );
    }
  });

  it("caps a non-standing window at the ceiling DEC-AUP-0029 set for a NARROWER read", () => {
    expect(MAX_DIGEST_GRANT_WINDOW_DAYS).toBe(MAX_GRANT_WINDOW_DAYS);
    // The only way past the cap is the sentinel, and the sentinel only with
    // `standing: true` — a dated far-future entry is malformed, not standing.
    expect(
      digestGrantInvariantViolation(entry({ until: "2999-01-01T00:00:00Z" })),
    ).toBeNull();
    expect(
      Date.parse("2999-01-01T00:00:00Z") - Date.now(),
    ).toBeGreaterThan(MAX_DIGEST_GRANT_WINDOW_DAYS * 86_400_000);
  });

  // Vacuous today, by construction — and that is why it is written now: the
  // first entry arrives in a pull request that will not be thinking about these.
  it("names at most one entry per (agentId, workspaceId), with real ids and a decision", () => {
    const pairs = WORKSPACE_DIGEST_GRANT_LIST.map(
      (g) => `${g.agentId.toLowerCase()}|${g.workspaceId.toLowerCase()}`,
    );
    expect(pairs).toEqual([...new Set(pairs)]);
    for (const g of WORKSPACE_DIGEST_GRANT_LIST) {
      const until = Date.parse(g.until);
      expect(Number.isNaN(until)).toBe(false);
      if (g.standing !== true) {
        expect(until - Date.now()).toBeLessThanOrEqual(
          MAX_DIGEST_GRANT_WINDOW_DAYS * 86_400_000,
        );
      }
      expect(g.until).toMatch(/Z$/);
      expect(g.decision).toMatch(/^DEC-AUP-\d{4}$/);
      expect(g.agentId).toMatch(UUID);
      expect(g.workspaceId).toMatch(UUID);
      expect(g.agentName.length).toBeGreaterThan(0);
      expect(g.evidence.length).toBeGreaterThan(40);
    }
  });
});

describe("workspaceDigestGrantState", () => {
  const now = new Date("2026-09-24T12:00:00Z");

  it("answers `none` against the shipped list for a key it does not name", () => {
    // A2-294: `AGENT`/`WS` here are aup-orchestrator and a fixture workspace —
    // deliberately NOT the granted pair, so this still asserts the default-deny
    // now that the list is non-empty.
    expect(workspaceDigestGrantState(AGENT, WS, now).kind).toBe("none");
  });

  it("answers `live` for the granted (standing) pair, at any instant", () => {
    const granted = WORKSPACE_DIGEST_GRANT_LIST[0]!;
    expect(granted.standing).toBe(true);
    for (const at of [
      now,
      new Date(Date.parse(STANDING_DIGEST_GRANT_UNTIL)),
      new Date(8.64e15),
    ]) {
      expect(
        workspaceDigestGrantState(granted.agentId, granted.workspaceId, at)
          .kind,
      ).toBe("live");
    }
  });

  it("does not answer `live` for the granted agent in another workspace", () => {
    const granted = WORKSPACE_DIGEST_GRANT_LIST[0]!;
    const during = new Date(Date.parse(granted.until) - 86_400_000);
    expect(workspaceDigestGrantState(granted.agentId, WS, during).kind).toBe(
      "none",
    );
  });

  it("separates live, expired and never-granted", () => {
    const live = [entry()];
    const dead = [entry({ until: "2026-09-01T00:00:00Z" })];
    expect(workspaceDigestGrantState(AGENT, WS, now, live)).toEqual({
      kind: "live",
      entry: live[0],
    });
    expect(workspaceDigestGrantState(AGENT, WS, now, dead)).toEqual({
      kind: "expired",
      entry: dead[0],
    });
    expect(workspaceDigestGrantState(AGENT, WS, now, []).kind).toBe("none");
  });

  it("does not let one workspace’s grant answer for another, or one agent’s for another", () => {
    const grants = [entry()];
    expect(
      workspaceDigestGrantState(
        AGENT,
        "11111111-1111-1111-1111-111111111111",
        now,
        grants,
      ).kind,
    ).toBe("none");
    expect(
      workspaceDigestGrantState(
        "22222222-2222-2222-2222-222222222222",
        WS,
        now,
        grants,
      ).kind,
    ).toBe("none");
  });

  // `uuid` compares case-insensitively in PostgreSQL; a JS `===` against a
  // literal typed in another case matched nothing, and a live grant was refused
  // by a spelling the database considers identical (MUN-0055 R2).
  it("compares ids case-insensitively", () => {
    const grants = [
      entry({ agentId: AGENT.toUpperCase(), workspaceId: WS.toUpperCase() }),
    ];
    expect(workspaceDigestGrantState(AGENT, WS, now, grants).kind).toBe("live");
  });

  it("cites the newest window when two entries coexist after a bad merge", () => {
    const older = entry({
      until: "2026-09-02T00:00:00Z",
      decision: "DEC-AUP-0001",
    });
    const newer = entry({
      until: "2026-09-10T00:00:00Z",
      decision: "DEC-AUP-0002",
    });
    const state = workspaceDigestGrantState(AGENT, WS, now, [older, newer]);
    expect(state.kind).toBe("expired");
    expect(state.kind === "expired" && state.entry.decision).toBe(
      "DEC-AUP-0002",
    );
  });

  it("rejects a standing entry whose until is not the sentinel", () => {
    const bad = entry({ standing: true, until: "2999-01-01T00:00:00Z" });
    expect(digestGrantInvariantViolation(bad)).toMatch(/standing entry/);
    // Fail closed: malformed is never live, even before its date.
    expect(workspaceDigestGrantState(AGENT, WS, now, [bad]).kind).toBe(
      "expired",
    );
  });

  it("rejects a non-standing entry that carries the sentinel", () => {
    const bad = entry({ until: STANDING_DIGEST_GRANT_UNTIL });
    expect(digestGrantInvariantViolation(bad)).toMatch(/reserved/);
    expect(workspaceDigestGrantState(AGENT, WS, now, [bad]).kind).toBe(
      "expired",
    );
  });

  it("answers `live` for a standing grant at a far-future instant", () => {
    const standing = entry({
      standing: true,
      until: STANDING_DIGEST_GRANT_UNTIL,
    });
    expect(digestGrantInvariantViolation(standing)).toBeNull();
    const farFuture = new Date("9999-12-31T23:59:59Z");
    expect(workspaceDigestGrantState(AGENT, WS, farFuture, [standing])).toEqual(
      { kind: "live", entry: standing },
    );
  });

  it("is exclusive at `until`: the instant itself is already closed", () => {
    const grants = [entry({ until: "2026-09-24T12:00:00Z" })];
    expect(workspaceDigestGrantState(AGENT, WS, now, grants).kind).toBe(
      "expired",
    );
    expect(
      workspaceDigestGrantState(AGENT, WS, new Date(now.getTime() - 1), grants)
        .kind,
    ).toBe("live");
  });
});

describe("digestRenewalDueAt", () => {
  it("has no renewal for a standing grant", () => {
    expect(
      digestRenewalDueAt(
        entry({ standing: true, until: STANDING_DIGEST_GRANT_UNTIL }),
      ),
    ).toBeUndefined();
  });

  it("lands GRANT_RENEWAL_LEAD_DAYS before `until`", () => {
    const e = entry({ until: "2026-10-14T00:00:00Z" });
    expect(digestRenewalDueAt(e)).toBe(
      new Date(
        Date.parse(e.until) - GRANT_RENEWAL_LEAD_DAYS * 86_400_000,
      ).toISOString(),
    );
  });
});
