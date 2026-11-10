// KCLIVE-10: owner-managed plan/graph types.
// required_for_acceptance vs optional live HERE — not as a native TaskDependency enum.

export const PLAN_ACCEPTANCE_ROLES = [
  'required_for_acceptance',
  'optional',
] as const;

export type PlanAcceptanceRole = (typeof PLAN_ACCEPTANCE_ROLES)[number];

/** Native Muneral dependency types — optional must NEVER be sent as depends_on. */
export const NATIVE_DEPENDENCY_TYPES = [
  'depends_on',
  'blocks',
  'related_to',
  'duplicates',
] as const;

export type NativeDependencyType = (typeof NATIVE_DEPENDENCY_TYPES)[number];

/**
 * Explicit mapping from plan acceptance role → supported native API types.
 * optional enrichment uses related_to only when a native edge is requested;
 * it never becomes a blocking depends_on/blocks edge.
 */
export const PLAN_ROLE_TO_NATIVE: Record<
  PlanAcceptanceRole,
  readonly NativeDependencyType[]
> = {
  required_for_acceptance: ['depends_on', 'blocks'],
  optional: ['related_to', 'duplicates'],
};

export interface PlanNodeV1 {
  nodeId: string;
  taskId?: string;
  title?: string;
  /** Capability/output contract digest required before a dependent may start. */
  acceptedOutputContract?: string | null;
}

export interface PlanEdgeV1 {
  fromNodeId: string;
  toNodeId: string;
  acceptanceRole: PlanAcceptanceRole;
  /** Optional native mirror; must be compatible with acceptanceRole mapping. */
  nativeType?: NativeDependencyType;
}

export interface PlanSnapshotV1 {
  schema: 'MuneralPlanSnapshot/v1';
  rootTaskId: string;
  revision: number;
  cursor?: string | null;
  sourceBindings?: Record<string, string>;
  nodes: PlanNodeV1[];
  edges: PlanEdgeV1[];
  planDigest: string;
}

export interface PlanNodeRuntimeState {
  nodeId: string;
  /** Native task status when bound; undefined if unbound. */
  status?: string;
  /** True only when the accepted output/capability contract is satisfied. */
  acceptedOutputSatisfied: boolean;
}

export type CommandOperation =
  | 'task.create'
  | 'task.create_child'
  | 'run.associate';

export interface NormalizedCreateCommand {
  operation: CommandOperation;
  projectId: string;
  parentId: string | null;
  title: string;
  description: string | null;
  status: string | null;
  priority: string | null;
  sprintId: string | null;
  contractDigest: string | null;
  tags: string[];
}
