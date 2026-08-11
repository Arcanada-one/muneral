import type { AssemblyArtifactV0, AssemblyRequestV0 } from '../assembly/assembly.types';

export const NATIVE_FIXTURE_OPERATION = 'native.fixture.digest-v0' as const;

export interface TaskCardV0 {
  readonly schemaVersion: 'v0';
  readonly kind: 'task-card-v0';
  readonly taskId: string;
  readonly attemptId: string;
  readonly cardId: string;
  readonly assemblyArtifactId: string;
  readonly invocationId: string;
  readonly nodeId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly operation: typeof NATIVE_FIXTURE_OPERATION;
}

export interface TaskCardProjectionV0 {
  readonly schemaVersion: 'v0';
  readonly kind: 'task-card-projection-v0';
  readonly taskId: string;
  readonly attemptId: string;
  readonly cardId: string;
  readonly invocationId: string;
  readonly nodeId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly operation: typeof NATIVE_FIXTURE_OPERATION;
  readonly targetRole: string;
  readonly input: {
    readonly kind: 'canonical-prompt-v0';
    readonly canonicalPrompt: string;
  };
}

export interface IssuedTaskInvocationV0 {
  readonly schemaVersion: 'v0';
  readonly kind: 'issued-task-invocation-v0';
  readonly taskCard: TaskCardV0;
  readonly taskCardCanonicalBytes: string;
  readonly taskCardDigest: string;
  readonly projection: TaskCardProjectionV0;
  readonly projectionCanonicalBytes: string;
  readonly projectionDigest: string;
  readonly assemblyArtifact: AssemblyArtifactV0;
}

export interface IssueTaskInvocationRequestV0 {
  readonly schemaVersion: 'v0';
  readonly taskId: string;
  readonly attemptId: string;
  readonly nodeId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly operation: typeof NATIVE_FIXTURE_OPERATION;
  readonly assemblyRequest: AssemblyRequestV0;
}

/** Immutable tuple Supervisor is allowed to compare and opaque-route. */
export interface IssuedTaskRouteAuthorityV0 {
  readonly schemaVersion: 'v0';
  readonly kind: 'issued-task-route-authority-v0';
  readonly tenantId: string;
  readonly principalId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly invocationId: string;
  readonly taskCardDigest: string;
  readonly nodeId: string;
  readonly projectionId: string;
  readonly projectionCapabilityDigest: string;
  readonly projectionCanonicalBytes: string;
}

export class InvocationAuthorityError extends Error {
  constructor(
    readonly subject: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Invocation authority refused ${subject}: expected ${expected}, got ${actual}`);
    this.name = 'InvocationAuthorityError';
  }
}
