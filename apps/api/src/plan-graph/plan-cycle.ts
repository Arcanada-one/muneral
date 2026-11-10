// KCLIVE-10: blocking-cycle detection for owner-managed plan edges.
// Only required_for_acceptance edges participate in the blocking DAG.
// Optional edges never create a blocking cycle (and must not be mapped to depends_on).

import type { PlanEdgeV1 } from './plan-graph.types.js';
import { PLAN_ROLE_TO_NATIVE } from './plan-graph.types.js';

export class PlanCycleError extends Error {
  readonly code = 'PLAN_BLOCKING_CYCLE' as const;

  constructor(message: string) {
    super(message);
    this.name = 'PlanCycleError';
  }
}

export class PlanEdgeMappingError extends Error {
  readonly code = 'PLAN_EDGE_MAPPING_INVALID' as const;

  constructor(message: string) {
    super(message);
    this.name = 'PlanEdgeMappingError';
  }
}

/** Validate optional/required mapping against supported native types. */
export function assertEdgeMapping(edge: PlanEdgeV1): void {
  if (edge.nativeType === undefined) return;
  const allowed = PLAN_ROLE_TO_NATIVE[edge.acceptanceRole];
  if (!allowed.includes(edge.nativeType)) {
    throw new PlanEdgeMappingError(
      `acceptanceRole=${edge.acceptanceRole} cannot map to native type=${edge.nativeType}`,
    );
  }
  if (
    edge.acceptanceRole === 'optional' &&
    (edge.nativeType === 'depends_on' || edge.nativeType === 'blocks')
  ) {
    throw new PlanEdgeMappingError(
      'optional plan edges must not become blocking depends_on/blocks',
    );
  }
}

/**
 * Reject blocking cycles among required_for_acceptance edges.
 * Shared prerequisites (one node referenced by many) remain valid DAG joins.
 */
export function assertNoBlockingCycle(edges: PlanEdgeV1[]): void {
  for (const edge of edges) {
    assertEdgeMapping(edge);
  }

  const blocking = edges.filter(
    (e) => e.acceptanceRole === 'required_for_acceptance',
  );

  const adj = new Map<string, string[]>();
  for (const e of blocking) {
    const list = adj.get(e.fromNodeId) ?? [];
    list.push(e.toNodeId);
    adj.set(e.fromNodeId, list);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();

  const visit = (node: string): void => {
    color.set(node, GRAY);
    for (const next of adj.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        throw new PlanCycleError(
          `blocking cycle detected involving node ${node} → ${next}`,
        );
      }
      if (c === WHITE) visit(next);
    }
    color.set(node, BLACK);
  };

  for (const node of adj.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) visit(node);
  }
}
