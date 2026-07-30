// MUN-0022: Contract enforcement guards — capability-scoped projection,
// owned-node mutation guard, idempotent receipt submission, wrong-plane
// rejection, and fake adapter factory.
//
// All functions are pure (zero side effects) and type-enforced (level 3).
// The fake adapters demonstrate the contract parity across native, local-CLI,
// remote-tmux-CLI, and in-process API modes.

import type {
  TaskCardV0,
  TaskCardProjectionV0,
  TaskCardNodeV0,
  TaskCardEdgeV0,
  OwnedResultMutationV0,
  CompletionReceiptV0,
  AssemblyErrorV0,
} from './assembly.types';
import { createAssemblyError } from './assembly.errors';

// ---------------------------------------------------------------------------
// FORBIDDEN_FLEET_FIELDS — opaque set without importing Supervisor domain model
// ---------------------------------------------------------------------------

/** Fields that would indicate fleet/process-lifecycle control authority.
 *  Any payload containing these is rejected as WRONG_PLANE_CONTROL.
 *  This is an opaque string set — no Supervisor types are imported. */
export const FORBIDDEN_FLEET_FIELDS: ReadonlySet<string> = new Set([
  'instanceRegistry',
  'fleetCommand',
  'desiredState',
  'rolloutSpec',
  'watchdogConfig',
  'processLifecycle',
  'placementSpec',
  'versionRollout',
  'telemetryAggregation',
  'directCommandRouting',
]);

// ---------------------------------------------------------------------------
// 1. createProjection — capability-scoped view of a Task Card
// ---------------------------------------------------------------------------

/**
 * Create a capability-scoped TaskCardProjectionV0 for a single subagent.
 * The projection contains only the nodes the subagent owns plus the edges
 * that connect those nodes (dependency context). The subagent cannot see
 * or mutate nodes it does not own.
 *
 * @param card — the compiled TaskCardV0
 * @param subagentId — the subagent's identity (must match node.ownedBy)
 * @returns TaskCardProjectionV0 scoped to the subagent's owned nodes
 */
export function createProjection(
  card: TaskCardV0,
  subagentId: string,
): TaskCardProjectionV0 {
  const ownedNodes = card.nodes.filter((n) => n.ownedBy === subagentId);
  const ownedNodeIds = new Set(ownedNodes.map((n) => n.nodeId));

  // Include edges where both endpoints involve owned nodes
  const visibleEdges = card.edges.filter(
    (e) => ownedNodeIds.has(e.from) || ownedNodeIds.has(e.to),
  );

  return {
    projectionId: `proj-${card.cardId}-${subagentId}`,
    cardId: card.cardId,
    cardDigest: card.digest,
    schemaVersion: 'v0',
    ownedNodes,
    visibleEdges,
    authority: card.authority,
    deadline: card.preparedInvocation.constraints.deadline,
    attemptBudget: card.preparedInvocation.constraints.budget,
    provenance: card.provenance,
  };
}

// ---------------------------------------------------------------------------
// 2. guardMutationScope — out-of-scope and cross-node mutation refusal
// ---------------------------------------------------------------------------

/**
 * Check whether a mutation targets a node owned by the subagent.
 * Returns the error if out-of-scope, null if the mutation is allowed.
 *
 * @param projection — the subagent's capability-scoped projection
 * @param mutation — the mutation to validate
 * @param taskId — for error construction
 * @param causationId — for error construction
 * @param correlationId — for error construction
 * @returns null if the mutation is in-scope, AssemblyErrorV0 if out-of-scope
 */
export function guardMutationScope(
  projection: TaskCardProjectionV0,
  mutation: OwnedResultMutationV0,
  taskId: string,
  causationId: string,
  correlationId: string,
): AssemblyErrorV0 | null {
  const ownedNodeIds = new Set(projection.ownedNodes.map((n) => n.nodeId));

  if (!ownedNodeIds.has(mutation.nodeId)) {
    return createAssemblyError(
      'OUT_OF_SCOPE_MUTATION',
      taskId,
      causationId,
      correlationId,
      {
        reason: `mutation targets node "${mutation.nodeId}" which is not owned by this subagent`,
        fieldName: 'nodeId',
        expected: `one of: [${[...ownedNodeIds].join(', ')}]`,
        actual: mutation.nodeId,
      },
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// 3. submitReceipt — duplicate completion and retry idempotency
// ---------------------------------------------------------------------------

export interface ReceiptSubmissionResult {
  readonly accepted: boolean;
  readonly reason: 'accepted' | 'duplicate' | 'invalid_transition';
  readonly error?: AssemblyErrorV0;
}

/**
 * Submit a completion receipt with idempotency enforcement.
 * The same receipt submitted twice is idempotent (second is rejected as duplicate).
 *
 * @param receipt — the completion receipt
 * @param processedReceipts — mutable set of already-processed receipt IDs
 * @param taskId — for error construction
 * @param causationId — for error construction
 * @param correlationId — for error construction
 * @returns ReceiptSubmissionResult indicating acceptance or rejection reason
 */
export function submitReceipt(
  receipt: CompletionReceiptV0,
  processedReceipts: Set<string>,
  taskId: string,
  causationId: string,
  correlationId: string,
): ReceiptSubmissionResult {
  // Idempotency check: same receipt ID already processed
  if (processedReceipts.has(receipt.receiptId)) {
    return {
      accepted: false,
      reason: 'duplicate',
      error: createAssemblyError(
        'DUPLICATE_COMPLETION',
        taskId,
        causationId,
        correlationId,
        {
          reason: `receipt "${receipt.receiptId}" has already been processed`,
          fieldName: 'receiptId',
          actual: receipt.receiptId,
        },
      ),
    };
  }

  // Mark as processed
  processedReceipts.add(receipt.receiptId);

  return { accepted: true, reason: 'accepted' };
}

// ---------------------------------------------------------------------------
// 4. rejectWrongPlane — opaque fleet-control field rejection
// ---------------------------------------------------------------------------

export interface WrongPlaneResult {
  readonly rejected: boolean;
  readonly forbiddenField?: string;
}

/**
 * Reject any payload that contains fleet-control-shaped fields.
 * Uses an opaque string set (FORBIDDEN_FLEET_FIELDS) — does NOT import
 * or depend on any Supervisor domain model, fleet envelope, or lifecycle type.
 *
 * @param payload — the payload to check
 * @returns WrongPlaneResult with rejection status and offending field name
 */
export function rejectWrongPlane(
  payload: Record<string, unknown>,
): WrongPlaneResult {
  for (const field of FORBIDDEN_FLEET_FIELDS) {
    if (field in payload) {
      return { rejected: true, forbiddenField: field };
    }
  }
  return { rejected: false };
}

// ---------------------------------------------------------------------------
// 5. Fake adapter factory — parity across all four adapter modes
// ---------------------------------------------------------------------------

export type AdapterMode = 'native' | 'local-cli' | 'remote-tmux' | 'api';

export interface FakeAdapterResult {
  readonly receipt: CompletionReceiptV0 | null;
  readonly shellInvoked: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

/**
 * A fake adapter conforming to the Agent Arcana adapter contract.
 * All four modes (native, local-cli, remote-tmux, api) use the same
 * projection/mutation/receipt contract.
 *
 * - native: in-process execution, no shell
 * - local-cli: supervised local child process
 * - remote-tmux: tmux-based remote CLI
 * - api: in-process API call, shell is FORBIDDEN
 */
export type FakeAdapter = (
  projection: TaskCardProjectionV0,
  mutation: OwnedResultMutationV0,
) => FakeAdapterResult;

/**
 * Create a fake adapter of the specified mode.
 * All adapters share the same contract but differ in their side-effect
 * profile (shell invocation, exit code capture, timeout behavior).
 *
 * @param mode — one of 'native' | 'local-cli' | 'remote-tmux' | 'api'
 * @returns a FakeAdapter function
 */
export function createFakeAdapter(mode: AdapterMode): FakeAdapter {
  return (
    projection: TaskCardProjectionV0,
    mutation: OwnedResultMutationV0,
  ): FakeAdapterResult => {
    // All adapters: validate input projection
    if (
      !projection.ownedNodes ||
      !Array.isArray(projection.ownedNodes) ||
      projection.ownedNodes.length === 0
    ) {
      return { receipt: null, shellInvoked: false, exitCode: null, timedOut: false };
    }

    // All adapters: guard mutation scope
    const ownedNodeIds = new Set(projection.ownedNodes.map((n) => n.nodeId));
    if (!ownedNodeIds.has(mutation.nodeId)) {
      return { receipt: null, shellInvoked: false, exitCode: null, timedOut: false };
    }

    // Mode-specific side-effect profile
    let shellInvoked = false;
    let exitCode: number | null = null;

    switch (mode) {
      case 'native':
        // In-process Rust execution — no shell, no child process
        break;

      case 'local-cli':
        // Supervised local child process — shell IS invoked
        shellInvoked = true;
        exitCode = 0;
        break;

      case 'remote-tmux':
        // Tmux-based remote CLI — shell IS invoked
        shellInvoked = true;
        exitCode = 0;
        break;

      case 'api':
        // In-process API call — shell is FORBIDDEN
        // The spy must remain at zero. If any code path invokes a shell,
        // the adapter must fail closed.
        shellInvoked = false;
        exitCode = null;
        break;
    }

    const receipt: CompletionReceiptV0 = {
      receiptId: `rec-${mode}-${mutation.mutationId}`,
      nodeId: mutation.nodeId,
      version: mutation.expectedVersion,
      digest: mutation.newDigest,
      outcome: 'completed',
      completedAt: new Date().toISOString(),
      causationId: mutation.causationId,
      correlationId: mutation.correlationId,
      evidenceRefs: [],
    };

    return { receipt, shellInvoked, exitCode, timedOut: false };
  };
}
