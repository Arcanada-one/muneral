// A2-336 — `done` requires at least one evidence attachment, behind a switch.
//
// The gap, measured on 2026-09-25 (A2-332): a work item went `done` through
// `PATCH /tasks/:id/status` while the receipt of one of its runs was never
// attached. Nothing in the transition looked at `task_evidence_attachments`,
// so "done" and "carries a receipt" were two unrelated facts.
//
// The rule is deliberately narrow: at least ONE attachment row on the task.
// It does not say which artefact, it does not fetch the uri, and it does not
// check the bytes — the attachment itself is a claim (see TaskEvidenceService).
//
// OFF by default. Only an agent key may attach evidence (a JWT answers 403
// EVIDENCE_AGENT_KEY_REQUIRED), so with the switch on a human closing a card
// from the board is refused unless an agent attached something first. That is
// a change of workflow, not a bug fix, and it is turned on per deployment once
// the number of `done` tasks without evidence has been measured.
//
// Guarded writers (each re-reads the switch on every call):
//   PATCH /tasks/:id/status                     TasksService.updateStatus
//   POST  /tasks  with status `done`            TasksService.create
//   POST  /migration/work-items/:id/transitions MigrationService.transition
// Deliberately NOT guarded:
//   POST /migration/work-items  — imports a HISTORICAL status; historical
//     "done" is asserted, never verified (I14), and the row cannot carry an
//     attachment before it exists.
//   POST /sync/datarim/:projectId/import — legacy Markdown import from a
//     read-only historical source; it has no transaction around its loop, so
//     refusing mid-way would leave a half-applied import.
//   TasksService.update — has no `status` field.

import { ConflictException } from '@nestjs/common';
import type { EvidenceErrorCode } from './task-evidence.errors.js';

export const DONE_REQUIRES_EVIDENCE_ENV = 'MUNERAL_DONE_REQUIRES_EVIDENCE_ENABLED';

/** Exactly the string `true` turns the rule on. Anything else — unset, `1`,
 *  `TRUE`, a typo — leaves it off, so a deployment cannot half-enable it by a
 *  spelling nobody reads back. */
export function doneRequiresEvidence(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DONE_REQUIRES_EVIDENCE_ENV] === 'true';
}

interface EvidenceCounter {
  taskEvidenceAttachment: { count(args: { where: { taskId: string } }): Promise<number> };
}

/** Throws 409 EVIDENCE_REQUIRED_FOR_DONE when the switch is on, the target is
 *  `done` and the task carries no attachment. A no-op otherwise. Pass the
 *  transaction client when there is one, so the count and the write see the
 *  same snapshot. */
export async function assertEvidenceForDone(
  db: EvidenceCounter,
  taskId: string,
  toStatus: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (toStatus !== 'done' || !doneRequiresEvidence(env)) return;
  const count = await db.taskEvidenceAttachment.count({ where: { taskId } });
  if (count === 0) throw evidenceRequiredForDone(taskId);
}

export function evidenceRequiredForDone(taskId: string | null): ConflictException {
  return new ConflictException({
    code: 'EVIDENCE_REQUIRED_FOR_DONE' satisfies EvidenceErrorCode,
    message:
      (taskId ? `Task ${taskId} carries no evidence attachment. ` : 'A new task carries no evidence attachment. ') +
      'Attach the receipt with POST /tasks/:taskId/evidence (agent key), then move the task to done.',
    taskId,
    toStatus: 'done',
    evidenceCount: 0,
  });
}
