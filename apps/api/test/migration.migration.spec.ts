// MUN-0040: the migration SQL and the Prisma schema must both carry the
// identity guarantees, not just the service layer. A service-only guarantee
// evaporates the moment anything writes to the database by another route.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const apiRoot = join(__dirname, '..');
const dir = 'prisma/migrations/20260905120000_add_migration_import_surface';
const migration = readFileSync(join(apiRoot, dir, 'migration.sql'), 'utf8');
/** The SQL with `--` comments stripped, for assertions about what the schema
 *  actually declares rather than what the comments discuss. */
const statements = migration
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');
const rollback = readFileSync(join(apiRoot, dir, 'rollback.sql'), 'utf8');
const schema = readFileSync(join(apiRoot, 'prisma/schema.prisma'), 'utf8');

describe('migration import surface migration', () => {
  it('creates the four profile tables plus the replay store', () => {
    for (const table of [
      'migration_batches',
      'legacy_identities',
      'source_occurrences',
      'identity_mappings',
      'migration_idempotency_records',
    ]) {
      expect(migration).toContain(`CREATE TABLE public.${table}`);
    }
  });

  it('keeps one legacy id per namespace distinguishable across namespaces', () => {
    // AUP-DAT-002's headline failure: ARAS-0001 from a nested tracker must not
    // silently merge with ARAS-0001 of the root workspace.
    expect(migration).toContain('UNIQUE (source_namespace, legacy_id)');
    // ...while the bare legacy id stays a searchable alias.
    expect(migration).toContain(
      'CREATE INDEX idx_legacy_identities_legacy_id ON public.legacy_identities(legacy_id)',
    );
  });

  it('dedups a source receipt by locator and content, never by title', () => {
    expect(migration).toContain('UNIQUE (legacy_identity_id, source_locator, content_digest)');
    // No title column and no similarity machinery anywhere in the new schema:
    // AUP-X02 forbids dedup by title or embedding, so the ability to do it is
    // simply absent rather than merely unused.
    expect(statements).not.toMatch(/\btitle\b/i);
    expect(statements).not.toMatch(/embedding|similarity|trigram|USING\s+gin/i);
  });

  it('refuses a source key that is only a line number', () => {
    expect(migration).toContain('source_occurrences_source_key_not_line_only_check');
  });

  it('bounds the raw excerpt and the bootstrap stamp in bytes', () => {
    expect(migration).toContain('octet_length(raw_excerpt) <= 16384');
    // Deliberately looser than the service's 8 KiB bound: the service measures
    // compact canonical JSON while jsonb::text renders extra spaces, so equal
    // numbers would leave a window where the service accepted a stamp and this
    // CHECK rejected it as an untyped 500.
    expect(migration).toContain('octet_length(bootstrap_stamp::text) <= 16384');
  });

  it('catches the line-number spellings case-insensitively', () => {
    expect(migration).toContain(
      "source_key !~* '^(?:l(?:ine)?[ :#_-]*)?[0-9]+$'",
    );
  });

  it('defaults every occurrence to not_revalidated', () => {
    expect(migration).toContain("current_verification VARCHAR(32) NOT NULL DEFAULT 'not_revalidated'");
  });

  it('separates historical time from import time', () => {
    // historical_at on the occurrence; imported_at on the task. Two columns,
    // in two tables, so neither can overwrite the other.
    expect(migration).toContain('historical_at TIMESTAMPTZ');
    expect(migration).toContain('ALTER TABLE public.tasks ADD COLUMN imported_at TIMESTAMPTZ');
  });

  it('adds the optimistic revision with a safe default for existing rows', () => {
    expect(migration).toContain(
      'ALTER TABLE public.tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0',
    );
    expect(migration).toContain('CHECK (revision >= 0)');
  });

  it('makes the bootstrap stamp and the batch receipt write-once at the database', () => {
    expect(migration).toContain('tasks_bootstrap_stamp_immutable');
    expect(migration).toContain('migration_batches_receipt_immutable');
    expect(migration).toContain("USING ERRCODE = 'MUN00'");
  });

  it('makes the provenance tables append-only and non-truncatable', () => {
    expect(migration).toContain('source_occurrences_append_only');
    expect(migration).toContain('identity_mappings_append_only');
    expect(migration).toContain('source_occurrences_no_truncate');
    expect(migration).toContain('identity_mappings_no_truncate');
  });

  it('is additive only — nothing is dropped, renamed or re-typed', () => {
    expect(statements).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)\b/i);
    expect(statements).not.toMatch(/\bALTER\s+COLUMN\b/i);
    expect(statements).not.toMatch(/\bTRUNCATE\s+(TABLE\s+)?public\./i);
    expect(statements).not.toMatch(/\bRENAME\b/i);
    expect(statements).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it('restricts every foreign key rather than cascading a delete into provenance', () => {
    expect(statements).not.toContain('ON DELETE CASCADE');
    expect(migration).toContain('ON DELETE RESTRICT ON UPDATE RESTRICT');
  });

  it('maps every new table in Prisma', () => {
    for (const [model, table] of [
      ['MigrationBatch', 'migration_batches'],
      ['LegacyIdentity', 'legacy_identities'],
      ['SourceOccurrence', 'source_occurrences'],
      ['IdentityMapping', 'identity_mappings'],
      ['MigrationIdempotencyRecord', 'migration_idempotency_records'],
    ]) {
      expect(schema).toContain(`model ${model} {`);
      expect(schema).toContain(`@@map("${table}")`);
    }
    expect(schema).toContain('importedAt');
    expect(schema).toContain('bootstrapStamp');
    expect(schema).toContain('revision       Int       @default(0)');
  });

  it('refuses rollback without destructive SQL', () => {
    expect(rollback).toContain('MUN-0040 migration-import surface is forward-only');
    expect(rollback).toContain('RAISE EXCEPTION');
    expect(rollback).not.toMatch(/\b(DROP|DELETE|TRUNCATE)\b/i);
  });
});

// ---------------------------------------------------------------------------
// MUN-0041 — status-map provenance
// ---------------------------------------------------------------------------

const rev2Dir = 'prisma/migrations/20260905190000_add_status_map_provenance';
const rev2 = readFileSync(join(apiRoot, rev2Dir, 'migration.sql'), 'utf8');
const rev2Statements = rev2
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');
const rev2Rollback = readFileSync(join(apiRoot, rev2Dir, 'rollback.sql'), 'utf8');

describe('status-map provenance migration', () => {
  it('adds both provenance columns with defaults that keep legacy rows truthful', () => {
    expect(rev2).toContain('ADD COLUMN status_map_revision INTEGER NOT NULL DEFAULT 0');
    expect(rev2).toContain('ADD COLUMN unmapped BOOLEAN NOT NULL DEFAULT false');
  });

  it('does not backfill existing rows to the current revision', () => {
    // Claiming revision 2 for a row that revision 2 never touched is exactly
    // the falsification this column exists to prevent.
    expect(rev2Statements).not.toMatch(/\bUPDATE\s+public\./i);
    expect(rev2Statements).not.toMatch(/DEFAULT\s+2\b/);
  });

  it('forbids an unmapped occurrence from asserting completion', () => {
    expect(rev2).toContain('source_occurrences_unmapped_not_asserted_done_check');
    expect(rev2).toContain('CHECK (NOT (unmapped AND historical_asserted_done))');
  });

  it('bounds the revision to a non-negative integer', () => {
    expect(rev2).toContain('source_occurrences_status_map_revision_check');
    expect(rev2).toContain('CHECK (status_map_revision >= 0)');
  });

  it('is additive only — nothing is dropped, renamed or re-typed', () => {
    expect(rev2Statements).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)\b/i);
    expect(rev2Statements).not.toMatch(/\bALTER\s+COLUMN\b/i);
    expect(rev2Statements).not.toMatch(/\bTRUNCATE\s+(TABLE\s+)?public\./i);
    expect(rev2Statements).not.toMatch(/\bRENAME\b/i);
    expect(rev2Statements).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it('leaves the six TaskStatus values alone', () => {
    // The projection targets Muneral's vocabulary; it never extends it.
    expect(rev2Statements).not.toMatch(/task_status|tasks_status_check/i);
  });

  it('maps both columns in Prisma', () => {
    expect(schema).toContain('statusMapRevision      Int       @default(0) @map("status_map_revision")');
    expect(schema).toContain('unmapped               Boolean   @default(false)');
  });

  it('refuses rollback without destructive SQL', () => {
    expect(rev2Rollback).toContain('MUN-0041 status-map provenance is forward-only');
    expect(rev2Rollback).toContain('RAISE EXCEPTION');
    expect(rev2Rollback).not.toMatch(/\b(DROP|DELETE|TRUNCATE)\b/i);
  });
});
