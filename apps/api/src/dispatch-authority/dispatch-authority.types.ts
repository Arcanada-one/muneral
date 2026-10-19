import type { TaskStatus } from '@muneral/types';

export type DispatchState = 'reserved' | 'bound' | 'consumed' | 'revoked';

export interface DispatchIdentitySource {
  generate(): string;
}

export interface TerminalBindingRequest {
  readonly taskId: string;
  readonly launchAttemptId: string;
  readonly dispatchId: string;
  readonly actor: DispatchPrincipal;
  readonly terminalDeclarationId: string;
  readonly executionContextBytes: Uint8Array;
  readonly executionContextSha256: string;
}

/** A value returned only by a configured terminal authority adapter.
 * The application default has no adapter and refuses every binding request.
 * A local test implementation is a model, never Orca/runtime evidence.
 */
export interface VerifiedTerminalDeclaration {
  readonly terminalDeclarationId: string;
  readonly terminalDeclarationSha256: string;
  readonly executionContextSha256: string;
  readonly authorityRef: string;
}

export interface TerminalDeclarationAuthority {
  verifyBinding(request: TerminalBindingRequest): Promise<VerifiedTerminalDeclaration>;
}

export interface IssueDispatchRequest {
  readonly expectedTaskRevision: number;
  readonly expectedTaskStatus: TaskStatus;
  readonly expectedTaskUpdatedAt: string;
  readonly idempotencyKey: string;
  readonly request: Record<string, unknown>;
  readonly executionContext: Record<string, unknown>;
}

export interface DispatchPrincipal {
  readonly type: 'human' | 'agent';
  readonly id: string;
  readonly workspaceId?: string;
}

export interface PublicDispatchReservation {
  readonly taskId: string;
  readonly projectId: string;
  readonly launchAttemptId: string;
  readonly dispatchId: string;
  readonly actorType: 'human' | 'agent';
  readonly actorId: string;
  readonly expectedTaskRevision: number;
  readonly expectedTaskStatus: string;
  readonly expectedTaskUpdatedAt: string;
  readonly requestSha256: string;
  readonly executionContextSha256: string;
  readonly state: DispatchState;
  readonly terminalDeclarationId: string | null;
  readonly terminalDeclarationSha256: string | null;
  readonly terminalContextSha256: string | null;
  readonly createdAt: string;
  readonly boundAt: string | null;
  readonly consumedAt: string | null;
  readonly revokedAt: string | null;
  readonly idempotent: boolean;
}
