import { WORKSPACE_DIGEST_GRANT_LIST, workspaceDigestGrantState } from '../src/auth/workspace-digest-grants.js';
import type { WorkspaceDigestGrantEntry } from '../src/auth/workspace-digest-grants.js';
const g = WORKSPACE_DIGEST_GRANT_LIST[0]!;
const during = new Date('2026-10-11T21:00:00Z');
const state = (e: WorkspaceDigestGrantEntry, at = during) => workspaceDigestGrantState(e.agentId, e.workspaceId, at, [e]).kind;
describe('current metadata-only fixed policy source, not proof of adoption', () => {
  it('has one named replacement, fixed ceiling and exact source mode', () => {
    expect(WORKSPACE_DIGEST_GRANT_LIST).toHaveLength(1);
    expect(g.agentId).toBe('565171f7-a3ca-45a4-b50e-4d8b07cf0b86');
    expect(g.workspaceId).toBe('05f8cddf-e91f-430b-81e3-d67965aa4de3');
    expect(g.until).toBe('2026-10-12T20:00:00Z');
    expect(g.projection).toBe('metadata_only');
    expect(g.sourcePolicy).toEqual({amendment:'A6',sha256:'9131080d7637688de3d125ba2764dab352f7e237c602349e0a224413664cdf71'});
    expect(state(g)).toBe('live');
  });
  it('refuses before the 24-hour window and expires at its exact exclusive ceiling', () => {
    expect(state(g,new Date('2026-10-11T19:59:59.999Z'))).toBe('none');
    expect(state(g,new Date('2026-10-11T20:00:00Z'))).toBe('live');
    expect(state(g,new Date('2026-10-12T20:00:00Z'))).toBe('expired');
    expect(state(g,new Date('2026-10-12T20:00:00.001Z'))).toBe('expired');
  });
  it('refuses unknown, missing, stale or mismatched source policy without fallback', () => {
    for (const over of [{projection:'plaintext'}, {projection:undefined}, {sourcePolicy:undefined},
      {projection:undefined,sourcePolicy:undefined},
      {sourcePolicy:{amendment:'A5',sha256:g.sourcePolicy!.sha256}},
      {sourcePolicy:{amendment:'A6',sha256:'0'.repeat(64)}},
      {until:'2026-10-13T20:00:00Z'}, {until:'invalid'}, {decision:'DEC-AUP-0000'}]) {
      expect(state({...g,...over} as WorkspaceDigestGrantEntry)).toBe('none');
    }
  });
  it('preserves genuine old expired refusal and denies foreign principal/workspace', () => {
    const old={...g,until:'2026-10-09T00:00:00Z',projection:undefined,sourcePolicy:undefined};
    expect(state(old)).toBe('expired');
    expect(workspaceDigestGrantState('00000000-0000-4000-8000-000000000000',g.workspaceId,during).kind).toBe('none');
    expect(workspaceDigestGrantState(g.agentId,'00000000-0000-4000-8000-000000000000',during).kind).toBe('none');
  });
});
