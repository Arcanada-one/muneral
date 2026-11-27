// Auth Arcana mandate, obligation 6: auth.dependencies.yaml is required at the repository root.
// This suite is the CI gate, and keeps the file in step with the verifier.
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import {
  ARCANA_ALGORITHM,
  ARCANA_AUDIENCE,
  ARCANA_CLIENT_ID,
  ARCANA_ISSUER,
  ARCANA_JWKS_URL,
  ARCANA_SCOPE,
  ARCANA_TOKEN_TYPE,
} from '../src/auth/arcana/arcana-token.verifier.js';
import { ARCANA_SWITCH } from '../src/auth/arcana/arcana-key-source.js';

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../..');
const file = path.join(repoRoot, 'auth.dependencies.yaml');

describe('auth.dependencies.yaml', () => {
  it('exists at the repository root', () => {
    expect(existsSync(file)).toBe(true);
  });

  it.each([
    'service: muneral',
    `target: "${ARCANA_JWKS_URL}"`,
    `issuer: "${ARCANA_ISSUER}"`,
    `audience: "${ARCANA_AUDIENCE}"`,
    `scope: "${ARCANA_SCOPE}"`,
    `client_id: "${ARCANA_CLIENT_ID}"`,
    `algorithm: "${ARCANA_ALGORITHM}"`,
    `token_type: "${ARCANA_TOKEN_TYPE}"`,
    `${ARCANA_SWITCH}=true`,
  ])('declares %s', (line) => {
    expect(readFileSync(file, 'utf8')).toContain(line);
  });
});

/** Obligations 4 and 5 are tracked here until they are met. */
const OWED_TASK = '904d3f60-bded-44b5-b6b3-c89fa4cd7a64';

/**
 * One marker in the code per obligation that can be unmet here. It shows that the old mechanism is
 * still in the tree, not that it is configured or used.
 */
const UNMET_MARKERS: Array<[obligation: number, source: string, marker: RegExp]> = [
  [2, 'apps/api/src/auth/auth.controller.ts', /@(Get|Post)\('(github(\/callback)?|telegram)'\)/],
  [3, 'apps/api/src/auth/jwt-secret.ts', /process\.env\.JWT_SECRET/],
  [4, 'apps/api/src/auth/auth.service.ts', /'mun_sk_'/],
  [5, 'apps/api/prisma/schema.prisma', /model WorkspaceMember \{[^}]*\n\s+role\s+String/],
];

describe('auth.dependencies.yaml not_yet_met agrees with the code', () => {
  const listed = (): Map<number, string> => {
    const block = readFileSync(file, 'utf8').split('\nnot_yet_met:\n')[1] ?? '';
    return new Map(
      [...block.matchAll(/^ {2}- "obligation (\d+): (.+)"$/gm)].map((m) => [Number(m[1]), m[2]]),
    );
  };
  const inCode = (source: string, marker: RegExp): boolean => {
    const target = path.join(repoRoot, source);
    return existsSync(target) && marker.test(readFileSync(target, 'utf8'));
  };

  // Both directions: unlisted while the mechanism is in the code fails, and so does still listed
  // after it is gone.
  it.each(UNMET_MARKERS)('obligation %i is listed exactly while %s still has it', (n, source, marker) => {
    expect(listed().has(n)).toBe(inCode(source, marker));
  });

  it('lists no obligation that has no marker here', () => {
    const known = UNMET_MARKERS.map(([n]) => n);

    expect([...listed().keys()].filter((n) => !known.includes(n))).toEqual([]);
  });

  it.each([4, 5])('obligation %i, while listed, cites the task that tracks it', (n) => {
    const text = listed().get(n);

    if (text !== undefined) expect(text).toContain(OWED_TASK);
  });
});
