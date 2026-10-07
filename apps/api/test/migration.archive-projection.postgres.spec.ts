import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { FieldChangesService } from '../src/tasks/field-state/field-changes.service.js';
import { ActivityService } from '../src/activity/activity.service.js';
import { TaskFieldStateService } from '../src/tasks/field-state/task-field-state.service.js';
import { MigrationService } from '../src/migration/migration.service.js';
import type { CreateWorkItemDto } from '../src/migration/dto/create-work-item.dto.js';
import { createDisposablePostgres } from './support/disposable-postgres.js';

const requireFromHere = createRequire(import.meta.url);
const pg = createDisposablePostgres('rev4-archive');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let prisma: any;
let service: MigrationService;
let projectId: string;
let workspaceId: string;
const actor = { type: 'agent' as const, id: '', name: 'rev4-test' };

beforeAll(async () => {
  await pg.start();
  const { PrismaClient } = requireFromHere('@prisma/client');
  const { PrismaPg } = requireFromHere('@prisma/adapter-pg');
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: pg.url() }) });
  service = new MigrationService(prisma, new ActivityService(prisma), new TaskFieldStateService(prisma));
  const ownerId = randomUUID(); workspaceId = randomUUID(); projectId = randomUUID(); actor.id = randomUUID();
  await prisma.user.create({ data: { id: ownerId, name: 'rev4-test-owner' } });
  await prisma.workspace.create({ data: { id: workspaceId, ownerId, slug: randomUUID(), name: 'rev4-test' } });
  await prisma.project.create({ data: { id: projectId, workspaceId, slug: randomUUID(), name: 'rev4-test' } });
  await prisma.agent.create({ data: { id: actor.id, workspaceId, name: actor.name } });
}, 180_000);
afterAll(async () => { if (prisma) await prisma.$disconnect(); await pg.stop(); }, 60_000);

async function fixture() {
  const { batch } = await service.createBatch({
    batchKey: randomUUID(), sourceSetEpoch: 'rev4-test', producer: 'rev4-test', projectId,
  }, actor);
  return { batchId: batch.id as string, sourceNamespace: `rev4/${randomUUID()}` };
}
function request(f: Awaited<ReturnType<typeof fixture>>, archive: boolean, revision = 4): CreateWorkItemDto {
  const locator = archive ? '../documentation/archive/cubrim/archive-CUBR-0014.md' : 'tasks/CUBR-0014-task-description.md';
  return {
    ...f, legacyId: 'CUBR-0014', title: 'Synthetic CUBR-0014 precedence control',
    historicalStatus: archive ? 'archived' : 'compliance_done', statusMapRevision: revision,
    idempotencyKey: randomUUID(), occurrence: {
      sourceRoot: 'synthetic', sourceLocator: locator,
      sourceKey: `${archive ? 'archive' : 'desc'}:CUBR-0014`,
      contentDigest: createHash('sha256').update(locator).digest('hex'), capturedAt: '2026-10-07T08:00:00Z',
    },
  };
}
async function taskFor(f: Awaited<ReturnType<typeof fixture>>) {
  return (await service.getWorkItemByLegacy(f.sourceNamespace, 'CUBR-0014', actor)).workItem as { id: string; status: string; revision: number };
}

describe('DEC-AUP-0102 R-ARCHIVE on synthetic CUBR-0014', () => {
  it.each([false, true])('archive wins independently of archive-first=%s', async (archiveFirst) => {
    const f = await fixture();
    await service.createWorkItem(request(f, archiveFirst), actor);
    await service.createWorkItem(request(f, !archiveFirst), actor);
    expect((await taskFor(f)).status).toBe('archived');
    const read = await service.getWorkItemByLegacy(f.sourceNamespace, 'CUBR-0014', actor);
    expect(read.occurrences).toEqual(expect.arrayContaining([
      expect.objectContaining({ historicalStatus: 'compliance_done', historicalAssertedDone: false, statusMapRevision: 4 }),
      expect.objectContaining({ historicalStatus: 'archived', currentVerification: 'not_revalidated', statusMapRevision: 4 }),
    ]));
  });
  it('does not backfill a task imported under a prior revision', async () => {
    const f = await fixture();
    await service.createWorkItem(request(f, false, 3), actor);
    await service.createWorkItem(request(f, true), actor);
    expect((await taskFor(f)).status).toBe('todo');
  });
  it.each(['task:status_changed', 'migration.transition'])('preserves explicit %s before archive arrival', async (action) => {
    const f = await fixture(); await service.createWorkItem(request(f, false), actor);
    const task = await taskFor(f);
    if (action === 'migration.transition') {
      await service.transition(task.id, { expectedRevision: task.revision, toStatus: 'in_progress', idempotencyKey: randomUUID(), basis: 'native decision' }, actor);
    } else {
      await prisma.$transaction(async (tx: typeof prisma) => {
        await tx.task.update({ where: { id: task.id }, data: { status: 'in_progress' } });
        await tx.activityLog.create({ data: { workspaceId, taskId: task.id, actorType: actor.type, actorId: actor.id, action, payload: { from: 'review', to: 'in_progress' } } });
      });
    }
    await service.createWorkItem(request(f, true), actor);
    expect((await taskFor(f)).status).toBe('in_progress');
  });
  it('serializes concurrent archive and description receipts', async () => {
    const f = await fixture();
    await Promise.all([false, true].map((archive) => service.createWorkItem(request(f, archive), actor)));
    expect((await taskFor(f)).status).toBe('archived');
  });
  it('never overwrites a successful concurrent native CAS transition', async () => {
    const f = await fixture(); await service.createWorkItem(request(f, false), actor);
    const task = await taskFor(f);
    const results = await Promise.allSettled([
      service.transition(task.id, { expectedRevision: task.revision, toStatus: 'in_progress', idempotencyKey: randomUUID(), basis: 'concurrent native decision' }, actor),
      service.createWorkItem(request(f, true), actor),
    ]);
    expect(results[1].status).toBe('fulfilled');
    if (results[0].status === 'fulfilled') expect((await taskFor(f)).status).toBe('in_progress');
    else expect((await taskFor(f)).status).toBe('archived');
  });
  it('publishes a changed status hash and version after an acknowledged field', async () => {
    const f = await fixture(); await service.createWorkItem(request(f, false), actor);
    const task = await taskFor(f);
    const fieldState = new TaskFieldStateService(prisma);
    await prisma.$transaction(async (tx: typeof prisma) => {
      const edited = await tx.task.update({ where: { id: task.id }, data: { title: 'Edited synthetic title' } });
      await fieldState.recompute(tx, edited);
    });
    const changes = new FieldChangesService(prisma);
    const before = (await changes.getFieldChanges({ taskId: task.id, agentId: actor.id })).fields.find((v) => v.field === 'status')!;
    await changes.ackFields(task.id, actor.id, { agentId: actor.id, fields: [{ field: 'status', version: before.version }] });
    expect((await changes.getFieldChanges({ taskId: task.id, agentId: actor.id })).fields.find((v) => v.field === 'status')!.changed).toBe(false);
    await service.createWorkItem(request(f, true), actor);
    const after = (await changes.getFieldChanges({ taskId: task.id, agentId: actor.id })).fields.find((v) => v.field === 'status')!;
    expect(after).toEqual(expect.objectContaining({ value: 'archived', changed: true, version: before.version + 1, hash: createHash('sha256').update('archived').digest('hex') }));
    expect(after.hash).not.toBe(before.hash);
  });
  it('keeps an exact request replay byte-identical after archive projection', async () => {
    const f = await fixture(); const desc = request(f, false);
    const first = await service.createWorkItem(desc, actor);
    await service.createWorkItem(request(f, true), actor);
    const replay = await service.createWorkItem(desc, actor);
    expect(replay.replayed).toBe(true); expect(replay.body).toEqual(first.body);
    expect((await taskFor(f)).status).toBe('archived');
  });
});
