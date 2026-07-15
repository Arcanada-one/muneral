import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const apiRoot = join(__dirname, '..');
const migration = readFileSync(
  join(
    apiRoot,
    'prisma/migrations/20260715170000_add_muneral_kb_task_changes/migration.sql',
  ),
  'utf8',
);
const rollback = readFileSync(
  join(
    apiRoot,
    'prisma/migrations/20260715170000_add_muneral_kb_task_changes/rollback.sql',
  ),
  'utf8',
);
const schema = readFileSync(join(apiRoot, 'prisma/schema.prisma'), 'utf8');
const realPgHarness = readFileSync(
  join(
    apiRoot,
    'prisma/tests/run_muneral_kb_change_registry_smoke.sh',
  ),
  'utf8',
);

describe('Muneral KB task change registry migration', () => {
  it('models the registry without a relation or foreign key to tasks', () => {
    expect(schema).toContain('model MuneralKbTaskChange {');
    expect(schema).toContain('taskId    String   @id @map("task_id") @db.Uuid');
    expect(schema).toContain('revision  BigInt');
    expect(schema).toContain('deleted   Boolean  @default(false)');
    expect(schema).toContain('@@map("muneral_kb_task_changes")');
    expect(migration).not.toMatch(
      /FOREIGN KEY[\s\S]*muneral_kb_task_changes|muneral_kb_task_changes[\s\S]*REFERENCES public\.tasks/i,
    );
  });

  it('creates a positive revision registry without seeding existing tasks', () => {
    expect(migration).toMatch(
      /CREATE TABLE public\.muneral_kb_task_changes[\s\S]*revision BIGINT NOT NULL CHECK \(revision > 0\)/,
    );
    expect(migration).not.toMatch(
      /INSERT INTO public\.muneral_kb_task_changes[^;]*\bSELECT\b/i,
    );
  });

  it('hardens every helper and trigger function', () => {
    const functionHeaders = migration.match(
      /CREATE FUNCTION public\.[\s\S]*?\$function\$;/g,
    );
    expect(functionHeaders).not.toBeNull();
    for (const definition of functionHeaders ?? []) {
      expect(definition).toContain('SECURITY DEFINER');
      expect(definition).toContain('SET search_path = pg_catalog');
    }
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.muneral_kb_touch_task(uuid, boolean) FROM PUBLIC;',
    );
  });

  it('covers all task graph mutation tables and both dependency endpoints', () => {
    for (const table of [
      'tasks',
      'task_tags',
      'task_checklists',
      'task_agents',
      'activity_log',
      'task_dependencies',
      'projects',
    ]) {
      expect(migration).toContain(`ON public.${table}`);
    }
    expect(migration).toMatch(/OLD\.from_task_id/);
    expect(migration).toMatch(/OLD\.to_task_id/);
    expect(migration).toMatch(/NEW\.from_task_id/);
    expect(migration).toMatch(/NEW\.to_task_id/);
    expect(migration).toMatch(/OLD\.task_id/);
    expect(migration).toMatch(/NEW\.task_id/);
    expect(migration).toMatch(
      /UPDATE OF name, slug ON public\.projects/,
    );
  });

  it('locks every multi-task trigger path in deterministic UUID order', () => {
    expect(
      migration.match(/ORDER BY endpoints\.task_id/g),
    ).toHaveLength(4);
    expect(migration).toMatch(
      /FROM public\.tasks AS source_task[\s\S]*ORDER BY source_task\.id/,
    );
  });

  it('uses only schema-qualified static SQL in security-definer bodies', () => {
    const bodies = [...migration.matchAll(/AS \$function\$([\s\S]*?)\$function\$;/g)]
      .map((match) => match[1])
      .join('\n');
    expect(bodies).not.toMatch(/\bEXECUTE\b/);
    expect(bodies).not.toMatch(
      /\b(?:INSERT INTO|UPDATE|DELETE FROM|FROM)\s+(?:tasks|projects|muneral_kb_task_changes)\b/i,
    );
  });

  it('provides a domain-safe rollback in dependency order', () => {
    expect(rollback).toContain('DROP TRIGGER IF EXISTS');
    expect(rollback).toContain('DROP FUNCTION IF EXISTS public.muneral_kb_');
    expect(rollback).toContain(
      'DROP TABLE IF EXISTS public.muneral_kb_task_changes;',
    );
    expect(rollback).not.toMatch(/\b(DROP|TRUNCATE|DELETE FROM) public\.(tasks|projects|task_)/);
  });

  it('commits a fail-closed least-privilege reader smoke harness', () => {
    expect(realPgHarness).toContain('set -euo pipefail');
    expect(realPgHarness).toContain('REVOKE TEMPORARY');
    expect(realPgHarness).toContain('has_database_privilege');
    expect(realPgHarness).toContain('has_schema_privilege');
    expect(realPgHarness).toContain('has_table_privilege');
    expect(realPgHarness).toContain('SET ROLE');
    expect(realPgHarness).toContain('reader source DML');
    expect(realPgHarness).toContain('reader registry DML');
    expect(realPgHarness).toContain('reader durable schema DDL');
    expect(realPgHarness).toContain('reader durable table DDL');
    expect(realPgHarness).toContain('reader TEMP DDL');
    expect(realPgHarness).toContain('permission denied');
    expect(realPgHarness).toContain('trap on_exit EXIT');
    expect(realPgHarness).toContain('MUNERAL_SMOKE_TEST_FAIL_AFTER_READER');
    expect(realPgHarness).toContain('reader/database residue remains');
    expect(realPgHarness).toContain('concurrent project/dependency sessions');
    expect(realPgHarness).toContain('MUNERAL_KB_CONCURRENCY_PASS');
    expect(realPgHarness).not.toMatch(/password|DATABASE_URL|PGPASSWORD/i);
  });
});
