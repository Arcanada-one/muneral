// MUN-0043: `archived` has to exist in the DATABASE, not only in the TypeScript
// union. `tasks_status_check` is what a row must satisfy, and the service is not
// the only writer — an import that projected a card onto `archived` against the
// old CHECK would fail with an untyped constraint violation.
//
// These assertions are about the migration text rather than a live database
// (that side is proved in `tasks-agent-scope.e2e.spec.ts`, which stores and
// transitions a real `archived` row): what matters here is that the change is
// additive, that the rollback refuses to invent data, and that no other CHECK
// was loosened while widening this one.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const apiRoot = join(__dirname, '..');
const dir = 'prisma/migrations/20260905210000_add_archived_task_status';
const migration = readFileSync(join(apiRoot, dir, 'migration.sql'), 'utf8');
const rollback = readFileSync(join(apiRoot, dir, 'rollback.sql'), 'utf8');
const schema = readFileSync(join(apiRoot, 'prisma/schema.prisma'), 'utf8');

/** The SQL with `--` comments stripped, so assertions are about what the
 *  migration declares rather than about what its comments discuss. */
const statements = migration
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

describe('the archived task status migration', () => {
  it('replaces the status CHECK with one that accepts archived', () => {
    expect(statements).toContain('DROP CONSTRAINT IF EXISTS tasks_status_check');
    expect(statements).toContain(
      "CHECK (status IN ('todo','in_progress','review','blocked','done','cancelled','archived'))",
    );
  });

  it('widens the constraint without dropping any value it accepted before', () => {
    const accepted = statements.match(/CHECK \(status IN \(([^)]*)\)\)/);
    expect(accepted).not.toBeNull();
    const values = (accepted as RegExpMatchArray)[1]
      .split(',')
      .map((v) => v.trim().replace(/'/g, ''));
    for (const previous of ['todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled']) {
      expect(values).toContain(previous);
    }
    expect(values).toContain('archived');
    expect(values).toHaveLength(7);
  });

  it('touches no row and drops no column', () => {
    // The failure this guards against is a migration that "helpfully" rewrites
    // the 1,340 archive cards imported under revision 2 from `done` to
    // `archived`. Those rows were projected by revision 2 and record it; a
    // schema migration re-deciding them would be exactly the silent
    // re-labelling the revision column exists to prevent.
    expect(statements).not.toMatch(/\bUPDATE\b/i);
    expect(statements).not.toMatch(/\bDELETE\b/i);
    expect(statements).not.toMatch(/DROP\s+COLUMN/i);
    expect(statements).not.toMatch(/\bTRUNCATE\b/i);
    expect(statements).not.toMatch(/status_map_revision/i);
  });

  it('leaves the other CHECK constraints alone', () => {
    for (const untouched of [
      'tasks_priority_check',
      'tasks_actor_type_check',
      'workspace_members_role_check',
      'task_dependencies_type_check',
    ]) {
      expect(statements).not.toContain(untouched);
    }
  });

  it('documents on the column itself that archived is not done', () => {
    expect(migration).toContain('COMMENT ON COLUMN public.tasks.status');
    expect(migration).toContain('NOT a synonym for `done`');
  });

  it('has a rollback that refuses rather than rewriting archived rows', () => {
    expect(rollback).toContain("WHERE status = 'archived'");
    expect(rollback).toContain('RAISE EXCEPTION');
    // It must not quietly fold them back into `done` on the way out.
    expect(rollback).not.toMatch(/UPDATE\s+public\.tasks/i);
    // ...and it does restore the original six-value constraint once empty.
    expect(rollback).toContain(
      "CHECK (status IN ('todo','in_progress','review','blocked','done','cancelled'))",
    );
  });

  it('keeps the Prisma schema comment honest about the constraint', () => {
    expect(schema).toContain(
      "// status CHECK (status IN ('todo','in_progress','review','blocked','done','cancelled','archived')) in migration",
    );
  });
});
