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
