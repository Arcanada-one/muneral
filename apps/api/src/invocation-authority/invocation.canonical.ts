import { canonicalJsonV1 } from '../execution-authority/canonical-json-v1';
import { cardDigest, projectionDigest } from '../result-authority/result-authority.canonical';
import type { AssemblyArtifactV0 } from '../assembly/assembly.types';
import {
  NATIVE_FIXTURE_OPERATION,
  type IssuedTaskInvocationV0,
  type TaskCardProjectionV0,
  type TaskCardV0,
} from './invocation.types';

export interface TaskCardBridgeInputV0 {
  readonly taskId: string;
  readonly attemptId: string;
  readonly nodeId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly assemblyArtifact: AssemblyArtifactV0;
}

/**
 * The single Muneral-owned bridge from a compiled Assembly artifact to the
 * Task Card integrity domains consumed by Supervisor and Agent Arcana.
 */
export function createTaskCardInvocation(
  input: TaskCardBridgeInputV0,
): IssuedTaskInvocationV0 {
  const artifact = input.assemblyArtifact;
  if (artifact.taskId !== input.taskId) {
    throw new Error('Assembly artifact taskId does not match the issued task');
  }

  const cardId = `card:${artifact.artifactId}`;
  const taskCard: TaskCardV0 = {
    schemaVersion: 'v0',
    kind: 'task-card-v0',
    taskId: input.taskId,
    attemptId: input.attemptId,
    cardId,
    assemblyArtifactId: artifact.artifactId,
    invocationId: artifact.preparedInvocation.invocationId,
    nodeId: input.nodeId,
    tenantId: input.tenantId,
    principalId: input.principalId,
    operation: NATIVE_FIXTURE_OPERATION,
  };
  const projection: TaskCardProjectionV0 = {
    schemaVersion: 'v0',
    kind: 'task-card-projection-v0',
    taskId: input.taskId,
    attemptId: input.attemptId,
    cardId,
    invocationId: artifact.preparedInvocation.invocationId,
    nodeId: input.nodeId,
    tenantId: input.tenantId,
    principalId: input.principalId,
    operation: NATIVE_FIXTURE_OPERATION,
    targetRole: artifact.preparedInvocation.targetRole,
    input: {
      kind: 'canonical-prompt-v0',
      canonicalPrompt: artifact.preparedInvocation.canonicalPrompt,
    },
  };
  const taskCardCanonicalBytes = canonicalJsonV1(taskCard);
  const projectionCanonicalBytes = canonicalJsonV1(projection);

  return Object.freeze({
    schemaVersion: 'v0' as const,
    kind: 'issued-task-invocation-v0' as const,
    taskCard: Object.freeze(taskCard),
    taskCardCanonicalBytes,
    taskCardDigest: cardDigest(taskCard),
    projection: Object.freeze(projection),
    projectionCanonicalBytes,
    projectionDigest: projectionDigest(projection),
    assemblyArtifact: artifact,
  });
}
