// MUN-0040: empirical proofs for the migration import surface, against a
// disposable PostgreSQL. Everything asserted here is a program acceptance
// clause from AUP-DAT-002, AUP-DAT-003, AUP-X01..X05 or MIG-003, not an
// implementation detail — the point is that identity, source occurrence,
// task revision and historical time stay separable under concurrency, replay
// and loss of a response.

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { ActivityService } from '../src/activity/activity.service';
import { MIGRATION_ERROR_CODES } from '../src/migration/migration.errors';
import { MigrationService } from '../src/migration/migration.service';
import type { CreateWorkItemDto } from '../src/migration/dto/create-work-item.dto';
import { createDisposablePostgres } from './support/disposable-postgres';

const pg = createDisposablePostgres('migration-import');

const AGENT: { type: 'agent'; id: string; name: string } = {
  type: 'agent',
  id: '',
  name: 'producer0',
};

function digestOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

beforeAll(async () => pg.start(), 180_000);
afterAll(async () => pg.stop(), 60_000);

describe('Migration import surface — PostgreSQL proofs', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let service: MigrationService;
  let projectId: string;
  let workspaceId: string;

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaClient } = require('@prisma/client');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaPg } = require('@prisma/adapter-pg');
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: pg.url() }) });
    service = new MigrationService(prisma, new ActivityService(prisma));

    const ownerId = randomUUID();
    workspaceId = randomUUID();
    projectId = randomUUID();
    const agentId = randomUUID();
    await prisma.user.create({ data: { id: ownerId, name: 'migration-owner' } });
    await prisma.workspace.create({
      data: { id: workspaceId, slug: `mig-${randomUUID()}`, name: 'migration-ws', ownerId },
    });
    await prisma.project.create({
      data: { id: projectId, workspaceId, slug: `mig-${randomUUID()}`, name: 'migration-project' },
    });
    await prisma.agent.create({ data: { id: agentId, workspaceId, name: 'producer0' } });
    AGENT.id = agentId;
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function openBatch(): Promise<string> {
    const { batch } = await service.createBatch({
      batchKey: `batch-${randomUUID()}`,
      sourceSetEpoch: '2026-09-05T00:00:00Z',
      producer: 'producer0',
      projectId,
    });
    return batch.id as string;
  }

  function importRequest(
    batchId: string,
    overrides: Partial<CreateWorkItemDto> = {},
    occurrenceOverrides: Partial<CreateWorkItemDto['occurrence']> = {},
  ): CreateWorkItemDto {
    const legacyId = (overrides.legacyId ?? `ARAS-${randomUUID().slice(0, 4)}`) as string;
    return {
      batchId,
      sourceNamespace: 'datarim/root',
      legacyId,
      title: `Historical card ${legacyId}`,
      historicalStatus: 'in_progress',
      idempotencyKey: `idem-${randomUUID()}`,
      ...overrides,
      occurrence: {
        sourceRoot: 'datarim/root',
        sourceLocator: `tasks.md#${legacyId}`,
        sourceKey: `heading:${legacyId}`,
        contentDigest: digestOf(`${legacyId}-content`),
        capturedAt: '2026-09-05T08:00:00.000Z',
        ...occurrenceOverrides,
      },
    };
  }

  // -------------------------------------------------------------------------
  // AUP-X04 — batches are the idempotent unit of work
  // -------------------------------------------------------------------------

  describe('batches', () => {
    it('returns the same batch for a repeated key with an identical payload', async () => {
      const payload = {
        batchKey: `batch-${randomUUID()}`,
        sourceSetEpoch: 'epoch-1',
        producer: 'producer0',
        projectId,
      };
      const first = await service.createBatch(payload);
      const second = await service.createBatch(payload);

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.batch).toEqual(first.batch);
      expect(await prisma.migrationBatch.count({ where: { batchKey: payload.batchKey } })).toBe(1);
    });

    it('rejects a repeated key carrying a different payload', async () => {
      const batchKey = `batch-${randomUUID()}`;
      await service.createBatch({
        batchKey,
        sourceSetEpoch: 'epoch-1',
        producer: 'producer0',
        projectId,
      });
      await expect(
        service.createBatch({
          batchKey,
          sourceSetEpoch: 'epoch-2',
          producer: 'producer0',
          projectId,
        }),
      ).rejects.toMatchObject({
        response: { code: 'BATCH_KEY_CONFLICT' },
      });
    });

    it('rejects a batch for a project that does not exist', async () => {
      await expect(
        service.createBatch({
          batchKey: `batch-${randomUUID()}`,
          sourceSetEpoch: 'epoch-1',
          producer: 'producer0',
          projectId: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('produces a receipt digest that is stable across two commits', async () => {
      const batchId = await openBatch();
      await service.createWorkItem(importRequest(batchId), AGENT);
      await service.createWorkItem(importRequest(batchId), AGENT);

      const first = await service.commitBatch(batchId);
      const second = await service.commitBatch(batchId);

      expect(first.status).toBe('committed');
      expect(second).toEqual(first);
      const receipt = first.receipt as Record<string, unknown>;
      expect(receipt.counts).toEqual({ occurrences: 2, identities: 2, workItems: 2 });
      expect(receipt.occurrenceDigest).toMatch(/^[0-9a-f]{64}$/);
      // Readback is byte-identical to what commit returned.
      await expect(service.getBatch(batchId)).resolves.toEqual(first);
    });

    // MUN-0041 (AUP-DAT-006): the receipt is what an orchestrator quotes to
    // prove "0 unmapped". It has to name the map revision that produced the
    // projections and count the values the map did not carry.
    it('reports the status map revision and an unmapped count of zero', async () => {
      const batchId = await openBatch();
      await service.createWorkItem(importRequest(batchId, { historicalStatus: 'archived' }), AGENT);
      await service.createWorkItem(importRequest(batchId, { historicalStatus: 'pending' }), AGENT);

      const receipt = (await service.commitBatch(batchId)).receipt as Record<string, unknown>;
      expect(receipt.statusMapRevision).toBe(2);
      expect(receipt.statusMapRevisions).toEqual([2]);
      expect(receipt.unmappedCount).toBe(0);
      expect(receipt.counts).toEqual({ occurrences: 2, identities: 2, workItems: 2 });
    });

    it('counts every unmapped occurrence, and only those', async () => {
      const batchId = await openBatch();
      await service.createWorkItem(importRequest(batchId, { historicalStatus: 'done' }), AGENT);
      await service.createWorkItem(
        importRequest(batchId, { historicalStatus: 'frobnicated' }),
        AGENT,
      );
      await service.createWorkItem(
        importRequest(batchId, { historicalStatus: 'Wontfix-2019' }),
        AGENT,
      );

      const receipt = (await service.commitBatch(batchId)).receipt as Record<string, unknown>;
      expect(receipt.unmappedCount).toBe(2);
      expect(receipt.statusMapRevision).toBe(2);
    });

    it('reports the revisions actually stored, not the one this build loaded', async () => {
      // A batch that spans a deploy carries receipts written by two different
      // builds. The receipt must show both rather than describing every row
      // with the revision that happens to be loaded now. The pre-MUN-0041 row
      // is written the only way it can be — a direct INSERT that omits the
      // column, exactly as the previous build's statement did; occurrences are
      // append-only, so there is no UPDATE path to fake one with.
      const batchId = await openBatch();
      const created = await service.createWorkItem(
        importRequest(batchId, { historicalStatus: 'done' }),
        AGENT,
      );
      const identityId = (created.body.identity as { id: string }).id;
      await prisma.$executeRawUnsafe(
        `INSERT INTO public.source_occurrences (
           legacy_identity_id, batch_id, source_root, source_locator, source_key,
           content_digest, captured_at, historical_status, historical_asserted_done
         ) VALUES ($1::uuid, $2::uuid, 'datarim/root', 'tasks.md#legacy-row',
                   'heading:legacy-row', $3, now(), 'done', true)`,
        identityId,
        batchId,
        digestOf('legacy-row'),
      );

      const receipt = (await service.commitBatch(batchId)).receipt as Record<string, unknown>;
      // 0 = "projected before this column existed", never backfilled to 2.
      expect(receipt.statusMapRevisions).toEqual([0, 2]);
      expect(receipt.statusMapRevision).toBe(2);
      expect(receipt.unmappedCount).toBe(0);
    });

    it('digests the occurrence pairs in a stable order, not insertion order', async () => {
      // Two batches record the same receipts in opposite order. The digest is
      // over sorted (source_locator, content_digest) pairs, so they agree.
      const pairs = [
        { locator: 'tasks.md#B', digest: digestOf('b') },
        { locator: 'tasks.md#A', digest: digestOf('a') },
      ];
      const digests: string[] = [];
      for (const order of [pairs, [...pairs].reverse()]) {
        const batchId = await openBatch();
        for (const p of order) {
          await service.createWorkItem(
            importRequest(
              batchId,
              { legacyId: `ORD-${randomUUID().slice(0, 8)}` },
              { sourceLocator: p.locator, contentDigest: p.digest },
            ),
            AGENT,
          );
        }
        const committed = await service.commitBatch(batchId);
        digests.push((committed.receipt as { occurrenceDigest: string }).occurrenceDigest);
      }
      expect(digests[0]).toBe(digests[1]);
    });
  });

  // -------------------------------------------------------------------------
  // AUP-DAT-002 — identity
  // -------------------------------------------------------------------------

  describe('identity', () => {
    it('gives concurrent imports of one identity ONE identity, ONE task and N receipts', async () => {
      const batchId = await openBatch();
      const legacyId = `ARAS-${randomUUID().slice(0, 8)}`;
      const requests = [0, 1, 2, 3].map((i) =>
        importRequest(
          batchId,
          { legacyId },
          {
            // Four distinct sightings of the same logical task.
            sourceLocator: `tasks.md#${legacyId}@${i}`,
            contentDigest: digestOf(`${legacyId}-${i}`),
          },
        ),
      );

      const results = await Promise.all(requests.map((r) => service.createWorkItem(r, AGENT)));

      const identities = await prisma.legacyIdentity.findMany({
        where: { sourceNamespace: 'datarim/root', legacyId },
      });
      expect(identities).toHaveLength(1);

      const occurrences = await prisma.sourceOccurrence.findMany({
        where: { legacyIdentityId: identities[0].id },
      });
      expect(occurrences).toHaveLength(4);

      const taskIds = new Set(
        results.map((r) => (r.body.workItem as { id: string }).id),
      );
      expect(taskIds.size).toBe(1);
      expect([...taskIds][0]).toBe(identities[0].taskId);
    });

    it('keeps the same legacy id in two namespaces as two identities', async () => {
      // The named failure scenario: ARAS-0001 from a nested tracker silently
      // merged with ARAS-0001 of the root workspace.
      const batchId = await openBatch();
      const legacyId = `ARAS-${randomUUID().slice(0, 8)}`;
      const root = await service.createWorkItem(
        importRequest(batchId, { legacyId, sourceNamespace: 'datarim/root' }),
        AGENT,
      );
      const nested = await service.createWorkItem(
        importRequest(batchId, { legacyId, sourceNamespace: 'datarim/nested/tracker' }),
        AGENT,
      );

      const rootIdentity = root.body.identity as { id: string; taskId: string };
      const nestedIdentity = nested.body.identity as { id: string; taskId: string };
      expect(rootIdentity.id).not.toBe(nestedIdentity.id);
      expect(rootIdentity.taskId).not.toBe(nestedIdentity.taskId);

      const search = await service.searchByLegacyId(legacyId);
      expect(search.total).toBe(2);
      expect(
        (search.identities as Array<{ sourceNamespace: string }>).map((i) => i.sourceNamespace),
      ).toEqual(['datarim/nested/tracker', 'datarim/root']);
    });

    it('does not create a task when only the title changes', async () => {
      // A title match may only PROPOSE. A title *change* likewise decides
      // nothing on its own: the identity, not the title, owns the binding.
      const batchId = await openBatch();
      const legacyId = `ARAS-${randomUUID().slice(0, 8)}`;
      const first = await service.createWorkItem(importRequest(batchId, { legacyId }), AGENT);
      const renamed = await service.createWorkItem(
        importRequest(
          batchId,
          { legacyId, title: 'A completely different title' },
          { sourceLocator: `tasks.md#${legacyId}@v2`, contentDigest: digestOf('v2') },
        ),
        AGENT,
      );

      expect((renamed.body.workItem as { id: string }).id).toBe(
        (first.body.workItem as { id: string }).id,
      );
      // The rename is recorded as a new receipt, and the bound task keeps the
      // title it was created with until an explicit decision says otherwise.
      expect((renamed.body.workItem as { title: string }).title).toBe(
        (first.body.workItem as { title: string }).title,
      );
      expect(await prisma.task.count({ where: { title: 'A completely different title' } })).toBe(0);
    });

    it('records a split with a full reverse mapping', async () => {
      const batchId = await openBatch();
      const subject = (
        await service.createWorkItem(importRequest(batchId), AGENT)
      ).body.identity as { id: string; mappingRevision: number };
      const targets = await Promise.all(
        [0, 1].map(async () =>
          (
            (await service.createWorkItem(importRequest(batchId), AGENT)).body.identity as {
              id: string;
            }
          ).id,
        ),
      );

      const decision = await service.decide(
        subject.id,
        {
          kind: 'split',
          targets,
          basis: 'The 2019 card covered two independent deliverables.',
          expectedMappingRevision: 0,
        },
        AGENT,
      );

      const identity = decision.identity as { mappingKind: string; mappingRevision: number };
      expect(identity.mappingKind).toBe('split');
      expect(identity.mappingRevision).toBe(1);

      const mappings = decision.mappings as {
        outgoing: Array<{ toIdentityId: string; kind: string }>;
        incoming: Array<{ fromIdentityId: string }>;
      };
      expect(mappings.outgoing.map((m) => m.toIdentityId).sort()).toEqual([...targets].sort());
      expect(mappings.outgoing.every((m) => m.kind === 'split')).toBe(true);

      // The reverse direction resolves from either end.
      for (const target of targets) {
        const reverse = (await service.getReverseMapping(target)) as {
          mappings: { incoming: Array<{ fromIdentityId: string }> };
        };
        expect(reverse.mappings.incoming.map((m) => m.fromIdentityId)).toContain(subject.id);
      }
    });

    it('records a merge with the targets folding into the subject', async () => {
      const batchId = await openBatch();
      const subject = (
        await service.createWorkItem(importRequest(batchId), AGENT)
      ).body.identity as { id: string };
      const target = (
        (await service.createWorkItem(importRequest(batchId), AGENT)).body.identity as {
          id: string;
        }
      ).id;

      const decision = await service.decide(
        subject.id,
        {
          kind: 'merge',
          targets: [target],
          basis: 'Two trackers recorded one deliverable.',
          expectedMappingRevision: 0,
        },
        AGENT,
      );

      const mappings = decision.mappings as {
        outgoing: Array<{ toIdentityId: string }>;
        incoming: Array<{ fromIdentityId: string; kind: string }>;
      };
      // Merge direction: target -> subject, so the subject sees it incoming.
      expect(mappings.incoming.map((m) => m.fromIdentityId)).toEqual([target]);
      expect(mappings.incoming[0].kind).toBe('merge');
      expect(mappings.outgoing).toHaveLength(0);
    });

    it('records a candidate_conflict as a proposal that moves no binding', async () => {
      const batchId = await openBatch();
      const a = (await service.createWorkItem(importRequest(batchId), AGENT)).body.identity as {
        id: string;
        taskId: string;
      };
      const b = (await service.createWorkItem(importRequest(batchId), AGENT)).body.identity as {
        id: string;
        taskId: string;
      };

      const decision = await service.decide(
        a.id,
        {
          kind: 'candidate_conflict',
          targets: [b.id],
          basis: 'Titles are similar; a human must decide.',
          expectedMappingRevision: 0,
        },
        AGENT,
      );

      expect((decision.identity as { mappingKind: string }).mappingKind).toBe('candidate_conflict');
      // Both task bindings are untouched — a proposal is not a decision to bind.
      const [rowA, rowB] = await Promise.all([
        prisma.legacyIdentity.findUnique({ where: { id: a.id } }),
        prisma.legacyIdentity.findUnique({ where: { id: b.id } }),
      ]);
      expect(rowA.taskId).toBe(a.taskId);
      expect(rowB.taskId).toBe(b.taskId);
    });

    it('rejects a decision made against a stale mapping revision', async () => {
      const batchId = await openBatch();
      const subject = (
        await service.createWorkItem(importRequest(batchId), AGENT)
      ).body.identity as { id: string };
      const target = (
        (await service.createWorkItem(importRequest(batchId), AGENT)).body.identity as {
          id: string;
        }
      ).id;

      const decision = {
        kind: 'same' as const,
        targets: [target],
        basis: 'Same card, two exports.',
        expectedMappingRevision: 0,
      };
      await service.decide(subject.id, decision, AGENT);
      await expect(service.decide(subject.id, decision, AGENT)).rejects.toMatchObject({
        response: { code: 'MAPPING_REVISION_STALE', currentMappingRevision: 1 },
      });
    });

    it('rejects a decision naming an identity that does not exist', async () => {
      const batchId = await openBatch();
      const subject = (
        await service.createWorkItem(importRequest(batchId), AGENT)
      ).body.identity as { id: string };
      await expect(
        service.decide(
          subject.id,
          {
            kind: 'same',
            targets: [randomUUID()],
            basis: 'typo',
            expectedMappingRevision: 0,
          },
          AGENT,
        ),
      ).rejects.toMatchObject({ response: { code: 'IDENTITY_NOT_FOUND' } });
      // The failed decision left the revision untouched.
      const row = await prisma.legacyIdentity.findUnique({ where: { id: subject.id } });
      expect(row.mappingRevision).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // AUP-X03 — historical time and historical status
  // -------------------------------------------------------------------------

  describe('historical import', () => {
    it('records an old done as asserted, not revalidated', async () => {
      const batchId = await openBatch();
      const result = await service.createWorkItem(
        importRequest(batchId, { historicalStatus: 'done' }),
        AGENT,
      );

      expect((result.body.workItem as { status: string }).status).toBe('done');
      expect(result.body.occurrence).toMatchObject({
        historicalStatus: 'done',
        historicalAssertedDone: true,
        currentVerification: 'not_revalidated',
      });
    });

    it('parks an unmappable status in todo and keeps the raw value', async () => {
      const batchId = await openBatch();
      const result = await service.createWorkItem(
        importRequest(batchId, { historicalStatus: 'wontfix' }),
        AGENT,
      );
      expect((result.body.workItem as { status: string }).status).toBe('todo');
      expect((result.body.occurrence as { historicalStatus: string }).historicalStatus).toBe(
        'wontfix',
      );
      expect(result.body.statusMapping).toMatchObject({ unmapped: true });
      // producer0 flags; it never refuses a single item. DAT-006 makes UNMAPPED
      // a typed refusal for the BULK importer, which is a different component.
      expect(result.body.occurrence).toMatchObject({
        unmapped: true,
        historicalAssertedDone: false,
        statusMapRevision: 2,
      });
    });

    // MUN-0041 (AUP-DAT-006 / I14): the headline case. 1,309 archive cards
    // would land in `todo` under the shipped six-status logic — a semantic
    // corruption of the history this map exists to prevent.
    it('reads an archived import back as done, asserted but not revalidated', async () => {
      const batchId = await openBatch();
      const created = await service.createWorkItem(
        importRequest(batchId, { historicalStatus: 'archived' }),
        AGENT,
      );
      const legacyId = (created.body.identity as { legacyId: string }).legacyId;

      const readback = await service.getWorkItemByLegacy('datarim/root', legacyId);
      expect((readback.workItem as { status: string }).status).toBe('done');
      const occurrences = readback.occurrences as Array<Record<string, unknown>>;
      expect(occurrences).toHaveLength(1);
      expect(occurrences[0]).toMatchObject({
        historicalStatus: 'archived',
        historicalAssertedDone: true,
        currentVerification: 'not_revalidated',
        unmapped: false,
        statusMapRevision: 2,
      });

      // ...and the revision is durable in the column, not only in the presenter.
      const row = await prisma.sourceOccurrence.findUnique({
        where: { id: occurrences[0].id as string },
        select: { statusMapRevision: true, unmapped: true, historicalStatus: true },
      });
      expect(row).toEqual({
        statusMapRevision: 2,
        unmapped: false,
        historicalStatus: 'archived',
      });
    });

    it.each([
      ['archived', 'done', true],
      ['done_pending_archive', 'done', true],
      ['completed', 'done', true],
      ['done', 'done', true],
      ['pending', 'todo', false],
      ['prd_done', 'in_progress', false],
      ['paused', 'blocked', false],
      ['superseded', 'cancelled', false],
    ])(
      'projects a raw %s onto %s end to end, with the map revision recorded',
      async (raw, projected, assertedDone) => {
        const batchId = await openBatch();
        const result = await service.createWorkItem(
          importRequest(batchId, { historicalStatus: raw }),
          AGENT,
        );
        expect((result.body.workItem as { status: string }).status).toBe(projected);
        expect(result.body.occurrence).toMatchObject({
          historicalStatus: raw,
          historicalAssertedDone: assertedDone,
          currentVerification: 'not_revalidated',
          unmapped: false,
          statusMapRevision: 2,
        });
      },
    );

    it('stores the source spelling, never the normalised one', async () => {
      const batchId = await openBatch();
      const result = await service.createWorkItem(
        importRequest(batchId, { historicalStatus: 'Done ' }),
        AGENT,
      );
      expect((result.body.workItem as { status: string }).status).toBe('done');
      expect((result.body.occurrence as { historicalStatus: string }).historicalStatus).toBe(
        'Done ',
      );
      expect(result.body.occurrence).toMatchObject({
        historicalAssertedDone: true,
        unmapped: false,
      });
    });

    it('refuses at the database to call an unmapped occurrence asserted done', async () => {
      // The service can never produce this pair, but the service is not the
      // only possible writer. The CHECK is what makes it impossible — and it
      // has to hold at INSERT, because occurrences are append-only and there
      // is no UPDATE that could introduce the contradiction later.
      const batchId = await openBatch();
      const created = await service.createWorkItem(
        importRequest(batchId, { historicalStatus: 'frobnicated' }),
        AGENT,
      );
      const identityId = (created.body.identity as { id: string }).id;

      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO public.source_occurrences (
             legacy_identity_id, batch_id, source_root, source_locator, source_key,
             content_digest, captured_at, historical_status, historical_asserted_done,
             status_map_revision, unmapped
           ) VALUES ($1::uuid, $2::uuid, 'datarim/root', 'tasks.md#contradiction',
                     'heading:contradiction', $3, now(), 'frobnicated', true, 2, true)`,
          identityId,
          batchId,
          digestOf('contradiction'),
        ),
      ).rejects.toThrow(/source_occurrences_unmapped_not_asserted_done_check/);
    });

    it('keeps a source receipt append-only once the revision is stamped on it', async () => {
      const batchId = await openBatch();
      const created = await service.createWorkItem(
        importRequest(batchId, { historicalStatus: 'archived' }),
        AGENT,
      );
      const id = (created.body.occurrence as { id: string }).id;
      await expect(
        prisma.sourceOccurrence.update({ where: { id }, data: { statusMapRevision: 99 } }),
      ).rejects.toThrow(/append-only/);
    });

    it('keeps the historical date off the import date', async () => {
      const batchId = await openBatch();
      const historicalAt = '2019-04-02T10:15:00.000Z';
      const before = Date.now();
      const result = await service.createWorkItem(
        importRequest(batchId, {}, { historicalAt }),
        AGENT,
      );

      const workItem = result.body.workItem as { importedAt: string };
      const occurrence = result.body.occurrence as { historicalAt: string };
      expect(occurrence.historicalAt).toBe(historicalAt);
      // The new execution's start date did NOT replace the historical date.
      expect(new Date(workItem.importedAt).getTime()).toBeGreaterThanOrEqual(before);
      expect(workItem.importedAt).not.toBe(historicalAt);
    });

    it('refuses a source key that is only a line number', async () => {
      // The service layer trusts the DTO; the database refuses regardless of
      // which writer got there. This asserts the durable half.
      const batchId = await openBatch();
      const identity = (
        await service.createWorkItem(importRequest(batchId), AGENT)
      ).body.identity as { id: string };
      await expect(
        prisma.sourceOccurrence.create({
          data: {
            legacyIdentityId: identity.id,
            batchId,
            sourceRoot: 'datarim/root',
            sourceLocator: 'tasks.md',
            sourceKey: '417',
            contentDigest: digestOf('anonymous'),
            capturedAt: new Date(),
            historicalStatus: 'todo',
          },
        }),
      ).rejects.toThrow();
    });

    it('keeps recorded receipts append-only', async () => {
      const batchId = await openBatch();
      const occurrence = (
        await service.createWorkItem(importRequest(batchId), AGENT)
      ).body.occurrence as { id: string };
      // Assert the guard's own SQLSTATE rather than "something threw": a bare
      // toThrow() would pass on any incidental failure and prove nothing.
      await expect(
        prisma.sourceOccurrence.update({
          where: { id: occurrence.id },
          data: { historicalStatus: 'rewritten' },
        }),
      ).rejects.toThrow(/append-only/i);
      await expect(
        prisma.sourceOccurrence.delete({ where: { id: occurrence.id } }),
      ).rejects.toThrow(/append-only/i);
      expect(
        (await prisma.sourceOccurrence.findUnique({ where: { id: occurrence.id } }))
          .historicalStatus,
      ).not.toBe('rewritten');
    });
  });

  // -------------------------------------------------------------------------
  // AUP-DAT-003 — idempotency, readback, CAS, bootstrap stamp
  // -------------------------------------------------------------------------

  describe('minimal Muneral path', () => {
    it('replays an import for a repeated idempotency key without duplicating', async () => {
      const batchId = await openBatch();
      const request = importRequest(batchId);

      const first = await service.createWorkItem(request, AGENT);
      const second = await service.createWorkItem(request, AGENT);

      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.body).toEqual(first.body);
      expect(
        await prisma.legacyIdentity.count({
          where: { sourceNamespace: request.sourceNamespace, legacyId: request.legacyId },
        }),
      ).toBe(1);
      expect(
        await prisma.sourceOccurrence.count({
          where: { legacyIdentityId: (first.body.identity as { id: string }).id },
        }),
      ).toBe(1);
    });

    it('treats an identical receipt under a new key as the same sighting', async () => {
      // The path that never ran before: an exact repeat of a receipt that is
      // NOT short-circuited by the replay store, because the importer
      // regenerated its idempotency key. It must collapse onto the existing
      // occurrence, not 500 on the unique constraint.
      const batchId = await openBatch();
      const request = importRequest(batchId);
      const first = await service.createWorkItem(request, AGENT);
      const again = await service.createWorkItem(
        { ...request, idempotencyKey: `idem-${randomUUID()}` },
        AGENT,
      );

      expect(again.replayed).toBe(false);
      expect(again.body.occurrence).toEqual(first.body.occurrence);
      expect(
        await prisma.sourceOccurrence.count({
          where: { legacyIdentityId: (first.body.identity as { id: string }).id },
        }),
      ).toBe(1);
    });

    it('rejects a reused idempotency key carrying a different payload', async () => {
      const batchId = await openBatch();
      const request = importRequest(batchId);
      await service.createWorkItem(request, AGENT);
      await expect(
        service.createWorkItem({ ...request, title: 'Something else' }, AGENT),
      ).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_CONFLICT' } });
    });

    it('answers a lost response by readback on the legacy id', async () => {
      const batchId = await openBatch();
      const request = importRequest(batchId, {}, { historicalAt: '2020-01-02T03:04:05.000Z' });

      // The client creates the work item and then loses the response entirely.
      const created = await service.createWorkItem(request, AGENT);
      const lost = created.body;

      const readback = await service.getWorkItemByLegacy(
        request.sourceNamespace,
        request.legacyId,
      );

      expect(readback.workItem).toEqual(lost.workItem);
      expect(readback.identity).toEqual(lost.identity);
      expect(readback.occurrences).toEqual([lost.occurrence]);
      expect(readback.revision).toBe(0);
    });

    it('reports a typed 404 for an unknown legacy id', async () => {
      await expect(
        service.getWorkItemByLegacy('datarim/root', `MISSING-${randomUUID()}`),
      ).rejects.toMatchObject({ response: { code: 'WORK_ITEM_NOT_FOUND' } });
    });

    it('starts every work item at revision 0 and bumps only via the transition path', async () => {
      const batchId = await openBatch();
      const workItem = (
        await service.createWorkItem(importRequest(batchId, { historicalStatus: 'todo' }), AGENT)
      ).body.workItem as { id: string; revision: number };
      expect(workItem.revision).toBe(0);

      // An ordinary Muneral write does not touch the migration revision.
      await prisma.task.update({
        where: { id: workItem.id },
        data: { title: 'Renamed by an ordinary writer' },
      });
      expect((await prisma.task.findUnique({ where: { id: workItem.id } })).revision).toBe(0);

      await service.transition(
        workItem.id,
        {
          expectedRevision: 0,
          toStatus: 'in_progress',
          idempotencyKey: `t-${randomUUID()}`,
          basis: 'migration re-execution begins',
        },
        AGENT,
      );
      expect((await prisma.task.findUnique({ where: { id: workItem.id } })).revision).toBe(1);
    });

    it('rejects a CAS transition against a stale revision and writes nothing', async () => {
      const batchId = await openBatch();
      const workItem = (
        await service.createWorkItem(importRequest(batchId, { historicalStatus: 'todo' }), AGENT)
      ).body.workItem as { id: string };

      await service.transition(
        workItem.id,
        {
          expectedRevision: 0,
          toStatus: 'in_progress',
          idempotencyKey: `t-${randomUUID()}`,
          basis: 'first move',
        },
        AGENT,
      );

      const activityBefore = await prisma.activityLog.count({ where: { taskId: workItem.id } });
      await expect(
        service.transition(
          workItem.id,
          {
            expectedRevision: 0,
            toStatus: 'review',
            idempotencyKey: `t-${randomUUID()}`,
            basis: 'stale caller',
          },
          AGENT,
        ),
      ).rejects.toMatchObject({ response: { code: 'STALE_REVISION', currentRevision: 1 } });

      const task = await prisma.task.findUnique({ where: { id: workItem.id } });
      expect(task.revision).toBe(1);
      expect(task.status).toBe('in_progress');
      expect(await prisma.activityLog.count({ where: { taskId: workItem.id } })).toBe(
        activityBefore,
      );
    });

    it('lets exactly one of N concurrent CAS transitions win', async () => {
      // The sequential stale case above proves the check; this proves the
      // compare-and-set is genuinely atomic rather than a read-then-write that
      // happens to look right when nothing races it.
      const batchId = await openBatch();
      const workItem = (
        await service.createWorkItem(importRequest(batchId, { historicalStatus: 'todo' }), AGENT)
      ).body.workItem as { id: string };

      const outcomes = await Promise.all(
        [0, 1, 2, 3, 4, 5].map(async () => {
          try {
            await service.transition(
              workItem.id,
              {
                expectedRevision: 0,
                toStatus: 'in_progress',
                idempotencyKey: `t-${randomUUID()}`,
                basis: 'racing caller',
              },
              AGENT,
            );
            return 'won';
          } catch (err) {
            return (err as { response?: { code?: string } }).response?.code ?? 'threw';
          }
        }),
      );

      expect(outcomes.filter((o) => o === 'won')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'STALE_REVISION')).toHaveLength(5);
      expect((await prisma.task.findUnique({ where: { id: workItem.id } })).revision).toBe(1);
      expect(
        await prisma.activityLog.count({
          where: { taskId: workItem.id, action: 'migration.transition' },
        }),
      ).toBe(1);
    });

    it('answers N concurrent deliveries of ONE keyed command identically', async () => {
      // At-least-once delivery of a single command. Every delivery carries the
      // same key, so every delivery must get the same answer — not one success
      // and N-1 spurious STALE_REVISION telling a caller to retry work that
      // already landed.
      const batchId = await openBatch();
      const workItem = (
        await service.createWorkItem(importRequest(batchId, { historicalStatus: 'todo' }), AGENT)
      ).body.workItem as { id: string };

      const command = {
        expectedRevision: 0,
        toStatus: 'in_progress' as const,
        idempotencyKey: `t-${randomUUID()}`,
        basis: 'delivered four times',
      };
      const bodies = await Promise.all(
        [0, 1, 2, 3].map(() => service.transition(workItem.id, command, AGENT)),
      );

      for (const b of bodies) expect(b.body).toEqual(bodies[0].body);
      expect(bodies.filter((b) => !b.replayed)).toHaveLength(1);
      expect((await prisma.task.findUnique({ where: { id: workItem.id } })).revision).toBe(1);
      expect(
        await prisma.activityLog.count({
          where: { taskId: workItem.id, action: 'migration.transition' },
        }),
      ).toBe(1);
    });

    it('answers N concurrent imports under ONE key with one write', async () => {
      const batchId = await openBatch();
      const request = importRequest(batchId);
      const results = await Promise.all(
        [0, 1, 2].map(() => service.createWorkItem(request, AGENT)),
      );
      for (const r of results) expect(r.body).toEqual(results[0].body);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(
        await prisma.sourceOccurrence.count({
          where: { batchId, sourceLocator: request.occurrence.sourceLocator },
        }),
      ).toBe(1);
    });

    it('refuses to overwrite a status an ordinary writer moved', async () => {
      // tasks.revision is bumped by this path alone, so an ordinary
      // PATCH /tasks/:id/status moves the status and leaves the counter where
      // it was. Nothing about the revision would reveal the operator's
      // decision; only reading the status does.
      const batchId = await openBatch();
      const workItem = (
        await service.createWorkItem(importRequest(batchId, { historicalStatus: 'todo' }), AGENT)
      ).body.workItem as { id: string };

      await prisma.task.update({ where: { id: workItem.id }, data: { status: 'cancelled' } });

      await expect(
        service.transition(
          workItem.id,
          {
            expectedRevision: 0,
            toStatus: 'in_progress',
            idempotencyKey: `t-${randomUUID()}`,
            basis: 'unaware of the operator',
          },
          AGENT,
        ),
      ).rejects.toMatchObject({ response: { code: 'INVALID_STATUS_TRANSITION' } });

      const after = await prisma.task.findUnique({ where: { id: workItem.id } });
      expect(after.status).toBe('cancelled');
      expect(after.revision).toBe(0);
    });

    it('puts the status in the CAS predicate, not only the revision', async () => {
      // The test above catches a status change visible at the pre-read. This
      // one covers the window the pre-read cannot see: a status change landing
      // between the read and the write, with the revision untouched. Asserted
      // against the database directly, because that interleaving cannot be
      // timed deterministically through the service.
      const batchId = await openBatch();
      const workItem = (
        await service.createWorkItem(importRequest(batchId, { historicalStatus: 'todo' }), AGENT)
      ).body.workItem as { id: string };

      // The transition read `todo`; an ordinary writer then moved the status
      // and left revision at 0.
      await prisma.task.update({ where: { id: workItem.id }, data: { status: 'in_progress' } });

      const revisionOnly = await prisma.task.updateMany({
        where: { id: workItem.id, revision: 0 },
        data: { status: 'review' },
      });
      expect(revisionOnly.count).toBe(1); // a revision-only guard would have written
      await prisma.task.update({ where: { id: workItem.id }, data: { status: 'in_progress' } });

      const revisionAndStatus = await prisma.task.updateMany({
        where: { id: workItem.id, revision: 0, status: 'todo' },
        data: { status: 'review' },
      });
      expect(revisionAndStatus.count).toBe(0); // the guard the service actually uses
      expect((await prisma.task.findUnique({ where: { id: workItem.id } })).status).toBe(
        'in_progress',
      );
    });

    it('replays a transition for a repeated key and bumps the revision once', async () => {
      const batchId = await openBatch();
      const workItem = (
        await service.createWorkItem(importRequest(batchId, { historicalStatus: 'todo' }), AGENT)
      ).body.workItem as { id: string };

      const command = {
        expectedRevision: 0,
        toStatus: 'in_progress' as const,
        idempotencyKey: `t-${randomUUID()}`,
        basis: 'exactly once',
        evidenceRefs: ['artifact://plan/mun-0040'],
      };
      const first = await service.transition(workItem.id, command, AGENT);
      const second = await service.transition(workItem.id, command, AGENT);

      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.body).toEqual(first.body);
      expect((await prisma.task.findUnique({ where: { id: workItem.id } })).revision).toBe(1);
      // One activity entry, one artifact reference set — not two.
      const entries = await prisma.activityLog.findMany({
        where: { taskId: workItem.id, action: 'migration.transition' },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].actorType).toBe('agent');
      expect(entries[0].payload.evidenceRefs).toEqual(['artifact://plan/mun-0040']);
    });

    it('refuses a status move the shared task state machine forbids', async () => {
      const batchId = await openBatch();
      const workItem = (
        await service.createWorkItem(importRequest(batchId, { historicalStatus: 'todo' }), AGENT)
      ).body.workItem as { id: string };

      await expect(
        service.transition(
          workItem.id,
          {
            expectedRevision: 0,
            toStatus: 'done',
            idempotencyKey: `t-${randomUUID()}`,
            basis: 'illegal jump',
          },
          AGENT,
        ),
      ).rejects.toMatchObject({ response: { code: 'INVALID_STATUS_TRANSITION' } });
      expect((await prisma.task.findUnique({ where: { id: workItem.id } })).revision).toBe(0);
    });

    it('rejects a transition on a work item that does not exist', async () => {
      await expect(
        service.transition(
          randomUUID(),
          {
            expectedRevision: 0,
            toStatus: 'in_progress',
            idempotencyKey: `t-${randomUUID()}`,
            basis: 'nothing there',
          },
          AGENT,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    // MIG-003
    it('accepts one bootstrap stamp and refuses every later write to it', async () => {
      const batchId = await openBatch();
      const legacyId = `BOOT-${randomUUID().slice(0, 8)}`;
      const stamp = {
        seedRef: 'kc2://seed/2026-09-05',
        k0Digest: digestOf('k0'),
        identityRevision: 0,
        humanOwner: 'operator@arcanada.one',
        authorizationRefs: ['native://authorization/mun-0040'],
        stampedAt: '2026-09-05T09:00:00.000Z',
        limits: { maxWorkItems: 1419 },
      };

      const first = await service.createWorkItem(
        importRequest(batchId, { legacyId, bootstrapStamp: stamp }),
        AGENT,
      );
      expect((first.body.workItem as { bootstrapStamp: unknown }).bootstrapStamp).toEqual(stamp);

      await expect(
        service.createWorkItem(
          importRequest(
            batchId,
            { legacyId, bootstrapStamp: { ...stamp, humanOwner: 'someone-else' } },
            { sourceLocator: `tasks.md#${legacyId}@v2`, contentDigest: digestOf('v2') },
          ),
          AGENT,
        ),
      ).rejects.toMatchObject({ response: { code: 'BOOTSTRAP_STAMP_IMMUTABLE' } });

      // Even an identical re-stamp is refused: the receipt belongs to the
      // first revision and nothing may write it twice.
      await expect(
        service.createWorkItem(
          importRequest(
            batchId,
            { legacyId, bootstrapStamp: stamp },
            { sourceLocator: `tasks.md#${legacyId}@v3`, contentDigest: digestOf('v3') },
          ),
          AGENT,
        ),
      ).rejects.toMatchObject({ response: { code: 'BOOTSTRAP_STAMP_IMMUTABLE' } });

      const taskId = (first.body.workItem as { id: string }).id;
      // And the database refuses it too, whichever writer tries.
      await expect(
        prisma.task.update({ where: { id: taskId }, data: { bootstrapStamp: { tampered: true } } }),
      ).rejects.toThrow(/write-once/i);
      expect((await prisma.task.findUnique({ where: { id: taskId } })).bootstrapStamp).toEqual(stamp);
    });

    it('refuses an oversized bootstrap stamp with a typed body, not a raw driver error', async () => {
      const batchId = await openBatch();
      await expect(
        service.createWorkItem(
          importRequest(batchId, { bootstrapStamp: { blob: 'x'.repeat(9000) } }),
          AGENT,
        ),
      ).rejects.toMatchObject({ response: { code: 'BOOTSTRAP_STAMP_INVALID' } });
    });

    it('accepts a stamp whose jsonb rendering exceeds the service bound', async () => {
      // The service measures compact canonical JSON; PostgreSQL renders jsonb
      // with a space after every ':' and ','. Equal bounds on the two would
      // leave a window where the service accepted a stamp and the CHECK
      // rejected it as an untyped 500 — precisely what the service-side guard
      // exists to prevent. This builds a stamp inside that window and proves
      // it survives, i.e. that the database bound is the looser one.
      const stamp: Record<string, number> = {};
      let i = 0;
      while (JSON.stringify(stamp).length < 7600) stamp[`key${i}`] = i++;
      const compact = JSON.stringify(stamp).length;
      expect(compact).toBeLessThan(8192);

      const batchId = await openBatch();
      const result = await service.createWorkItem(
        importRequest(batchId, { bootstrapStamp: stamp }),
        AGENT,
      );
      const taskId = (result.body.workItem as { id: string }).id;

      const rows = (await prisma.$queryRawUnsafe(
        'SELECT octet_length(bootstrap_stamp::text) AS rendered FROM public.tasks WHERE id = $1::uuid',
        taskId,
      )) as Array<{ rendered: number | bigint }>;
      const row = rows[0];
      // Rendered larger than the service bound: an equal-bounds design would
      // have failed this insert with an untyped constraint violation.
      expect(Number(row.rendered)).toBeGreaterThan(8192);
      expect((result.body.workItem as { bootstrapStamp: unknown }).bootstrapStamp).toEqual(stamp);
    });

    it('bounds the raw excerpt in bytes, so Cyrillic content is not lost to a 500', async () => {
      // 9 000 Cyrillic characters are 18 000 UTF-8 bytes. A character-counted
      // bound would wave them past validation into an untyped constraint
      // failure — and Russian-language Datarim cards are the content this
      // surface exists to import.
      const batchId = await openBatch();
      const excerpt = 'я'.repeat(9000);
      expect(Buffer.byteLength(excerpt, 'utf8')).toBe(18000);
      await expect(
        service.createWorkItem(importRequest(batchId, {}, { rawExcerpt: excerpt }), AGENT),
      ).rejects.toMatchObject({ response: { code: 'RAW_EXCERPT_TOO_LARGE', bytes: 18000 } });

      // Cyrillic well inside the byte bound still imports intact.
      const kept = 'я'.repeat(4000);
      const ok = await service.createWorkItem(
        importRequest(batchId, {}, { rawExcerpt: kept }),
        AGENT,
      );
      expect((ok.body.occurrence as { rawExcerpt: string }).rawExcerpt).toBe(kept);
    });

    it('refuses to add occurrences to a batch whose receipt is already sealed', async () => {
      // The receipt is write-once, so a late occurrence would leave it
      // permanently understating the batch it describes.
      const batchId = await openBatch();
      await service.createWorkItem(importRequest(batchId), AGENT);
      const receipt = (await service.commitBatch(batchId)).receipt as {
        counts: { occurrences: number };
      };
      expect(receipt.counts.occurrences).toBe(1);

      await expect(
        service.createWorkItem(importRequest(batchId), AGENT),
      ).rejects.toMatchObject({ response: { code: 'BATCH_NOT_OPEN', status: 'committed' } });
      expect(await prisma.sourceOccurrence.count({ where: { batchId } })).toBe(1);
    });

    it('rejects a decision that names the subject as its own target', async () => {
      const batchId = await openBatch();
      const subject = (
        await service.createWorkItem(importRequest(batchId), AGENT)
      ).body.identity as { id: string };
      await expect(
        service.decide(
          subject.id,
          { kind: 'same', targets: [subject.id], basis: 'self', expectedMappingRevision: 0 },
          AGENT,
        ),
      ).rejects.toMatchObject({ response: { code: 'INVALID_IDENTITY_DECISION' } });
      expect(
        (await prisma.legacyIdentity.findUnique({ where: { id: subject.id } })).mappingRevision,
      ).toBe(0);
    });

    it('lets an unstamped identity gain a stamp on a later import', async () => {
      // The stamp is write-ONCE, not create-only: the first bootstrap operation
      // may legitimately arrive after the identity already exists.
      const batchId = await openBatch();
      const legacyId = `BOOT2-${randomUUID().slice(0, 8)}`;
      await service.createWorkItem(importRequest(batchId, { legacyId }), AGENT);
      const stamp = { seedRef: 'kc2://seed/late', humanOwner: 'operator@arcanada.one' };
      const stamped = await service.createWorkItem(
        importRequest(
          batchId,
          { legacyId, bootstrapStamp: stamp },
          { sourceLocator: `tasks.md#${legacyId}@v2`, contentDigest: digestOf('late') },
        ),
        AGENT,
      );
      expect((stamped.body.workItem as { bootstrapStamp: unknown }).bootstrapStamp).toEqual(stamp);
    });

    it('survives deletion of the transient replay spool', async () => {
      // AUP-DAT-003: "Evidence survives deletion of the local transient spool."
      // The idempotency records are a bounded transport aid; the receipts are
      // the durable evidence. Dropping the spool must lose nothing that matters.
      const batchId = await openBatch();
      const request = importRequest(batchId);
      const created = await service.createWorkItem(request, AGENT);

      await prisma.migrationIdempotencyRecord.deleteMany({});

      const readback = await service.getWorkItemByLegacy(
        request.sourceNamespace,
        request.legacyId,
      );
      expect(readback.occurrences).toEqual([created.body.occurrence]);
      expect(readback.workItem).toEqual(created.body.workItem);
    });
  });

  it('exposes every documented error code as a typed body', async () => {
    // Exhaustive against MIGRATION_ERROR_CODES itself, not against a
    // hand-copied subset: a code added to the union and never wired to a real
    // failure fails this test instead of quietly shipping.
    const seen = new Set<string>();
    const collect = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        const body = (err as { response?: { code?: string } }).response;
        if (body?.code) seen.add(body.code);
      }
    };

    const batchId = await openBatch();
    const todoItem = importRequest(batchId, { historicalStatus: 'todo' });
    const created = await service.createWorkItem(todoItem, AGENT);
    const workItem = created.body.workItem as { id: string };
    const identity = created.body.identity as { id: string };
    const stamped = importRequest(batchId, {
      bootstrapStamp: { seedRef: 'kc2://seed' },
    });
    await service.createWorkItem(stamped, AGENT);

    // BATCH_KEY_CONFLICT
    const batchKey = `batch-${randomUUID()}`;
    await service.createBatch({ batchKey, sourceSetEpoch: 'e1', producer: 'p', projectId });
    await collect(() =>
      service.createBatch({ batchKey, sourceSetEpoch: 'e2', producer: 'p', projectId }),
    );
    // BATCH_NOT_FOUND
    await collect(() => service.getBatch(randomUUID()));
    // BATCH_NOT_OPEN
    const sealed = await openBatch();
    await service.createWorkItem(importRequest(sealed), AGENT);
    await service.commitBatch(sealed);
    await collect(() => service.createWorkItem(importRequest(sealed), AGENT));
    // BOOTSTRAP_STAMP_IMMUTABLE
    await collect(() =>
      service.createWorkItem(
        {
          ...stamped,
          idempotencyKey: `idem-${randomUUID()}`,
          bootstrapStamp: { seedRef: 'kc2://other' },
          occurrence: { ...stamped.occurrence, contentDigest: digestOf('other') },
        },
        AGENT,
      ),
    );
    // BOOTSTRAP_STAMP_INVALID
    await collect(() =>
      service.createWorkItem(
        importRequest(batchId, { bootstrapStamp: { blob: 'x'.repeat(9000) } }),
        AGENT,
      ),
    );
    // IDEMPOTENCY_KEY_CONFLICT
    await collect(() => service.createWorkItem({ ...todoItem, title: 'changed' }, AGENT));
    // IDENTITY_NOT_FOUND
    await collect(() => service.getReverseMapping(randomUUID()));
    // INVALID_IDENTITY_DECISION
    await collect(() =>
      service.decide(
        identity.id,
        { kind: 'same', targets: [identity.id], basis: 'self', expectedMappingRevision: 0 },
        AGENT,
      ),
    );
    // INVALID_STATUS_TRANSITION
    await collect(() =>
      service.transition(
        workItem.id,
        {
          expectedRevision: 0,
          toStatus: 'done',
          idempotencyKey: `t-${randomUUID()}`,
          basis: 'illegal',
        },
        AGENT,
      ),
    );
    // MAPPING_REVISION_STALE
    await collect(() =>
      service.decide(
        identity.id,
        { kind: 'same', targets: [randomUUID()], basis: 'x', expectedMappingRevision: 9 },
        AGENT,
      ),
    );
    // PROJECT_NOT_FOUND
    await collect(() =>
      service.createBatch({
        batchKey: `b-${randomUUID()}`,
        sourceSetEpoch: 'e',
        producer: 'p',
        projectId: randomUUID(),
      }),
    );
    // RAW_EXCERPT_TOO_LARGE
    await collect(() =>
      service.createWorkItem(
        importRequest(batchId, {}, { rawExcerpt: 'я'.repeat(9000) }),
        AGENT,
      ),
    );
    // STALE_REVISION
    await collect(() =>
      service.transition(
        workItem.id,
        {
          expectedRevision: 99,
          toStatus: 'in_progress',
          idempotencyKey: `t-${randomUUID()}`,
          basis: 'stale',
        },
        AGENT,
      ),
    );
    // WORK_ITEM_NOT_FOUND
    await collect(() => service.getWorkItemByLegacy('nowhere', 'NOPE-1'));

    expect([...seen].sort()).toEqual([...MIGRATION_ERROR_CODES].sort());
  });

  it('uses NestJS exception types the global filter already understands', async () => {
    const batchId = await openBatch();
    const workItem = (
      await service.createWorkItem(importRequest(batchId, { historicalStatus: 'todo' }), AGENT)
    ).body.workItem as { id: string };

    await expect(
      service.transition(
        workItem.id,
        {
          expectedRevision: 7,
          toStatus: 'in_progress',
          idempotencyKey: `t-${randomUUID()}`,
          basis: 'stale',
        },
        AGENT,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.transition(
        workItem.id,
        {
          expectedRevision: 0,
          toStatus: 'done',
          idempotencyKey: `t-${randomUUID()}`,
          basis: 'illegal',
        },
        AGENT,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
