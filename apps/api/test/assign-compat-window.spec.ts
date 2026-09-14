// MUN-0051: the dated compatibility window for POST /agents/tasks/:taskId/assign.
// What it still admits is exactly: a listed agent, assigning ITSELF, as executor
// or reviewer, before `until`. Everything else is closed.

import {
  ASSIGN_COMPAT_WINDOW,
  assignCompatWindowAdmits,
} from '../src/auth/assign-compat-window.js';

const LISTED = { agentId: 'agent-listed', agentName: 'listed', until: '2026-09-28T00:00:00Z', evidence: 'test' };
const BEFORE = new Date('2026-09-27T23:59:59Z');
const AT = new Date('2026-09-28T00:00:00Z');

describe('assignCompatWindowAdmits', () => {
  it('admits a listed agent assigning itself as executor or reviewer before the expiry', () => {
    expect(assignCompatWindowAdmits('agent-listed', 'agent-listed', 'executor', BEFORE, [LISTED])).toBe(true);
    expect(assignCompatWindowAdmits('agent-listed', 'agent-listed', 'reviewer', BEFORE, [LISTED])).toBe(true);
  });

  it('closes at the expiry instant (exclusive)', () => {
    expect(assignCompatWindowAdmits('agent-listed', 'agent-listed', 'executor', AT, [LISTED])).toBe(false);
  });

  it('never admits lead, another assignee, a missing role or an unlisted agent', () => {
    expect(assignCompatWindowAdmits('agent-listed', 'agent-listed', 'lead', BEFORE, [LISTED])).toBe(false);
    expect(assignCompatWindowAdmits('agent-listed', 'agent-other', 'executor', BEFORE, [LISTED])).toBe(false);
    expect(assignCompatWindowAdmits('agent-listed', 'agent-listed', undefined, BEFORE, [LISTED])).toBe(false);
    expect(assignCompatWindowAdmits('agent-other', 'agent-other', 'executor', BEFORE, [LISTED])).toBe(false);
  });

  it('the shipped window names one agent and expires no later than 2026-09-28', () => {
    expect(ASSIGN_COMPAT_WINDOW).toHaveLength(1);
    expect(ASSIGN_COMPAT_WINDOW[0].agentName).toBe('aup-orchestrator');
    expect(Date.parse(ASSIGN_COMPAT_WINDOW[0].until)).toBeLessThanOrEqual(Date.parse('2026-09-28T00:00:00Z'));
  });
});
