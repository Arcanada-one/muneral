// KCLIVE-10 plan readiness: native terminal status alone is not acceptance.
// cancelled/archived satisfy native depends_on readiness elsewhere; here a
// required_for_acceptance prerequisite needs acceptedOutputSatisfied.

import type {
  PlanEdgeV1,
  PlanNodeRuntimeState,
  PlanSnapshotV1,
} from './plan-graph.types.js';

export interface PlanReadinessResult {
  nodeId: string;
  ready: boolean;
  blockedBy: Array<{
    fromNodeId: string;
    reason:
      | 'required_prerequisite_unsatisfied'
      | 'accepted_output_missing'
      | 'native_status_not_ready';
  }>;
}

const NATIVE_TERMINAL = new Set(['done', 'cancelled', 'archived']);

/**
 * Before starting a required dependent: both native readiness AND the accepted
 * output/capability contract. cancelled/archived alone does NOT supply missing
 * inputs for required_for_acceptance edges.
 */
export function evaluatePlanReadiness(
  snapshot: PlanSnapshotV1,
  states: Map<string, PlanNodeRuntimeState>,
  nodeId: string,
): PlanReadinessResult {
  const blockedBy: PlanReadinessResult['blockedBy'] = [];
  const incoming = snapshot.edges.filter(
    (e) =>
      e.toNodeId === nodeId && e.acceptanceRole === 'required_for_acceptance',
  );

  for (const edge of incoming) {
    const state = states.get(edge.fromNodeId);
    if (!state) {
      blockedBy.push({
        fromNodeId: edge.fromNodeId,
        reason: 'required_prerequisite_unsatisfied',
      });
      continue;
    }

    const nativeReady =
      state.status !== undefined && NATIVE_TERMINAL.has(state.status);
    if (!nativeReady) {
      blockedBy.push({
        fromNodeId: edge.fromNodeId,
        reason: 'native_status_not_ready',
      });
    }

    // Critical KCLIVE-10 rule: cancelled/archived alone is not acceptance.
    if (!state.acceptedOutputSatisfied) {
      blockedBy.push({
        fromNodeId: edge.fromNodeId,
        reason: 'accepted_output_missing',
      });
    }
  }

  // Optional edges never block readiness.
  void (snapshot.edges as PlanEdgeV1[]);

  return { nodeId, ready: blockedBy.length === 0, blockedBy };
}
