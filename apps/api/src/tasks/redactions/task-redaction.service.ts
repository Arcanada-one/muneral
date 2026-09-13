import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TaskRedaction } from '@prisma/client';
import type { Actor } from '@muneral/types';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ActivityService } from '../../activity/activity.service.js';
import { KanbanService } from '../../ws/kanban.service.js';
import { TaskFieldStateService } from '../field-state/task-field-state.service.js';
import { RedactFieldDto } from './redact-field.dto.js';
import { findingsOf, ruleById, sha256Hex, spansOfRule } from './secret-rules.js';

/** What the route answers. Never the field value, before or after. */
export interface RedactionResult {
  redaction_id: string;
  task_id: string;
  field: string;
  rule: string;
  span_sha256: string;
  replacement: string;
  previous_value_sha256: string;
  new_value_sha256: string;
  occurrences: number;
  actor: { type: string; id: string };
  at: string;
  idempotent: boolean;
}

export const REDACTION_ACTION = 'task:redacted';

/**
 * MUN-0049 — remove one secret-shaped span from a task's title or description.
 *
 * Why this exists: the Scrutator `muneral-kb-sync` scanner names a blocked task
 * by (rule, sha256 of the span) and never by the cleartext. Three imported
 * `datarim-history` tasks carry such a span in their TITLE, no route rewrote a
 * title, and writing to the database directly is forbidden. This is the
 * narrowest route that closes that: the caller names the span the same way the
 * scanner does, the server re-finds it by running that rule over the CURRENT
 * value and comparing hashes, and replaces exactly that span. The caller never
 * sends the secret and never gets it back; the activity payload, the
 * `task_redactions` record and the response carry hashes only.
 *
 * Idempotent on (task, field, span_sha256): the second call finds the record
 * and answers 200 `idempotent: true` without touching the task — the span is
 * gone precisely because the first call removed it, so "not present" is not a
 * conflict there. Concurrent first calls are serialised by the unique index;
 * the loser re-reads and answers the same way.
 *
 * What it does NOT do: change status, revision, any other field, or any other
 * part of the redacted field. Everything else on the task is left as it was.
 */
@Injectable()
export class TaskRedactionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityService: ActivityService,
    private readonly kanbanService: KanbanService,
    private readonly fieldStateService: TaskFieldStateService,
  ) {}

  async redact(
    taskId: string,
    actor: Actor,
    dto: RedactFieldDto,
  ): Promise<{ statusCode: 200 | 201; body: RedactionResult }> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      include: { project: { select: { id: true, workspaceId: true } } },
    });
    if (!task) throw new NotFoundException('Task not found');

    const existing = await this.findRecord(taskId, dto);
    if (existing) return { statusCode: 200, body: present(existing, true) };

    const rule = ruleById(dto.rule);
    if (!rule) {
      // The DTO already restricts `rule`; this is the belt to that brace.
      throw new BadRequestException({ code: 'UNKNOWN_RULE', rule: dto.rule });
    }

    const dirty = findingsOf(dto.replacement);
    if (dirty.length > 0) {
      throw new BadRequestException({
        code: 'REPLACEMENT_NOT_CLEAN',
        message: 'The replacement text would itself be blocked by the kb-sync scanner.',
        rules: dirty,
      });
    }

    const current = dto.field === 'title' ? task.title : (task.description ?? '');
    const spans = spansOfRule(rule, current);
    const target = spans.find((s) => s.sha256 === dto.span_sha256);
    if (!target) {
      throw new ConflictException({
        code: 'SPAN_NOT_FOUND',
        message: `No span of rule ${dto.rule} with that sha256 is present in the current ${dto.field}.`,
        rule: dto.rule,
        span_sha256: dto.span_sha256,
        other_spans_of_rule: spans.length,
      });
    }

    const next = current.split(target.spanText).join(dto.replacement);
    // Post-condition, not a hope: the span must be gone from what we write.
    if (spansOfRule(rule, next).some((s) => s.sha256 === dto.span_sha256)) {
      throw new InternalServerErrorException({ code: 'REDACTION_INCOMPLETE' });
    }

    const previousValueSha256 = sha256Hex(current);
    const newValueSha256 = sha256Hex(next);

    let record: TaskRedaction;
    let updated: Prisma.TaskGetPayload<Record<string, never>>;
    try {
      ({ record, updated } = await this.prisma.$transaction(
        async (tx) => {
          const u = await tx.task.update({
            where: { id: taskId },
            data: dto.field === 'title' ? { title: next } : { description: next },
          });
          await this.fieldStateService.recompute(tx, u);
          const r = await tx.taskRedaction.create({
            data: {
              taskId,
              field: dto.field,
              rule: dto.rule,
              spanSha256: dto.span_sha256,
              replacement: dto.replacement,
              previousValueSha256,
              newValueSha256,
              occurrences: target.occurrences,
              actorType: actor.type,
              actorId: actor.id,
            },
          });
          await this.activityService.log(
            {
              workspaceId: task.project.workspaceId,
              taskId,
              actor,
              action: REDACTION_ACTION,
              payload: {
                redaction_id: r.id,
                field: dto.field,
                rule: dto.rule,
                span_sha256: dto.span_sha256,
                replacement: dto.replacement,
                previous_value_sha256: previousValueSha256,
                new_value_sha256: newValueSha256,
                occurrences: target.occurrences,
              },
            },
            tx,
          );
          return { record: r, updated: u };
        },
        { timeout: 10_000, isolationLevel: 'ReadCommitted' },
      ));
    } catch (err) {
      if (isUniqueViolation(err)) {
        const raced = await this.findRecord(taskId, dto);
        if (raced) return { statusCode: 200, body: present(raced, true) };
      }
      throw err;
    }

    this.kanbanService.notify(task.project.id, 'task:updated', updated);
    return { statusCode: 201, body: present(record, false) };
  }

  private findRecord(taskId: string, dto: RedactFieldDto): Promise<TaskRedaction | null> {
    return this.prisma.taskRedaction.findUnique({
      where: {
        taskId_field_spanSha256: {
          taskId,
          field: dto.field,
          spanSha256: dto.span_sha256,
        },
      },
    });
  }
}

function present(r: TaskRedaction, idempotent: boolean): RedactionResult {
  return {
    redaction_id: r.id,
    task_id: r.taskId,
    field: r.field,
    rule: r.rule,
    span_sha256: r.spanSha256,
    replacement: r.replacement,
    previous_value_sha256: r.previousValueSha256,
    new_value_sha256: r.newValueSha256,
    occurrences: r.occurrences,
    actor: { type: r.actorType, id: r.actorId },
    at: r.createdAt.toISOString(),
    idempotent,
  };
}

function isUniqueViolation(err: unknown): boolean {
  if (err === null || err === undefined || typeof err !== 'object') return false;
  return (err as { code?: string }).code === 'P2002';
}
