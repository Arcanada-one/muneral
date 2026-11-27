// The auth_identity_links migration: additive by its text, and its constraints in PostgreSQL.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as url from 'node:url';
import { createDisposablePostgres } from './support/disposable-postgres.js';

const nodeRequire = createRequire(import.meta.url);
const { Client } = nodeRequire('pg');

const thisDir = path.dirname(url.fileURLToPath(import.meta.url));
const sql = readFileSync(
  path.join(thisDir, '../prisma/migrations/20261127000000_add_auth_identity_links/migration.sql'),
  'utf8',
);

describe('auth_identity_links migration is additive', () => {
  const statements = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

  it('is a single CREATE TABLE of the new table', () => {
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^CREATE TABLE public\.auth_identity_links \(/);
  });

  it('drops, alters and rewrites nothing', () => {
    expect(statements[0]).not.toMatch(/\b(DROP|ALTER|TRUNCATE|INSERT|RENAME|GRANT|REVOKE)\b/i);
    expect(statements[0]).not.toMatch(/\bDELETE\s+FROM\b|\bUPDATE\s+\w+\s+SET\b/i);
  });
});

describe('auth_identity_links constraints in PostgreSQL', () => {
  const pg = createDisposablePostgres('auth-identity-links');
  let client: InstanceType<typeof Client>;
  const authA = '0192f0c1-0000-7000-8000-00000000000a';
  const authB = '0192f0c1-0000-7000-8000-00000000000b';
  let userA: string;
  let userB: string;

  const link = (authUserId: string, userId: string) =>
    client.query(
      `INSERT INTO auth_identity_links (auth_user_id, user_id, link_method) VALUES ($1, $2, 'test')`,
      [authUserId, userId],
    );

  beforeAll(async () => {
    await pg.start();
    client = new Client({ connectionString: pg.url() });
    await client.connect();
    const user = async (name: string): Promise<string> =>
      (
        await client.query(
          'INSERT INTO users (name, updated_at) VALUES ($1, now()) RETURNING id',
          [name],
        )
      ).rows[0].id;
    userA = await user('a');
    userB = await user('b');
    await link(authA, userA);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await pg.stop();
  }, 30_000);

  it('allows one local user per Auth user', async () => {
    await expect(link(authA, userB)).rejects.toMatchObject({ code: '23505' });
  });

  it('allows one Auth user per local user', async () => {
    await expect(link(authB, userA)).rejects.toMatchObject({ code: '23505' });
  });

  it('refuses a link to a user that does not exist', async () => {
    await expect(link(authB, authB)).rejects.toMatchObject({ code: '23503' });
  });

  it('removes the link together with its local user', async () => {
    await link(authB, userB);
    await client.query('DELETE FROM users WHERE id = $1', [userB]);

    const left = await client.query('SELECT auth_user_id FROM auth_identity_links');

    expect(left.rows).toEqual([{ auth_user_id: authA }]);
  });
});
