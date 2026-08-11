import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AssemblyRequestV0 } from '../src/assembly/assembly.types';
import { ExecutionAuthorityService } from '../src/execution-authority/execution-authority.service';
import type { Clock, IdSource } from '../src/execution-authority/execution-authority.types';
import { InvocationAuthorityService } from '../src/invocation-authority/invocation.service';
import {
  NATIVE_FIXTURE_OPERATION,
} from '../src/invocation-authority/invocation.types';
import { ResultAuthorityService } from '../src/result-authority/result-authority.service';
import { ResultBindingError } from '../src/result-authority/result-authority.errors';
import { createDisposablePostgres } from './support/disposable-postgres';

const fixture = JSON.parse(
  readFileSync(
    join(__dirname, 'assembly', 'fixtures', 'positive', 'minimal-request.json'),
    'utf8',
  ),
) as { input: AssemblyRequestV0 };

const pg = createDisposablePostgres('invocation-authority');

beforeAll(async () => pg.start(), 120_000);
afterAll(async () => pg.stop(), 30_000);

describe('Issued Task Card invocation — PostgreSQL proof', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  const clock: Clock = { now: () => new Date('2026-08-08T00:00:00.000Z') };
  const idSource: IdSource = { generate: () => randomUUID() };
  const execution = new ExecutionAuthorityService(clock, idSource);
  const invocationAuthority = new InvocationAuthorityService(clock);
  const resultAuthority = new ResultAuthorityService(clock, idSource, execution);

  beforeAll(async () => {
    const { PrismaClient } = require('@prisma/client');
    const { PrismaPg } = require('@prisma/adapter-pg');
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: pg.url() }) });
  });

  afterAll(async () => prisma?.$disconnect());

  it('issues authority without raw binding insertion and commits only the bound node', async () => {
    const ownerId = randomUUID();
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const taskId = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.users (id, name, created_at, updated_at)
       VALUES ($1, 'invocation-user', NOW(), NOW())`,
      ownerId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.workspaces (id, slug, name, owner_id, created_at)
       VALUES ($1, $2, 'invocation-ws', $3, NOW())`,
      workspaceId,
      `ws-${randomUUID().slice(0, 6)}`,
      ownerId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.projects (id, workspace_id, slug, name, created_at)
       VALUES ($1, $2, $3, 'invocation-project', NOW())`,
      projectId,
      workspaceId,
      `prj-${randomUUID().slice(0, 6)}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO public.tasks (id, project_id, title, status, created_at, updated_at)
       VALUES ($1, $2, 'invocation-task', 'todo', NOW(), NOW())`,
      taskId,
      projectId,
    );
    const issuedAttempt = await execution.executeCommand(prisma, {
      kind: 'issue_initial_attempt',
      taskId,
      expectedVersion: 0,
      idempotencyKey: 'issue-cross-plane',
      causationId: 'cause-cross-plane',
      correlationId: 'corr-cross-plane',
      retryBudget: 0,
      retryBackoffMs: 1_000,
      evidenceRefs: [],
    });
    if (issuedAttempt instanceof Error) throw issuedAttempt;
    const attemptId = issuedAttempt.state.currentAttemptId;
    if (!attemptId) throw new Error('initial attempt was not issued');
    const started = await execution.executeCommand(prisma, {
      kind: 'transition_attempt',
      taskId,
      attemptId,
      expectedVersion: 1,
      eventType: 'attempt:started',
      idempotencyKey: 'start-cross-plane',
      causationId: 'cause-cross-plane',
      correlationId: 'corr-cross-plane',
      evidenceRefs: [],
      payload: {},
      committedResult: {},
    });
    if (started instanceof Error) throw started;

    const issuance = await invocationAuthority.issue(prisma, {
      schemaVersion: 'v0',
      taskId,
      attemptId,
      nodeId: 'result:summary',
      tenantId: 'acme',
      principalId: 'agent-arcana:native-fixture',
      operation: NATIVE_FIXTURE_OPERATION,
      assemblyRequest: { ...fixture.input, taskId },
    });
    if (issuance instanceof Error) throw issuance;
    const route = await invocationAuthority.readRouteAuthority(
      prisma,
      issuance.invocation.taskCard.invocationId,
    );
    if (route instanceof Error) throw route;
    expect(route).toMatchObject({
      tenantId: 'acme',
      principalId: 'agent-arcana:native-fixture',
      taskId,
      attemptId,
      invocationId: issuance.invocation.taskCard.invocationId,
      taskCardDigest: issuance.invocation.taskCardDigest,
      nodeId: 'result:summary',
      projectionCapabilityDigest: issuance.invocation.projectionDigest,
    });

    const committed = await resultAuthority.commitOwnedResult(prisma, {
      schemaVersion: 'v0',
      kind: 'owned-result-mutation',
      mutationId: 'mutation-cross-plane',
      taskId,
      attemptId,
      cardId: issuance.invocation.taskCard.cardId,
      cardDigest: issuance.invocation.taskCardDigest,
      projectionId: issuance.invocation.taskCard.invocationId,
      projectionDigest: issuance.invocation.projectionDigest,
      nodeId: 'result:summary',
      expectedNodeVersion: 0,
      principalId: 'agent-arcana:native-fixture',
      resultNode: {
        nodeId: 'result:summary',
        kind: 'task-card-result-node',
        value: { digest: 'a'.repeat(64) },
      },
      idempotencyKey: 'commit-cross-plane',
      causationId: 'cause-cross-plane',
      correlationId: 'corr-cross-plane',
    });
    if (committed instanceof Error) throw committed;

    expect(issuance.replayed).toBe(false);
    expect(committed.resultRef.nodeId).toBe('result:summary');
    expect(committed.receipt.resultRef.resultRefId).toBe(committed.resultRef.resultRefId);
    expect(await prisma.taskResultBinding.count({ where: { taskId } })).toBe(1);
    expect(await prisma.taskResultNode.count({ where: { taskId } })).toBe(1);

    const wrongNode = await resultAuthority.commitOwnedResult(prisma, {
      schemaVersion: 'v0',
      kind: 'owned-result-mutation',
      mutationId: 'mutation-wrong-node',
      taskId,
      attemptId,
      cardId: issuance.invocation.taskCard.cardId,
      cardDigest: issuance.invocation.taskCardDigest,
      projectionId: issuance.invocation.taskCard.invocationId,
      projectionDigest: issuance.invocation.projectionDigest,
      nodeId: 'result:forged',
      expectedNodeVersion: 0,
      principalId: 'agent-arcana:native-fixture',
      resultNode: {
        nodeId: 'result:forged',
        kind: 'task-card-result-node',
        value: { digest: 'b'.repeat(64) },
      },
      idempotencyKey: 'commit-wrong-node',
      causationId: 'cause-cross-plane',
      correlationId: 'corr-cross-plane',
    });
    expect(wrongNode).toBeInstanceOf(ResultBindingError);
    expect((wrongNode as ResultBindingError).subject).toBe('nodeId');
    expect(await prisma.taskResultNode.count({ where: { taskId } })).toBe(1);
  });
});
