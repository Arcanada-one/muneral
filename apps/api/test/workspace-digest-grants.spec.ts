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
import {
  WORKSPACE_DIGEST_GRANT_LIST,
  MAX_DIGEST_GRANT_WINDOW_DAYS,
  workspaceDigestGrantState,
  digestRenewalDueAt,
} from '../src/auth/workspace-digest-grants.js';
import {
  MAX_GRANT_WINDOW_DAYS,
  GRANT_RENEWAL_LEAD_DAYS,
} from '../src/auth/project-read-grants.js';
import type { WorkspaceDigestGrantEntry } from '../src/auth/workspace-digest-grants.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AGENT = '9437639a-5f7c-4fe4-be04-18112ba0bada';
const WS = '0a1f9d33-5f7c-4fe4-be04-18112ba0bada';
const entry = (over: Partial<WorkspaceDigestGrantEntry> = {}): WorkspaceDigestGrantEntry => ({
  agentId: AGENT,
  agentName: 'arcanada-assistant',
  workspaceId: WS,
  until: '2999-01-01T00:00:00Z',
  decision: 'DEC-AUP-0099',
  evidence: 'fixture',
  ...over,
});

describe('the shipped workspace-digest grant list', () => {
  it('is EMPTY: merging the route grants the scope to nobody', () => {
    expect(WORKSPACE_DIGEST_GRANT_LIST).toEqual([]);
  });

  it('caps a window at the ceiling DEC-AUP-0029 set for a NARROWER read', () => {
    expect(MAX_DIGEST_GRANT_WINDOW_DAYS).toBe(MAX_GRANT_WINDOW_DAYS);
  });

  // Vacuous today, by construction — and that is why it is written now: the
  // first entry arrives in a pull request that will not be thinking about these.
  it('names at most one entry per (agentId, workspaceId), with real ids and a decision', () => {
    const pairs = WORKSPACE_DIGEST_GRANT_LIST.map(
      (g) => `${g.agentId.toLowerCase()}|${g.workspaceId.toLowerCase()}`,
    );
    expect(pairs).toEqual([...new Set(pairs)]);
    for (const g of WORKSPACE_DIGEST_GRANT_LIST) {
      const until = Date.parse(g.until);
      expect(Number.isNaN(until)).toBe(false);
      expect(until - Date.now()).toBeLessThanOrEqual(MAX_DIGEST_GRANT_WINDOW_DAYS * 86_400_000);
      expect(g.until).toMatch(/Z$/);
      expect(g.decision).toMatch(/^DEC-AUP-\d{4}$/);
      expect(g.agentId).toMatch(UUID);
      expect(g.workspaceId).toMatch(UUID);
      expect(g.agentName.length).toBeGreaterThan(0);
      expect(g.evidence.length).toBeGreaterThan(40);
    }
  });
});

describe('workspaceDigestGrantState', () => {
  const now = new Date('2026-09-24T12:00:00Z');

  it('answers `none` against the shipped list for any key', () => {
    expect(workspaceDigestGrantState(AGENT, WS, now).kind).toBe('none');
  });

  it('separates live, expired and never-granted', () => {
    const live = [entry()];
    const dead = [entry({ until: '2026-09-01T00:00:00Z' })];
    expect(workspaceDigestGrantState(AGENT, WS, now, live)).toEqual({ kind: 'live', entry: live[0] });
    expect(workspaceDigestGrantState(AGENT, WS, now, dead)).toEqual({ kind: 'expired', entry: dead[0] });
    expect(workspaceDigestGrantState(AGENT, WS, now, []).kind).toBe('none');
  });

  it('does not let one workspace’s grant answer for another, or one agent’s for another', () => {
    const grants = [entry()];
    expect(workspaceDigestGrantState(AGENT, '11111111-1111-1111-1111-111111111111', now, grants).kind).toBe('none');
    expect(workspaceDigestGrantState('22222222-2222-2222-2222-222222222222', WS, now, grants).kind).toBe('none');
  });

  // `uuid` compares case-insensitively in PostgreSQL; a JS `===` against a
  // literal typed in another case matched nothing, and a live grant was refused
  // by a spelling the database considers identical (MUN-0055 R2).
  it('compares ids case-insensitively', () => {
    const grants = [entry({ agentId: AGENT.toUpperCase(), workspaceId: WS.toUpperCase() })];
    expect(workspaceDigestGrantState(AGENT, WS, now, grants).kind).toBe('live');
  });

  it('cites the newest window when two entries coexist after a bad merge', () => {
    const older = entry({ until: '2026-09-02T00:00:00Z', decision: 'DEC-AUP-0001' });
    const newer = entry({ until: '2026-09-10T00:00:00Z', decision: 'DEC-AUP-0002' });
    const state = workspaceDigestGrantState(AGENT, WS, now, [older, newer]);
    expect(state.kind).toBe('expired');
    expect(state.kind === 'expired' && state.entry.decision).toBe('DEC-AUP-0002');
  });

  it('is exclusive at `until`: the instant itself is already closed', () => {
    const grants = [entry({ until: '2026-09-24T12:00:00Z' })];
    expect(workspaceDigestGrantState(AGENT, WS, now, grants).kind).toBe('expired');
    expect(workspaceDigestGrantState(AGENT, WS, new Date(now.getTime() - 1), grants).kind).toBe('live');
  });
});

describe('digestRenewalDueAt', () => {
  it('lands GRANT_RENEWAL_LEAD_DAYS before `until`', () => {
    const e = entry({ until: '2026-10-14T00:00:00Z' });
    expect(digestRenewalDueAt(e)).toBe(
      new Date(Date.parse(e.until) - GRANT_RENEWAL_LEAD_DAYS * 86_400_000).toISOString(),
    );
  });
});
