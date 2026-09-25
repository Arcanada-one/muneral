// MUN-0049: unit proofs for TaskRedactionService with a mocked Prisma — the
// decision table (idempotent / not found / dirty replacement) and the
// invariant that no cleartext reaches the activity payload or the response.
// The e2e suite proves the same over HTTP against a real database.
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Actor } from '@muneral/types';
import { TaskRedactionService, REDACTION_ACTION } from '../src/tasks/redactions/task-redaction.service.js';
import { sha256Hex } from '../src/tasks/redactions/secret-rules.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ActivityService } from '../src/activity/activity.service.js';
import { KanbanService } from '../src/ws/kanban.service.js';
import { TaskFieldStateService } from '../src/tasks/field-state/task-field-state.service.js';
// vitest exposes describe/it/expect as globals (vitest.config.ts `globals: true`);
// `vi` is the one name that must be imported, exactly as `jest` had to be.
import { vi } from 'vitest';

const HVS = 'hvs.' + 'SyntheticTestToken' + '0'.repeat(10);
const ACTOR: Actor = { type: 'agent', id: 'a1b2c3d4-0000-4000-8000-000000000001', name: 'aup' };
const TASK_ID = 't-1';
const MARKER = '[REDACTED vault-token-hvs sha256:00112233aabbccdd — removed 2026-09-13 KBSYNC-0]';

function makeDeps(task: { title: string; description: string | null } | null, existing: unknown = null) {
  const created: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const recomputed: unknown[] = [];
  const record = {
    id: 'r-1',
    taskId: TASK_ID,
    field: 'title',
    rule: 'vault-token-hvs',
    spanSha256: sha256Hex(HVS),
    replacement: MARKER,
    previousValueSha256: 'p'.repeat(64),
    newValueSha256: 'n'.repeat(64),
    occurrences: 1,
    actorType: 'agent',
    actorId: ACTOR.id,
    createdAt: new Date('2026-09-13T18:00:00Z'),
  };
  const tx = {
    task: {
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        return { id: TASK_ID, ...task, ...args.data };
      }),
    },
    taskRedaction: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { ...record, ...args.data };
      }),
    },
    activityLog: { create: vi.fn(async (args: { data: unknown }) => args.data) },
  };
  const prisma = {
    task: {
      findUnique: vi.fn(async () =>
        task ? { id: TASK_ID, projectId: 'p-1', status: 'todo', ...task, project: { id: 'p-1', workspaceId: 'ws-1' } } : null,
      ),
    },
    taskRedaction: { findUnique: vi.fn(async () => existing) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const activity = new ActivityService(prisma as unknown as PrismaService);
  const kanban = { notify: vi.fn() };
  const fieldState = { recompute: vi.fn(async (_t: unknown, u: unknown) => void recomputed.push(u)) };
  const service = new TaskRedactionService(
    prisma as unknown as PrismaService,
    activity,
    kanban as unknown as KanbanService,
    fieldState as unknown as TaskFieldStateService,
  );
  return { service, prisma, tx, kanban, fieldState, created, updates, recomputed, record };
}

const dto = (over: Partial<{ field: 'title' | 'description'; span_sha256: string; rule: string; replacement: string }> = {}) => ({
  field: 'title' as const,
  span_sha256: sha256Hex(HVS),
  rule: 'vault-token-hvs',
  replacement: MARKER,
  ...over,
});

describe('TaskRedactionService', () => {
  it('replaces exactly the span, recomputes field state, and writes a hash-only activity row + record', async () => {
    const title = `SEC-0076 rotate ${HVS} in vault`;
    const d = makeDeps({ title, description: null });

    const out = await d.service.redact(TASK_ID, ACTOR, dto());

    expect(out.statusCode).toBe(201);
    expect(d.updates).toEqual([{ title: `SEC-0076 rotate ${MARKER} in vault` }]);
    expect(d.recomputed).toHaveLength(1);
    expect(d.created[0]).toMatchObject({
      taskId: TASK_ID,
      field: 'title',
      rule: 'vault-token-hvs',
      spanSha256: sha256Hex(HVS),
      previousValueSha256: sha256Hex(title),
      newValueSha256: sha256Hex(`SEC-0076 rotate ${MARKER} in vault`),
      occurrences: 1,
      actorType: 'agent',
      actorId: ACTOR.id,
    });
    const activityRow = d.tx.activityLog.create.mock.calls[0][0].data;
    expect(activityRow).toMatchObject({ action: REDACTION_ACTION, taskId: TASK_ID, workspaceId: 'ws-1', actorType: 'agent' });
    const serialized = JSON.stringify(activityRow) + JSON.stringify(out.body);
    expect(serialized).not.toContain(HVS);
    expect(serialized).not.toContain(title);
    expect(out.body.idempotent).toBe(false);
    expect(d.kanban.notify).toHaveBeenCalledWith('p-1', 'task:updated', expect.objectContaining({ id: TASK_ID }));
  });

  it('replaces every identical occurrence and records the count', async () => {
    const d = makeDeps({ title: `${HVS} twice ${HVS}`, description: null });
    await d.service.redact(TASK_ID, ACTOR, dto());
    expect(d.updates).toEqual([{ title: `${MARKER} twice ${MARKER}` }]);
    expect(d.created[0]).toMatchObject({ occurrences: 2 });
  });

  it('redacts the description when asked, leaving the title alone', async () => {
    const d = makeDeps({ title: 'clean title', description: `see ${HVS}` });
    await d.service.redact(TASK_ID, ACTOR, dto({ field: 'description' }));
    expect(d.updates).toEqual([{ description: `see ${MARKER}` }]);
  });

  it('answers 200 idempotent and touches nothing when the record already exists', async () => {
    const d = makeDeps({ title: 'already redacted', description: null }, { ...makeDeps(null).record });
    const out = await d.service.redact(TASK_ID, ACTOR, dto());
    expect(out.statusCode).toBe(200);
    expect(out.body.idempotent).toBe(true);
    expect(d.prisma.$transaction).not.toHaveBeenCalled();
    expect(d.kanban.notify).not.toHaveBeenCalled();
  });

  it('409 SPAN_NOT_FOUND when the hash is not among the rule matches, and writes nothing', async () => {
    const d = makeDeps({ title: `other ${HVS}`, description: null });
    await expect(
      d.service.redact(TASK_ID, ACTOR, dto({ span_sha256: sha256Hex('not-this-one') })),
    ).rejects.toMatchObject({ response: { code: 'SPAN_NOT_FOUND', other_spans_of_rule: 1 } });
    expect(d.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('409 when the span hash belongs to another rule than the one named', async () => {
    const d = makeDeps({ title: `other ${HVS}`, description: null });
    await expect(d.service.redact(TASK_ID, ACTOR, dto({ rule: 'pgpassword' }))).rejects.toBeInstanceOf(ConflictException);
  });

  it('409 on an empty description', async () => {
    const d = makeDeps({ title: 'x', description: null });
    await expect(d.service.redact(TASK_ID, ACTOR, dto({ field: 'description' }))).rejects.toBeInstanceOf(ConflictException);
  });

  it('400 REPLACEMENT_NOT_CLEAN when the replacement would itself be blocked', async () => {
    const d = makeDeps({ title: `x ${HVS}`, description: null });
    await expect(
      d.service.redact(TASK_ID, ACTOR, dto({ replacement: `moved to ${HVS}` })),
    ).rejects.toMatchObject({ response: { code: 'REPLACEMENT_NOT_CLEAN', rules: ['vault-token-hvs'] } });
    expect(d.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('400 on a rule the DTO would not have let through', async () => {
    const d = makeDeps({ title: `x ${HVS}`, description: null });
    await expect(d.service.redact(TASK_ID, ACTOR, dto({ rule: 'no-such-rule' }))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404 for a task that does not exist', async () => {
    const d = makeDeps(null);
    await expect(d.service.redact(TASK_ID, ACTOR, dto())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a lost race on the unique index is answered as the idempotent repeat', async () => {
    const d = makeDeps({ title: `x ${HVS}`, description: null });
    const p2002 = Object.assign(new Error('unique'), { code: 'P2002' });
    d.prisma.$transaction.mockRejectedValueOnce(p2002);
    d.prisma.taskRedaction.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(d.record);
    const out = await d.service.redact(TASK_ID, ACTOR, dto());
    expect(out.statusCode).toBe(200);
    expect(out.body.idempotent).toBe(true);
  });
});
