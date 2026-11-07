import {
  jsonDigest,
  type JsonObject,
} from '../execution-authority/canonical-json.js';
import { assertNoBlockingCycle } from './plan-cycle.js';
import type {
  PlanEdgeV1,
  PlanNodeV1,
  PlanSnapshotV1,
} from './plan-graph.types.js';

export interface PlanSnapshotInput {
  rootTaskId: string;
  revision: number;
  cursor?: string | null;
  sourceBindings?: Record<string, string>;
  nodes: PlanNodeV1[];
  edges: PlanEdgeV1[];
}

/** Build a digested snapshot; rejects blocking cycles before digesting. */
export function buildPlanSnapshot(input: PlanSnapshotInput): PlanSnapshotV1 {
  assertNoBlockingCycle(input.edges);

  const nodes = [...input.nodes].sort((a, b) =>
    a.nodeId.localeCompare(b.nodeId),
  );
  const edges = [...input.edges].sort((a, b) => {
    const left = `${a.fromNodeId}->${a.toNodeId}:${a.acceptanceRole}`;
    const right = `${b.fromNodeId}->${b.toNodeId}:${b.acceptanceRole}`;
    return left.localeCompare(right);
  });

  const body: JsonObject = {
    schema: 'MuneralPlanSnapshot/v1',
    rootTaskId: input.rootTaskId,
    revision: input.revision,
    cursor: input.cursor ?? null,
    sourceBindings: (input.sourceBindings ?? {}) as unknown as JsonObject,
    nodes: nodes as unknown as JsonObject,
    edges: edges as unknown as JsonObject,
  };

  const planDigest = jsonDigest(body);
  return {
    schema: 'MuneralPlanSnapshot/v1',
    rootTaskId: input.rootTaskId,
    revision: input.revision,
    cursor: input.cursor ?? null,
    sourceBindings: input.sourceBindings ?? {},
    nodes,
    edges,
    planDigest,
  };
}
