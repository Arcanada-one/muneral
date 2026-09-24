// A2-255: /health has to name the commit it was built from, and has to say so honestly when it
// cannot. A2-251 §5.5 measured the previous answer: `version` alone, identical (0.4.6) for every
// commit since 6c9b48e, so two different builds were indistinguishable over HTTP.

import { buildInfo } from '../src/build-info.js';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

describe('buildInfo', () => {
  it('reports the commit when the build supplied one', () => {
    expect(buildInfo({ MUNERAL_BUILD_SHA: SHA })).toEqual({
      sha: SHA,
      source: 'MUNERAL_BUILD_SHA',
    });
  });

  it('lowercases and trims, so one commit is one string', () => {
    expect(buildInfo({ MUNERAL_BUILD_SHA: `  ${SHA.toUpperCase()}\n` }).sha).toBe(SHA);
  });

  it('reports not_measured — sha null WITH a reason — when the variable is absent or empty', () => {
    for (const env of [{}, { MUNERAL_BUILD_SHA: '' }, { MUNERAL_BUILD_SHA: '   ' }]) {
      const info = buildInfo(env);
      expect(info.sha).toBeNull();
      expect(info.source).toBeNull();
      // The reason is the whole point: a null with no explanation is read as a service defect,
      // and a null with one is read as "this instance was not built by the deploy".
      expect(info.problem).toContain('MUNERAL_BUILD_SHA');
      expect(info.problem).toContain('not_measured');
    }
  });

  it('refuses a value that is not a full commit id instead of passing it on', () => {
    for (const bad of ['1234567', `${SHA}0`, 'zzzzc3d4e5f60718293a4b5c6d7e8f9012345678', 'latest']) {
      const info = buildInfo({ MUNERAL_BUILD_SHA: bad });
      expect(info.sha).toBeNull();
      expect(info.problem).toContain('40-character');
    }
  });

  it('never invents a commit: sha is null exactly when problem is present', () => {
    const cases = [{}, { MUNERAL_BUILD_SHA: 'nope' }, { MUNERAL_BUILD_SHA: SHA }];
    for (const env of cases) {
      const info = buildInfo(env);
      expect(info.sha === null).toBe(info.problem !== undefined);
    }
  });
});
