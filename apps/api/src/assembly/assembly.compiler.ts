// MUN-0022 pure compiler for the frozen AssemblyArtifactV0 contract.

import { createHash } from 'node:crypto';
import { canonicalJsonV1 } from '../execution-authority/canonical-json-v1';
import type {
  AssemblyArtifactV0,
  AssemblyCompileResultV0,
  AssemblyRequestV0,
} from './assembly.types';
import { createAssemblyDecision, createPreparedInvocation } from './assembly.canonical';
import { validateAssemblyRequest } from './assembly.validator';

/** Compile provider-neutral data without I/O, clocks, randomness, or mutation. */
export function compileAssembly(request: AssemblyRequestV0): AssemblyCompileResultV0 {
  const validated = validateAssemblyRequest(request);
  if ('errorCode' in validated) {
    return deepFreeze({ ok: false as const, error: validated });
  }

  const preparedInvocation = createPreparedInvocation(validated);
  const canonicalBytes = canonicalJsonV1(createAssemblyDecision(validated, preparedInvocation));
  const digest = createHash('sha256').update(canonicalBytes, 'utf8').digest('hex');
  const artifact: AssemblyArtifactV0 = {
    artifactId: digest,
    canonicalBytes,
    digest,
    schemaVersion: 'v0',
    taskId: validated.taskId,
    causationId: validated.causationId,
    correlationId: validated.correlationId,
    evaluatedAt: validated.evaluatedAt,
    preparedInvocation,
    authorityCeiling: validated.authorityCeiling,
    authority: validated.requestedAuthority,
    rolePolicy: validated.rolePolicy,
    candidateSet: validated.candidateSet,
    ...(validated.traceFields === undefined ? {} : { traceFields: validated.traceFields }),
    provenance: validated.provenance,
  };
  return deepFreeze({ ok: true as const, artifact });
}

function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== 'object' || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}
