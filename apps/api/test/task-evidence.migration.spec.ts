// A2-274: the evidence-attachment migration is additive and invents no data.
//
// The live half (the route, the unique index, the CHECK, the cascade) is proved
// in `task-evidence.e2e.spec.ts` against a real database. This file pins what
// that suite cannot see: that deploying this migration touches no existing row
// and drops nothing, that the digest format the DTO layer enforces is the same
// one the database holds, and that the rollback removes exactly what was added.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as url from 'node:url';
import { EVIDENCE_SHA256_PATTERN } from '../src/tasks/evidence/task-evidence.errors.js';

// ESM has no __dirname, and declaring that NAME would mark the module CommonJS.
const thisDir = url.fileURLToPath(new URL('.', import.meta.url));

const apiRoot = join(thisDir, '..');
const dir = 'prisma/migrations/20260924170000_add_task_evidence_attachments';
const migration = readFileSync(join(apiRoot, dir, 'migration.sql'), 'utf8');
const rollback = readFileSync(join(apiRoot, dir, 'rollback.sql'), 'utf8');
const schema = readFileSync(join(apiRoot, 'prisma/schema.prisma'), 'utf8');

/** The SQL with `--` comments stripped, so the assertions are about what the
 *  migration declares rather than about what its comments discuss. */
const statements = migration
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

describe('the task evidence-attachment migration (A2-274)', () => {
  it('creates one new table and alters no existing one', () => {
    expect(statements).toMatch(/CREATE TABLE public\.task_evidence_attachments/);
    expect(statements).not.toMatch(/\bALTER TABLE\b/i);
  });

  // Anchored at the start of a line, not anywhere in the text: the referential
  // actions of the two foreign keys contain the words DELETE and UPDATE, and a
  // bare /\bDELETE\b/ would be satisfied by `ON DELETE CASCADE` — a test that
  // passes for a reason unrelated to the thing it claims to check. Every
  // statement in this migration begins its own line.
  it('touches no row and drops nothing', () => {
    expect(statements).not.toMatch(/^\s*(UPDATE|DELETE|INSERT|DROP|TRUNCATE)\b/im);
  });

  it('makes the digest the identity of an attachment', () => {
    expect(statements).toMatch(
      /CONSTRAINT task_evidence_attachments_task_sha256_unique UNIQUE \(task_id, sha256\)/,
    );
  });

  it('holds in the database the same digest format the service enforces', () => {
    const check = statements.match(/sha256 ~ '([^']+)'/);
    expect(check).not.toBeNull();
    expect((check as RegExpMatchArray)[1]).toBe(EVIDENCE_SHA256_PATTERN.source);
  });

  it('loses the evidence with the task and never the author with the evidence', () => {
    expect(statements).toMatch(
      /FOREIGN KEY \(task_id\)\s*\n?\s*REFERENCES public\.tasks\(id\) ON DELETE CASCADE/,
    );
    expect(statements).toMatch(
      /FOREIGN KEY \(created_by_agent_id\)\s*\n?\s*REFERENCES public\.agents\(id\) ON DELETE RESTRICT/,
    );
  });

  it('maps the Prisma model onto that table', () => {
    expect(schema).toMatch(/model TaskEvidenceAttachment \{/);
    expect(schema).toMatch(/@@unique\(\[taskId, sha256\], map: "task_evidence_attachments_task_sha256_unique"\)/);
    expect(schema).toMatch(/@@map\("task_evidence_attachments"\)/);
  });

  it('ships a rollback that removes exactly what it added', () => {
    expect(rollback).toContain('DROP TABLE IF EXISTS public.task_evidence_attachments');
    // One statement: the table carries its own indexes and constraints.
    expect(rollback.match(/^\s*DROP/gm)).toHaveLength(1);
  });
});
