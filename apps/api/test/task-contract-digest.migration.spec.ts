// A2-267: the contract-digest migration is additive and invents no data.
//
// The live half (the column exists, the CHECK refuses a malformed value, the
// API round-trips it) is proved in `task-contract-digest.e2e.spec.ts` against a
// real database. This file pins what that suite cannot see: that production
// deploy of this migration touches no existing row and drops nothing, and that
// the DTO and the CHECK agree on the one format.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as url from 'node:url';
import { CONTRACT_DIGEST_PATTERN } from '../src/tasks/dto/create-task.dto.js';

// ESM has no __dirname, and declaring that NAME would mark the module CommonJS.
const thisDir = url.fileURLToPath(new URL('.', import.meta.url));

const apiRoot = join(thisDir, '..');
const dir = 'prisma/migrations/20260924120000_add_task_contract_digest';
const migration = readFileSync(join(apiRoot, dir, 'migration.sql'), 'utf8');
const rollback = readFileSync(join(apiRoot, dir, 'rollback.sql'), 'utf8');
const schema = readFileSync(join(apiRoot, 'prisma/schema.prisma'), 'utf8');

/** The SQL with `--` comments stripped, so assertions are about what the
 *  migration declares rather than about what its comments discuss. */
const statements = migration
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

describe('the task contract-digest migration (A2-267)', () => {
  it('adds one nullable column with no default', () => {
    expect(statements).toMatch(
      /ALTER TABLE public\.tasks ADD COLUMN contract_digest VARCHAR\(71\);/,
    );
    // The statement above ends at the type, so the column is nullable with no
    // default; nothing later may tighten it.
    expect(statements).not.toMatch(/SET NOT NULL/i);
    expect(statements).not.toMatch(/SET DEFAULT/i);
  });

  it('touches no row and drops nothing', () => {
    expect(statements).not.toMatch(/\bUPDATE\b/i);
    expect(statements).not.toMatch(/\bDELETE\b/i);
    expect(statements).not.toMatch(/\bINSERT\b/i);
    expect(statements).not.toMatch(/\bDROP\b/i);
    expect(statements).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('holds in the database the same format the DTO enforces', () => {
    const check = statements.match(/contract_digest ~ '([^']+)'/);
    expect(check).not.toBeNull();
    expect((check as RegExpMatchArray)[1]).toBe(CONTRACT_DIGEST_PATTERN.source);
  });

  it('maps the Prisma field onto that column', () => {
    expect(schema).toMatch(
      /contractDigest\s+String\?\s+@map\("contract_digest"\) @db\.VarChar\(71\)/,
    );
  });

  it('ships a rollback that removes exactly what it added', () => {
    expect(rollback).toContain('DROP INDEX IF EXISTS public.idx_tasks_contract_digest');
    expect(rollback).toContain('DROP CONSTRAINT IF EXISTS tasks_contract_digest_format');
    expect(rollback).toContain('DROP COLUMN IF EXISTS contract_digest');
  });
});
