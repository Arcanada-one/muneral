// MUN-0020: Execution authority migration — static contract tests.
// Verifies the schema shape, append-only trigger, uniqueness constraints,
// and that Task relations are additive.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const apiRoot = join(__dirname, '..');
const migration = readFileSync(
  join(
    apiRoot,
    'prisma/migrations/20260730000000_add_execution_authority/migration.sql',
  ),
  'utf8',
);
const rollback = readFileSync(
  join(
    apiRoot,
    'prisma/migrations/20260730000000_add_execution_authority/rollback.sql',
  ),
  'utf8',
);
const schema = readFileSync(join(apiRoot, 'prisma/schema.prisma'), 'utf8');

describe('Execution authority migration', () => {
  describe('Task model relations are additive', () => {
    it('adds executionState, attempts, and transitions relations to Task', () => {
      // The Task model must expose the new relations without replacing
      // existing fields or the status machine.
      expect(schema).toContain('executionState TaskExecutionState?');
      expect(schema).toContain('attempts       TaskExecutionAttempt[]');
      expect(schema).toContain('transitions    TaskExecutionTransition[]');
    });

    it('retains the existing Task status field and enum check', () => {
      expect(schema).toContain('status        String   @default("todo")');
      expect(schema).toMatch(/status IN \('todo'/);
    });

    it('does not remove or rename any existing Task relation', () => {
      for (const rel of [
        /project\s+Project/,
        /sprint\s+Sprint/,
        /tags\s+TaskTag/,
        /checklists\s+TaskChecklist/,
        /activityLogs\s+ActivityLog/,
        /gitRefs\s+TaskGitRef/,
      ]) {
        expect(schema).toMatch(rel);
      }
    });
  });

  describe('New models have proper Prisma relations to Task', () => {
    it('TaskExecutionState has a relation to Task via taskId', () => {
      expect(schema).toContain(
        'onDelete: Restrict',
      );
    });

    it('TaskExecutionAttempt has a relation to Task via taskId', () => {
      const model = schema.match(
        /model TaskExecutionAttempt \{[\s\S]*?\n\}/,
      );
      expect(model).not.toBeNull();
      expect(model![0]).toContain(
        'onDelete: Restrict',
      );
    });

    it('TaskExecutionTransition has a relation to Task via taskId', () => {
      const model = schema.match(
        /model TaskExecutionTransition \{[\s\S]*?\n\}/,
      );
      expect(model).not.toBeNull();
      expect(model![0]).toContain(
        'onDelete: Restrict',
      );
    });

    it('models the task-consistent composite transition-to-attempt relation', () => {
      const attemptModel = schema.match(
        /model TaskExecutionAttempt \{[\s\S]*?\n\}/,
      );
      const transitionModel = schema.match(
        /model TaskExecutionTransition \{[\s\S]*?\n\}/,
      );
      expect(attemptModel).not.toBeNull();
      expect(transitionModel).not.toBeNull();
      expect(attemptModel![0]).toContain(
        'transitions  TaskExecutionTransition[]',
      );
      expect(transitionModel![0]).toMatch(
        /attempt\s+TaskExecutionAttempt\s+@relation\(fields: \[attemptId, taskId\], references: \[attemptId, taskId\], onDelete: Restrict\)/,
      );
    });
  });

  describe('Migration SQL', () => {
    it('creates all three execution-authority tables', () => {
      expect(migration).toContain(
        'CREATE TABLE public.task_execution_state',
      );
      expect(migration).toContain(
        'CREATE TABLE public.task_execution_attempts',
      );
      expect(migration).toContain(
        'CREATE TABLE public.task_execution_transitions',
      );
    });

    it('adds foreign keys with RESTRICT to prevent silent cascade-delete', () => {
      expect(migration).toMatch(
        /task_execution_state_task_id_fkey[\s\S]*ON DELETE RESTRICT/,
      );
      expect(migration).toMatch(
        /task_execution_attempts_task_id_fkey[\s\S]*ON DELETE RESTRICT/,
      );
      expect(migration).toMatch(
        /task_execution_transitions_task_id_fkey[\s\S]*ON DELETE RESTRICT/,
      );
      // Composite FK to attempts also RESTRICT
      expect(migration).toMatch(
        /task_execution_transitions_attempt_task_fkey[\s\S]*ON DELETE RESTRICT/,
      );
    });

    it('enforces (task_id, aggregate_version) uniqueness on transitions', () => {
      expect(migration).toMatch(
        /task_execution_transitions_task_version_unique[\s\S]*UNIQUE \(task_id, aggregate_version\)/,
      );
    });

    it('enforces (task_id, idempotency_key) uniqueness on transitions', () => {
      expect(migration).toMatch(
        /task_execution_transitions_task_idempotency_unique[\s\S]*UNIQUE \(task_id, idempotency_key\)/,
      );
    });

    it('enforces (task_id, ordinal) uniqueness on attempts', () => {
      expect(migration).toMatch(
        /task_execution_attempts_task_ordinal_unique[\s\S]*UNIQUE \(task_id, ordinal\)/,
      );
    });

    it('has an append-only trigger that rejects UPDATE and DELETE', () => {
      expect(migration).toContain(
        'CREATE FUNCTION public.task_execution_transitions_guard()',
      );
      expect(migration).toContain(
        "task_execution_transitions is append-only: UPDATE rejected",
      );
      expect(migration).toContain(
        "task_execution_transitions is append-only: DELETE rejected",
      );
      expect(migration).toContain(
        'CREATE TRIGGER task_execution_transitions_append_only',
      );
      expect(migration).toContain('BEFORE UPDATE OR DELETE');
    });

    it('hardens the trigger function with SECURITY DEFINER and search_path', () => {
      expect(migration).toContain('SECURITY DEFINER');
      expect(migration).toContain('SET search_path = pg_catalog');
    });

    it('revokes public access to the trigger function', () => {
      expect(migration).toContain(
        'REVOKE ALL ON FUNCTION public.task_execution_transitions_guard() FROM PUBLIC;',
      );
    });

    it('enforces task-consistent composite FK from transitions to attempts', () => {
      expect(migration).toMatch(
        /task_execution_attempts_attempt_task_unique[\s\S]*UNIQUE \(attempt_id, task_id\)/,
      );
      expect(migration).toMatch(
        /task_execution_transitions_attempt_task_fkey[\s\S]*FOREIGN KEY \(attempt_id, task_id\)[\s\S]*REFERENCES public\.task_execution_attempts\(attempt_id, task_id\)/,
      );
    });

    it('has CHECK constraints for versions, budgets, and retry_count <= retry_budget', () => {
      expect(migration).toMatch(
        /task_execution_state_version_check\s+CHECK \(aggregate_version > 0\)/,
      );
      expect(migration).toMatch(
        /retry_count <= retry_budget/,
      );
      expect(migration).toMatch(
        /retry_budget >= 0 AND retry_budget <= 1000/,
      );
      expect(migration).toMatch(
        /task_execution_transitions_version_check\s+CHECK \(aggregate_version > 0\)/,
      );
    });

    it('has DEFERRABLE FK for current_attempt_id', () => {
      expect(migration).toMatch(
        /task_execution_state_current_attempt_fkey/,
      );
      expect(migration).toMatch(/DEFERRABLE INITIALLY DEFERRED/);
    });

    it('checks event_type against the allowed values', () => {
      expect(migration).toContain("'attempt:issued'");
      expect(migration).toContain("'attempt:started'");
      expect(migration).toContain("'attempt:succeeded'");
      expect(migration).toContain("'attempt:failed'");
      expect(migration).toContain("'attempt:cancelled'");
      expect(migration).toContain("'attempt:retry_issued'");
    });

    it('uses JSONB for evidence_refs (structured EvidenceRef)', () => {
      expect(migration).toContain('evidence_refs       JSONB');
    });

    it('does not backfill or mutate existing rows', () => {
      expect(migration).not.toMatch(
        /INSERT INTO|UPDATE public\.tasks\b/i,
      );
    });
  });

  describe('Rollback', () => {
    it('is an unconditional forward-only refusal with no DROP statements', () => {
      expect(rollback).toContain('MUN-0020 migration is forward-only');
      expect(rollback).toContain('cannot be rolled back');
      expect(rollback).not.toMatch(/DROP /);
      expect(rollback).not.toMatch(
        /\bDROP\s+(TABLE|TRIGGER|FUNCTION|INDEX|CONSTRAINT)\b/i,
      );
    });
  });
});
