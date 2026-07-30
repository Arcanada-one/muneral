// MUN-0022: Assembly Package v0 — public API surface. Deliberately narrow:
// no NestJS module, no HTTP controller, no Prisma dependency, no runtime
// activation. Consumers call compileTaskCard as a pure function.

export { compileTaskCard } from './assembly.compiler';
export { validateAssemblyRequest } from './assembly.validator';
export {
  canonicalizeDecisionFields,
  canonicalizeTaskCardDecisionFields,
  computeAssemblyDigest,
  computeTaskCardDigest,
} from './assembly.canonical';
export { createAssemblyError } from './assembly.errors';
export {
  createProjection,
  guardMutationScope,
  submitReceipt,
  rejectWrongPlane,
  createFakeAdapter,
  FORBIDDEN_FLEET_FIELDS,
} from './assembly.guards';
export type {
  ReceiptSubmissionResult,
  WrongPlaneResult,
  AdapterMode,
  FakeAdapterResult,
  FakeAdapter,
} from './assembly.guards';

export type {
  AssemblyRequestV0,
  TaskCardV0,
  TaskCardNodeV0,
  TaskCardEdgeV0,
  TaskCardProjectionV0,
  OwnedResultMutationV0,
  CompletionReceiptV0,
  AssemblyErrorV0,
  PreparedInvocationV0,
  InvocationObservationV0,
  AssemblyErrorCode,
  AssemblyAuthority,
  RolePolicyIdentity,
  CandidateEvidence,
  PolicyProvenance,
  InvocationConstraints,
  ErrorDetails,
} from './assembly.types';

export {
  MAX_FIELD_LENGTH,
  MAX_CANDIDATES,
  MAX_ATTEMPT_BUDGET,
  MAX_NESTING_DEPTH,
  MAX_NODE_COUNT,
  MAX_CONCURRENT_ACTORS,
  ASSEMBLY_ERROR_CODES,
} from './assembly.types';
