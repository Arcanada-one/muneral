import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AssemblyRequestV0 } from '../src/assembly/assembly.types';
import { compileAssembly } from '../src/assembly/assembly.compiler';
import { createTaskCardInvocation } from '../src/invocation-authority/invocation.canonical';
import { InvocationAuthorityService } from '../src/invocation-authority/invocation.service';
import {
  InvocationAuthorityError,
  NATIVE_FIXTURE_OPERATION,
} from '../src/invocation-authority/invocation.types';
import type { TransactionalClient } from '../src/execution-authority/execution-authority.service';

const fixture = JSON.parse(
  readFileSync(
    join(__dirname, 'assembly', 'fixtures', 'positive', 'minimal-request.json'),
    'utf8',
  ),
) as { input: AssemblyRequestV0 };

const TASK_ID = fixture.input.taskId;
const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const NODE_ID = 'result:summary';
const TENANT_ID = fixture.input.requestedAuthority.tenant;
const PRINCIPAL_ID = 'agent-arcana:native-fixture';

function compiledInvocation() {
  const compiled = compileAssembly(fixture.input);
  if (!compiled.ok) throw new Error(compiled.error.message);
  return createTaskCardInvocation({
    taskId: TASK_ID,
    attemptId: ATTEMPT_ID,
    nodeId: NODE_ID,
    tenantId: TENANT_ID,
    principalId: PRINCIPAL_ID,
    assemblyArtifact: compiled.artifact,
  });
}

function makePrisma(existing: Record<string, unknown> | null = null) {
  const tx = {
    taskExecutionState: {
      findUnique: jest.fn().mockResolvedValue({ currentAttemptId: ATTEMPT_ID }),
    },
    taskExecutionAttempt: {
      findUnique: jest.fn().mockResolvedValue({ attemptId: ATTEMPT_ID, taskId: TASK_ID }),
    },
    taskResultBinding: {
      findUnique: jest.fn().mockResolvedValue(existing),
      create: jest.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (value: typeof tx) => unknown) => fn(tx)),
  } as unknown as TransactionalClient;
  return { prisma, tx };
}

describe('Muneral-owned issued Task Card invocation', () => {
  it('bridges the Assembly artifact into two distinct domain-separated integrity domains', () => {
    const issued = compiledInvocation();

    expect(issued.taskCardDigest).toBe(
      'd3c0e720f81ae3a8bab8ca9e58a803d1e6153ca7a19c3e8089ad2a4369090576',
    );
    expect(issued.projectionDigest).toBe(
      'fdb1b6e0a8c4dab8509418af487bd50faa44d45ab83dee5f4999b9494f97259f',
    );
    expect(issued.taskCardDigest).not.toBe(issued.projectionDigest);
    expect(issued.taskCardDigest).not.toBe(issued.assemblyArtifact.digest);
    expect(issued.projectionDigest).not.toBe(issued.assemblyArtifact.digest);
    expect(JSON.parse(issued.taskCardCanonicalBytes)).toEqual(issued.taskCard);
    expect(JSON.parse(issued.projectionCanonicalBytes)).toEqual(issued.projection);
  });

  it('issues the exact node/principal/tenant binding through one typed transaction', async () => {
    const { prisma, tx } = makePrisma();
    const service = new InvocationAuthorityService({
      now: () => new Date('2026-08-08T00:00:00.000Z'),
    });
    const outcome = await service.issue(prisma, {
      schemaVersion: 'v0',
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      nodeId: NODE_ID,
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      operation: NATIVE_FIXTURE_OPERATION,
      assemblyRequest: fixture.input,
    });

    expect(outcome).not.toBeInstanceOf(Error);
    expect(tx.taskResultBinding.create).toHaveBeenCalledTimes(1);
    expect(tx.taskResultBinding.create.mock.calls[0][0].data).toMatchObject({
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      nodeId: NODE_ID,
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      operation: NATIVE_FIXTURE_OPERATION,
    });
  });

  it('refuses issuance against a non-current attempt with zero binding writes', async () => {
    const { prisma, tx } = makePrisma();
    tx.taskExecutionState.findUnique.mockResolvedValue({
      currentAttemptId: '33333333-3333-4333-8333-333333333333',
    });
    const service = new InvocationAuthorityService({ now: () => new Date() });
    const outcome = await service.issue(prisma, {
      schemaVersion: 'v0',
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      nodeId: NODE_ID,
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      operation: NATIVE_FIXTURE_OPERATION,
      assemblyRequest: fixture.input,
    });

    expect(outcome).toBeInstanceOf(InvocationAuthorityError);
    expect(tx.taskResultBinding.create).not.toHaveBeenCalled();
  });

  it('reads back the exact immutable route tuple and verifies stored canonical digests', async () => {
    const issued = compiledInvocation();
    const service = new InvocationAuthorityService({ now: () => new Date() });
    const prisma = {
      taskResultBinding: {
        findUnique: jest.fn().mockResolvedValue({
          taskId: TASK_ID,
          attemptId: ATTEMPT_ID,
          cardId: issued.taskCard.cardId,
          invocationId: issued.taskCard.invocationId,
          cardDigest: issued.taskCardDigest,
          projectionId: issued.taskCard.invocationId,
          projectionDigest: issued.projectionDigest,
          nodeId: NODE_ID,
          tenantId: TENANT_ID,
          principalId: PRINCIPAL_ID,
          cardCanonicalBytes: issued.taskCardCanonicalBytes,
          projectionCanonicalBytes: issued.projectionCanonicalBytes,
        }),
      },
    } as unknown as TransactionalClient;

    const route = await service.readRouteAuthority(
      prisma,
      issued.taskCard.invocationId,
    );
    expect(route).toEqual({
      schemaVersion: 'v0',
      kind: 'issued-task-route-authority-v0',
      tenantId: TENANT_ID,
      principalId: PRINCIPAL_ID,
      taskId: TASK_ID,
      attemptId: ATTEMPT_ID,
      invocationId: issued.taskCard.invocationId,
      taskCardDigest: issued.taskCardDigest,
      nodeId: NODE_ID,
      projectionId: issued.taskCard.invocationId,
      projectionCapabilityDigest: issued.projectionDigest,
      projectionCanonicalBytes: issued.projectionCanonicalBytes,
    });
  });

  it('fails closed when stored projection bytes do not match the issued digest', async () => {
    const issued = compiledInvocation();
    const service = new InvocationAuthorityService({ now: () => new Date() });
    const prisma = {
      taskResultBinding: {
        findUnique: jest.fn().mockResolvedValue({
          cardDigest: issued.taskCardDigest,
          projectionDigest: issued.projectionDigest,
          cardCanonicalBytes: issued.taskCardCanonicalBytes,
          projectionCanonicalBytes: '{}',
        }),
      },
    } as unknown as TransactionalClient;
    const route = await service.readRouteAuthority(
      prisma,
      issued.taskCard.invocationId,
    );
    expect(route).toBeInstanceOf(InvocationAuthorityError);
    expect((route as InvocationAuthorityError).subject).toBe('projectionDigest');
  });
});
