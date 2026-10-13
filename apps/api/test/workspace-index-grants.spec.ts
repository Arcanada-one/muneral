import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { jest as jestRuntime } from '@jest/globals';
import { admitProjectIndex } from '../src/auth/project-index-admission.js';
import { WORKSPACE_INDEX_GRANT_LIST } from '../src/auth/workspace-index-grants.js';
import type { WorkspaceIndexGrantEntry } from '../src/auth/workspace-index-grants.js';
import { PROJECT_READ_GRANT_LIST } from '../src/auth/project-read-grants.js';
import { WORKSPACE_DIGEST_GRANT_LIST } from '../src/auth/workspace-digest-grants.js';
const jest = jestRuntime as unknown as typeof globalThis.jest;
const grant: WorkspaceIndexGrantEntry = {
  agentId: 'reader', agentName: 'reader', workspaceId: 'fixed', anchorProjectId: 'anchor',
  excludedProjectSlugs: ['tbt', 'mt5-bridge'], until: '2026-11-04T00:00:00Z',
  decision: 'DEC-TEST', evidence: 'synthetic',
};
const now = new Date('2026-10-07T00:00:00Z');
const legacy = { agentId: 'reader', agentName: 'reader', projectId: 'target',
  until: '2026-10-14T00:00:00Z', decision: 'DEC-OLD', evidence: 'synthetic' };
function fixture() {
  const agent = { workspaceId: 'fixed' };
  const target = { id: 'target', workspaceId: 'fixed', slug: 'eligible' };
  const anchor = { id: 'anchor', workspaceId: 'fixed', slug: 'aup' };
  const db = {
    agent: { findUnique: jest.fn().mockImplementation(async ({ where }) => where.id === 'reader' ? agent : null) },
    project: { findFirst: jest.fn().mockImplementation(async ({ where }) => {
      const p = [target, anchor].find(x => x.id.toLowerCase() === where.id.toLowerCase() && x.workspaceId === where.workspaceId);
      return p ?? null;
    }) },
  };
  const admit = (date = now, entries = [grant], explicit = [] as typeof legacy[]) =>
    admitProjectIndex(db as never, 'reader', 'target', date, explicit, entries, 'fixed');
  return { db, agent, target, anchor, admit };
}
describe('workspace index admission', () => {
  it('requires named identity, fixed workspace and current anchor before fallback', async () => {
    const f = fixture();
    expect((await f.admit()).grant).toMatchObject({ kind: 'workspace-index', workspaceId: 'fixed', projectId: 'target' });
    await expect(admitProjectIndex(f.db as never, 'other', 'target', now, [], [grant])).rejects.toThrow(NotFoundException);
    f.anchor.workspaceId = 'other';
    await expect(f.admit()).rejects.toThrow(NotFoundException);
  });
  it('refuses joint agent/anchor/target movement away from the fixed binding', async () => {
    const f = fixture();f.agent.workspaceId = f.anchor.workspaceId = f.target.workspaceId = 'other';
    await expect(admitProjectIndex(f.db as never, 'reader', 'target', now, [], [grant], 'other')).rejects.toThrow(NotFoundException);
  });
  it('refuses target movement and mismatch against checked guard context', async () => {
    const f = fixture();f.target.workspaceId = 'other';await expect(f.admit()).rejects.toThrow(NotFoundException);
    f.target.workspaceId = 'fixed';f.agent.workspaceId = 'other';await expect(f.admit()).rejects.toThrow(NotFoundException);
  });
  it.each(['tbt','mt5-bridge'])('denies current %s slug before both explicit and workspace grants', async slug => {
    const f = fixture();f.target.slug = slug;
    await expect(f.admit(now, [grant], [legacy])).rejects.toThrow(NotFoundException);
    await expect(f.admit()).rejects.toThrow(NotFoundException);
  });
  it('follows current slug at admission, not immutable project identity', async () => {
    const f = fixture();f.target.slug = 'tbt';await expect(f.admit()).rejects.toThrow(NotFoundException);
    f.target.slug = 'eligible';expect((await f.admit()).grant.decision).toBe('DEC-TEST');
  });
  it('retains explicit live authority and refuses explicit expiry before fallback', async () => {
    const f = fixture();expect((await f.admit(now, [grant], [legacy])).grant).toEqual(legacy);
    const error = await f.admit(new Date(legacy.until), [grant], [legacy]).catch(x => x);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.getResponse()).toMatchObject({ code: 'GRANT_EXPIRED', decision: 'DEC-OLD', until: legacy.until });
  });
  it('ends exclusively at the fixed workspace expiry, with no sliding extension', async () => {
    const f = fixture();expect((await f.admit(new Date(Date.parse(grant.until)-1))).grant.until).toBe(grant.until);
    for (const ms of [0,1]) await expect(f.admit(new Date(Date.parse(grant.until)+ms))).rejects.toThrow(ForbiddenException);
  });
  it('fails closed for absent, malformed or conflicting workspace grant configuration', async () => {
    const f = fixture();
    for (const entries of [[], [{...grant, until:'invalid'}], [grant,grant], [{...grant, workspaceId:'other'}]]) {
      await expect(f.admit(now,entries)).rejects.toThrow(NotFoundException);
    }
  });
  it('conceals unknown, foreign and excluded targets with the same refusal shape', async () => {
    const f = fixture();
    const responses = [];
    for (const action of [() => {f.target.workspaceId='other';},() => {f.target.workspaceId='fixed';f.target.slug='tbt';},() => {f.target.id='missing';}]) {
      action();const e = await f.admit().catch(x=>x);responses.push(e.getResponse());
    }
    expect(responses[1]).toEqual(responses[0]);expect(responses[2]).toEqual(responses[0]);
  });
  it('matches UUID spelling independently of case', async () => {
    const f = fixture();const result = await admitProjectIndex(f.db as never,'reader','TARGET',now,[],[{...grant,agentId:'READER',anchorProjectId:'ANCHOR'}],'FIXED');
    expect(result.grant.projectId).toBe('target');
  });
  it('retains published identity bindings and all pre-existing expiry values', () => {
    expect(PROJECT_READ_GRANT_LIST.map(x=>[x.decision,x.until])).toEqual([
      ['DEC-AUP-0033','2026-10-14T00:00:00Z'],['DEC-AUP-0096','2026-11-04T00:00:00Z'],
    ]);
    expect(WORKSPACE_DIGEST_GRANT_LIST[0].until).toBe('2026-10-09T00:00:00Z');
    expect(WORKSPACE_INDEX_GRANT_LIST).toHaveLength(1);
    expect(WORKSPACE_INDEX_GRANT_LIST[0].workspaceId).toBe(WORKSPACE_DIGEST_GRANT_LIST[0].workspaceId);
    expect(WORKSPACE_INDEX_GRANT_LIST[0].agentId).toBe(PROJECT_READ_GRANT_LIST[0].agentId);
    expect(Date.parse(WORKSPACE_INDEX_GRANT_LIST[0].until)-now.getTime()).toBeLessThanOrEqual(30*86400000);
  });
});
