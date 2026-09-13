// MUN-0049: the task_redactions migration and model carry hashes only and
// the unique index the route's idempotency rests on.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as url from 'node:url';
import * as path from 'node:path';

// ESM has no __dirname, and declaring that NAME would mark the module CommonJS.
const thisDir = path.dirname(url.fileURLToPath(import.meta.url));

const apiRoot = join(thisDir, '..');
const dir = 'prisma/migrations/20260913180000_add_task_redactions';
const migration = readFileSync(join(apiRoot, dir, 'migration.sql'), 'utf8');
const rollback = readFileSync(join(apiRoot, dir, 'rollback.sql'), 'utf8');
const schema = readFileSync(join(apiRoot, 'prisma/schema.prisma'), 'utf8');

describe('task_redactions migration (MUN-0049)', () => {
  it('creates the table with the (task, field, span) unique index', () => {
    expect(migration).toMatch(/CREATE TABLE public\.task_redactions \(/);
    expect(migration).toMatch(/UNIQUE \(task_id, field, span_sha256\)/);
    expect(schema).toContain('@@unique([taskId, field, spanSha256], map: "task_redactions_task_field_span_unique")');
  });

  it('constrains every hash column to 64 hex characters and has no column for the value itself', () => {
    for (const col of ['span_sha256', 'previous_value_sha256', 'new_value_sha256']) {
      expect(migration).toMatch(new RegExp(`${col} ~ '\\^\\[0-9a-f\\]\\{64\\}\\$'`));
    }
    expect(migration).not.toMatch(/\b(span|previous_value|new_value|title|description) (TEXT|VARCHAR)/);
  });

  it('is additive: touches no existing table', () => {
    expect(migration).not.toMatch(/ALTER TABLE|DROP /);
  });

  it('rolls back by dropping only its own table', () => {
    expect(rollback).toMatch(/DROP TABLE IF EXISTS public\.task_redactions;/);
    const statements = rollback.split('\n').filter((l) => !l.startsWith('--')).join('\n');
    expect(statements).not.toMatch(/tasks\b|activity_log/);
  });
});
