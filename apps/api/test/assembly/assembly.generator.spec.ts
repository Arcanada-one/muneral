// MUN-0022 Phase A / A1 — the fixture generator must not maintain its own
// canonicalizer. Golden hashes are regenerated exactly once (plan step A8), so
// the generator's canonical bytes MUST be byte-identical to the shipped
// canonicalizer's before any regeneration happens; otherwise regeneration bakes
// a second implementation's bugs into the committed corpus.
//
// The generator is a build-time CJS script and cannot import TypeScript
// directly (ts-node is not installed). It therefore consumes the compiled
// module under dist/, produced by the existing `build` script. This spec
// compares the generator's exported canonicalizer against the TypeScript source
// of truth, which jest compiles in-process.

import { assemblyCanonicalJson } from '../../src/assembly/assembly.canonical';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const generator = require('./generate-fixtures.js') as {
  canonicalJson: (value: unknown) => string;
};

describe('A1: the fixture generator uses the shipped canonicalizer', () => {
  it('exposes its canonicalizer so parity can be asserted', () => {
    expect(typeof generator.canonicalJson).toBe('function');
  });

  // The defect this phase exists to remove: the generator's private copy used
  // bare JSON.stringify, which emits raw UTF-8 where the shipped canonicalizer
  // forces \uXXXX (ensure_ascii). Every committed fixture is ASCII today, so
  // the divergence is invisible until someone adds a non-ASCII fixture — at
  // which point the generator would mint a hash neither validator agrees with.
  it.each([
    ['cyrillic', { greeting: 'Привет' }],
    ['astral', { emoji: '😀' }],
    ['control char', { ctrl: 'ab' }],
    ['DEL', { del: 'ab' }],
    ['mixed', { k: 'ascii-Привет-😀' }],
  ])('agrees with the shipped canonicalizer on %s', (_name, value) => {
    expect(generator.canonicalJson(value)).toBe(
      assemblyCanonicalJson(value as never),
    );
  });

  it('agrees on nested structures and key ordering', () => {
    const value = { b: [1, { z: 'Привет', a: 2 }], a: 'x' };
    expect(generator.canonicalJson(value)).toBe(
      assemblyCanonicalJson(value as never),
    );
  });
});
