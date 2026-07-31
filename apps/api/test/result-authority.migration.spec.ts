// MUN-0021 adoption gate: committed-result migration — static contract tests.
// Verifies the durable shape the consilium made mandatory: an append-only
// committed-result-reference relation with restrictive foreign keys and
// uniqueness on transition identity, (task, attempt, card, node, node
// version), and (task, mutation).
// No database connection required — reads the migration SQL and Prisma schema
// from disk.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const apiRoot = join(__dirname, '..');
const MIGRATION_DIR =
  'prisma/migrations/20260731010000_add_committed_result_refs';

const migration = readFileSync(
  join(apiRoot, MIGRATION_DIR, 'migration.sql'),
  'utf8',
);
const rollback = readFileSync(
  join(apiRoot, MIGRATION_DIR, 'rollback.sql'),
  'utf8',
);
const schema = readFileSync(join(apiRoot, 'prisma/schema.prisma'), 'utf8');

describe('Committed-result migration', () => {
  // -------------------------------------------------------------------------
  // Tables
  // -------------------------------------------------------------------------

  describe('tables', () => {
    it('creates task_result_nodes and task_committed_result_refs', () => {
      expect(migration).toContain('CREATE TABLE public.task_result_nodes');
      expect(migration).toContain(
        'CREATE TABLE public.task_committed_result_refs',
      );
    });

    it('stores the committed node bytes on the node relation, not the reference', () => {
      const nodeTable = migration.slice(
        migration.indexOf('CREATE TABLE public.task_result_nodes'),
        migration.indexOf('CREATE TABLE public.task_committed_result_refs'),
      );
      expect(nodeTable).toContain('node_payload  JSONB         NOT NULL');

      const refTable = migration.slice(
        migration.indexOf('CREATE TABLE public.task_committed_result_refs'),
      );
      // The reference addresses the result by digest. A receipt that carried
      // result content could claim success without a committed result.
      expect(refTable).not.toContain('node_payload');
      expect(refTable).not.toContain('result_body');
    });

    it('records every ratified CommittedResultRefV0 field', () => {
      for (const column of [
        'result_ref_id',
        'task_id',
        'attempt_id',
        'card_id',
        'card_digest',
        'projection_id',
        'projection_digest',
        'node_id',
        'node_version',
        'result_digest',
        'mutation_id',
        'principal_id',
        'transition_id',
        'aggregate_version',
      ]) {
        expect(migration).toContain(column);
      }
    });

    it('records the deterministic receipt identity alongside its reference', () => {
      expect(migration).toContain('receipt_id        VARCHAR(64)   NOT NULL');
      expect(migration).toContain('causation_id      VARCHAR(256)  NOT NULL');
      expect(migration).toContain('correlation_id    VARCHAR(256)  NOT NULL');
    });
  });

  // -------------------------------------------------------------------------
  // Uniqueness — the three constraints the task description names explicitly
  // -------------------------------------------------------------------------

  describe('uniqueness', () => {
    it('enforces transition identity', () => {
      expect(migration).toContain(
        'CONSTRAINT task_committed_result_refs_transition_unique UNIQUE (transition_id)',
      );
    });

    it('enforces (task, attempt, card, node, node version) semantic identity', () => {
      expect(migration).toContain(
        'UNIQUE (task_id, attempt_id, card_id, node_id, node_version)',
      );
    });

    it('enforces (task, mutation) identity on both relations', () => {
      expect(migration).toContain(
        'CONSTRAINT task_committed_result_refs_mutation_unique UNIQUE (task_id, mutation_id)',
      );
      expect(migration).toContain(
        'CONSTRAINT task_result_nodes_mutation_unique UNIQUE (task_id, mutation_id)',
      );
    });

    it('enforces receipt identity', () => {
      expect(migration).toContain(
        'CONSTRAINT task_committed_result_refs_receipt_unique UNIQUE (receipt_id)',
      );
    });

    it('enforces one row per node version', () => {
      expect(migration).toContain(
        'UNIQUE (task_id, node_id, node_version)',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Digest domain separation
  // -------------------------------------------------------------------------

  describe('digest domain separation', () => {
    it('constrains every digest column to lowercase SHA-256 hex', () => {
      const checks = migration.match(/~ '\^\[0-9a-f\]\{64\}\$'/g) ?? [];
      expect(checks.length).toBeGreaterThanOrEqual(6);
    });

    it('rejects a receipt or reference derived from an instruction digest', () => {
      expect(migration).toContain(
        'task_committed_result_refs_domain_separation_check',
      );
      for (const clause of [
        'result_digest <> card_digest',
        'result_digest <> projection_digest',
        'receipt_id <> card_digest',
        'receipt_id <> projection_digest',
        'result_ref_id <> card_digest',
        'result_ref_id <> projection_digest',
      ]) {
        expect(migration).toContain(clause);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Restrictive deletion semantics
  // -------------------------------------------------------------------------

  describe('foreign keys', () => {
    it('uses ON DELETE RESTRICT for every foreign key', () => {
      const fkCount = (migration.match(/FOREIGN KEY/g) ?? []).length;
      const restrictCount = (
        migration.match(/ON DELETE RESTRICT ON UPDATE RESTRICT/g) ?? []
      ).length;
      expect(fkCount).toBe(6);
      expect(restrictCount).toBe(6);
      expect(migration).not.toContain('ON DELETE CASCADE');
      expect(migration).not.toContain('ON DELETE SET NULL');
    });

    it('binds the transition through a composite (transition, task) key', () => {
      expect(migration).toContain(
        'FOREIGN KEY (transition_id, task_id)\n    REFERENCES public.task_execution_transitions(id, task_id)',
      );
    });

    it('binds the result node through a composite (node, task) key', () => {
      expect(migration).toContain(
        'FOREIGN KEY (result_node_id, task_id)\n    REFERENCES public.task_result_nodes(id, task_id)',
      );
    });

    it('binds the attempt through a composite (attempt, task) key', () => {
      const matches =
        migration.match(
          /FOREIGN KEY \(attempt_id, task_id\)\n    REFERENCES public\.task_execution_attempts\(attempt_id, task_id\)/g,
        ) ?? [];
      expect(matches.length).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Append-only guards
  // -------------------------------------------------------------------------

  describe('append-only guards', () => {
    it('installs an append-only trigger on both relations', () => {
      expect(migration).toContain('CREATE TRIGGER task_result_nodes_append_only');
      expect(migration).toContain(
        'CREATE TRIGGER task_committed_result_refs_append_only',
      );
      expect(migration).toContain(
        'BEFORE UPDATE OR DELETE ON public.task_result_nodes',
      );
      expect(migration).toContain(
        'BEFORE UPDATE OR DELETE ON public.task_committed_result_refs',
      );
    });

    it('hardens both trigger functions', () => {
      const guards = migration.match(/SECURITY DEFINER/g) ?? [];
      expect(guards.length).toBe(2);
      const searchPaths = migration.match(/SET search_path = pg_catalog/g) ?? [];
      expect(searchPaths.length).toBe(2);
    });

    it('revokes both trigger functions from PUBLIC', () => {
      expect(migration).toContain(
        'REVOKE ALL ON FUNCTION public.task_result_nodes_guard() FROM PUBLIC',
      );
      expect(migration).toContain(
        'REVOKE ALL ON FUNCTION public.task_committed_result_refs_guard() FROM PUBLIC',
      );
    });

    it('raises the MUN00 append-only SQLSTATE', () => {
      const codes = migration.match(/USING ERRCODE = 'MUN00'/g) ?? [];
      expect(codes.length).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // Additive and forward-only
  // -------------------------------------------------------------------------

  describe('additive and forward-only', () => {
    it('performs no backfill and mutates no existing row', () => {
      expect(migration).not.toMatch(/^\s*UPDATE\s+/m);
      expect(migration).not.toMatch(/^\s*DELETE\s+FROM/m);
      expect(migration).not.toMatch(/^\s*INSERT\s+INTO/m);
      expect(migration).not.toContain('DROP TABLE');
      expect(migration).not.toContain('DROP COLUMN');
    });

    it('refuses rollback and contains no DROP', () => {
      expect(rollback).toContain('RAISE EXCEPTION');
      expect(rollback).toContain('forward-only');
      expect(rollback).not.toContain('DROP TABLE');
      expect(rollback).not.toContain('DROP FUNCTION');
      expect(rollback).not.toContain('DROP TRIGGER');
    });

    it('adds no fleet registry, lifecycle, placement or command surface', () => {
      // Executable SQL only — the header prose names these terms precisely to
      // record that they are out of scope.
      const lowered = migration
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .toLowerCase();
      for (const forbidden of [
        'desired_state',
        'observed_state',
        'placement',
        'rollout',
        'watchdog',
        'heartbeat',
        'controller_epoch',
        'runtime_incarnation',
        'start_process',
        'stop_process',
      ]) {
        expect(lowered).not.toContain(forbidden);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Prisma / SQL parity
  // -------------------------------------------------------------------------

  describe('Prisma schema parity', () => {
    it('declares both models', () => {
      expect(schema).toContain('model TaskResultNode');
      expect(schema).toContain('model TaskCommittedResultRef');
      expect(schema).toContain('@@map("task_result_nodes")');
      expect(schema).toContain('@@map("task_committed_result_refs")');
    });

    it('mirrors every SQL uniqueness constraint in Prisma', () => {
      for (const declaration of [
        '@@unique([transitionId])',
        '@@unique([transitionId, taskId])',
        '@@unique([taskId, attemptId, cardId, nodeId, nodeVersion])',
        '@@unique([taskId, mutationId])',
        '@@unique([receiptId])',
        '@@unique([taskId, nodeId, nodeVersion])',
        '@@unique([id, taskId])',
      ]) {
        expect(schema).toContain(declaration);
      }
    });

    it('uses Restrict for every relation on both models', () => {
      const model = schema.slice(schema.indexOf('model TaskResultNode'));
      const relations = model.match(/@relation\([^)]*\)/g) ?? [];
      expect(relations.length).toBeGreaterThanOrEqual(6);
      for (const relation of relations) {
        expect(relation).toContain('onDelete: Restrict');
      }
    });

    it('keeps the existing execution-authority relations intact', () => {
      expect(schema).toContain('executionState TaskExecutionState?');
      expect(schema).toContain('attempts       TaskExecutionAttempt[]');
      expect(schema).toContain('transitions    TaskExecutionTransition[]');
      expect(schema).toContain('outboxEvents   TaskOutboxEvent[]');
      expect(schema).toContain('resultNodes    TaskResultNode[]');
      expect(schema).toContain('resultRefs     TaskCommittedResultRef[]');
    });
  });
});
