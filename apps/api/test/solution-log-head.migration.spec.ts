import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const apiRoot = join(__dirname, '..');
const migration = readFileSync(
  join(
    apiRoot,
    'prisma/migrations/20260809180000_add_solution_log_head_receipts/migration.sql',
  ),
  'utf8',
);
const schema = readFileSync(join(apiRoot, 'prisma/schema.prisma'), 'utf8');

describe('solution-log head receipt migration', () => {
  it('stores every receipt binding and provenance-only status', () => {
    expect(migration).toContain('CREATE TABLE public.solution_log_head_receipts');
    for (const column of [
      'receipt_id', 'task_id', 'attempt_id', 'principal_id', 'task_revision',
      'projection_digest_sha256', 'log_revision', 'previous_head_digest_sha256',
      'head_digest_sha256', 'solution_log_digest_sha256',
      'execution_aggregate_version', 'producer_version', 'recorded_at',
      'provenance_scope', 'model_use_status',
    ]) expect(migration).toContain(column);
    expect(migration).toContain("CHECK (provenance_scope = 'PRODUCER_AUTHENTICATED_ONLY')");
    expect(migration).toContain("CHECK (model_use_status = 'NOT_AUTHORIZED')");
  });

  it('enforces one monotonic chain per task attempt and exact producer version', () => {
    expect(migration).toContain('UNIQUE (task_id, attempt_id, producer_version)');
    expect(migration).toContain('UNIQUE (task_id, attempt_id, log_revision)');
    expect(migration).toContain('UNIQUE (task_id, attempt_id, head_digest_sha256)');
  });

  it('uses restrictive task and composite attempt foreign keys', () => {
    expect(migration).toContain('FOREIGN KEY (task_id) REFERENCES public.tasks(id)');
    expect(migration).toContain(
      'FOREIGN KEY (attempt_id, task_id)\n    REFERENCES public.task_execution_attempts(attempt_id, task_id)',
    );
    expect(migration).not.toContain('ON DELETE CASCADE');
  });

  it('rejects update, delete and truncate at the database', () => {
    expect(migration).toContain('solution_log_head_receipts_append_only');
    expect(migration).toContain('BEFORE UPDATE OR DELETE');
    expect(migration).toContain('solution_log_head_receipts_no_truncate');
    expect(migration).toContain('BEFORE TRUNCATE');
  });

  it('maps the append-only receipt model in Prisma', () => {
    expect(schema).toContain('model SolutionLogHeadReceipt');
    expect(schema).toContain('@@map("solution_log_head_receipts")');
  });
});
