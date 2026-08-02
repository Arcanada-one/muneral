// MUN-0022: frozen public value surface. Assembly describes what should be
// invoked; it never invokes, persists, schedules, observes, or commits work.

export { compileAssembly } from './assembly.compiler';

export type {
  AssemblyRequestV0,
  AssemblyArtifactV0,
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
  Sha256Hex,
  CanonicalJsonPrimitive,
  CanonicalJsonArray,
  CanonicalJsonObject,
  CanonicalJsonValue,
  AssemblyCompileResultV0,
} from './assembly.types';
