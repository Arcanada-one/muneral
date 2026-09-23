/**
 * MUN-0055 (DEC-AUP-0033 R2) — the invariants of the grant list itself.
 *
 * The list is a hand-written TypeScript literal that a pull request edits. It
 * is the whole authorisation surface of the index route, so the properties a
 * reviewer would have to check by eye are checked here instead: one entry per
 * (agent, project), a window no wider than the decision protocol allows, and a
 * decision id that looks like one.
 *
 * These are invariants of the SHIPPED list, not of a fixture. A renewal PR that
 * appends a second entry for a pair, or types a window of a year, goes red here
 * before it reaches review.
 */
import {
  PROJECT_READ_GRANT_LIST,
  MAX_GRANT_WINDOW_DAYS,
  GRANT_RENEWAL_LEAD_DAYS,
  projectReadGrantState,
  projectReadGrantFor,
  agentHoldsAnyLiveProjectReadGrant,
  projectHasLiveGrantForAgent,
  renewalDueAt,
} from '../src/auth/project-read-grants.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('the shipped project-read grant list', () => {
  it('names at most one entry per (agentId, projectId)', () => {
    const pairs = PROJECT_READ_GRANT_LIST.map(
      (g) => `${g.agentId.toLowerCase()}|${g.projectId.toLowerCase()}`,
    );
    expect(pairs).toEqual([...new Set(pairs)]);
  });

  it('carries a parseable, future-dated `until` no wider than the protocol allows', () => {
    for (const g of PROJECT_READ_GRANT_LIST) {
      const until = Date.parse(g.until);
      expect(Number.isNaN(until)).toBe(false);
      // An entry whose window already exceeds the cap measured from TODAY
      // could never have been legitimately merged: the cap is 30 days from
      // the merge, and a merge is never in the future.
      expect(until - Date.now()).toBeLessThanOrEqual(MAX_GRANT_WINDOW_DAYS * 86_400_000);
      // UTC and unambiguous. The list writes `...T00:00:00Z` (no milliseconds),
      // the same form the decision records use; what is pinned is the instant
      // and the zone, not the spelling.
      expect(g.until).toMatch(/Z$/);
      expect(Date.parse(g.until)).toBe(Date.parse(new Date(until).toISOString()));
    }
  });

  it('names a program decision and real uuids, and says what bought the window', () => {
    for (const g of PROJECT_READ_GRANT_LIST) {
      expect(g.decision).toMatch(/^DEC-AUP-\d{4}$/);
      expect(g.agentId).toMatch(UUID);
      expect(g.projectId).toMatch(UUID);
      expect(g.agentName.length).toBeGreaterThan(0);
      expect(g.evidence.length).toBeGreaterThan(40);
    }
  });

  it('leaves a renewal window ahead of every expiry', () => {
    for (const g of PROJECT_READ_GRANT_LIST) {
      expect(Date.parse(renewalDueAt(g))).toBe(
        Date.parse(g.until) - GRANT_RENEWAL_LEAD_DAYS * 86_400_000,
      );
    }
  });
});

describe('projectReadGrantState', () => {
  const entry = {
    agentId: 'aaaaaaaa-0000-4000-8000-000000000001',
    agentName: 'a',
    projectId: 'bbbbbbbb-0000-4000-8000-000000000002',
    until: '2026-10-14T00:00:00Z',
    decision: 'DEC-AUP-0033',
    evidence: 'e',
  };
  const before = new Date('2026-10-13T23:59:59Z');
  const after = new Date('2026-10-14T00:00:01Z');

  it('separates "no entry" from "entry, expired" — the whole point of the 403', () => {
    expect(projectReadGrantState(entry.agentId, entry.projectId, before, [entry])).toEqual({
      kind: 'live',
      entry,
    });
    expect(projectReadGrantState(entry.agentId, entry.projectId, after, [entry])).toEqual({
      kind: 'expired',
      entry,
    });
    expect(projectReadGrantState(entry.agentId, 'cccccccc-0000-4000-8000-000000000003', after, [entry])).toEqual({
      kind: 'none',
    });
    expect(projectReadGrantState('dddddddd-0000-4000-8000-000000000004', entry.projectId, before, [entry])).toEqual({
      kind: 'none',
    });
  });

  it('treats `until` as EXCLUSIVE, to the millisecond', () => {
    expect(projectReadGrantState(entry.agentId, entry.projectId, new Date(Date.parse(entry.until) - 1), [entry]).kind).toBe('live');
    expect(projectReadGrantState(entry.agentId, entry.projectId, new Date(Date.parse(entry.until)), [entry]).kind).toBe('expired');
  });

  it('takes the LATEST window when a pair somehow has two entries', () => {
    const older = { ...entry, until: '2026-09-21T00:00:00Z', decision: 'DEC-AUP-0029' };
    const at = new Date('2026-10-01T00:00:00Z');
    // declared oldest-first: a plain .find() would return the superseded one
    expect(projectReadGrantState(entry.agentId, entry.projectId, at, [older, entry])).toEqual({
      kind: 'live',
      entry,
    });
    expect(projectReadGrantFor(entry.agentId, entry.projectId, at, [older, entry])).toEqual(entry);
  });

  it('compares ids case-insensitively, as the uuid column does', () => {
    expect(
      projectReadGrantState(entry.agentId.toUpperCase(), entry.projectId.toUpperCase(), before, [entry]).kind,
    ).toBe('live');
  });
});

describe('the field-change withholding predicates (DEC-AUP-0033 R4)', () => {
  const entry = {
    agentId: 'aaaaaaaa-0000-4000-8000-000000000001',
    agentName: 'a',
    projectId: 'bbbbbbbb-0000-4000-8000-000000000002',
    until: '2026-10-14T00:00:00Z',
    decision: 'DEC-AUP-0033',
    evidence: 'e',
  };
  const live = new Date('2026-10-01T00:00:00Z');
  const lapsed = new Date('2026-11-01T00:00:00Z');

  it('is false for every key the list does not name — the early-out that keeps the route unchanged', () => {
    expect(agentHoldsAnyLiveProjectReadGrant('dddddddd-0000-4000-8000-000000000004', live, [entry])).toBe(false);
    expect(agentHoldsAnyLiveProjectReadGrant(entry.agentId, live, [entry])).toBe(true);
    expect(agentHoldsAnyLiveProjectReadGrant(entry.agentId, lapsed, [entry])).toBe(false);
  });

  it('is per project: a granted key loses nothing on a project it was not granted', () => {
    expect(projectHasLiveGrantForAgent(entry.agentId, entry.projectId, live, [entry])).toBe(true);
    expect(projectHasLiveGrantForAgent(entry.agentId, 'cccccccc-0000-4000-8000-000000000003', live, [entry])).toBe(false);
  });
});
