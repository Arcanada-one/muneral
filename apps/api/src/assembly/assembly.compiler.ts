// MUN-0022: Pure reference compiler — compileTaskCard transforms a validated
// AssemblyRequestV0 into a TaskCardV0 (or AssemblyErrorV0). Deterministic,
// side-effect free, no network/DB/filesystem/secret-store access.
// Only imports: node:crypto, assembly types, validator, canonical.

import type {
  AssemblyRequestV0,
  TaskCardV0,
  AssemblyErrorV0,
} from './assembly.types';
import { validateAssemblyRequest } from './assembly.validator';
import {
  canonicalizeDecisionFields,
  computeAssemblyDigest,
} from './assembly.canonical';
import { createAssemblyError } from './assembly.errors';

/**
 * Compile a Task Card from an assembly request.
 *
 * Steps:
 * 1. Validate the request → return error if invalid.
 * 2. Canonicalize decision-bearing fields.
 * 3. Compute digest.
 * 4. Build a single-node Task Card graph (v0: one node per request).
 * 5. Build PreparedInvocationV0.
 * 6. Narrow authority (v0: identity — request authority IS card authority).
 * 7. Verify narrowing did not widen.
 * 8. Assemble and return TaskCardV0.
 *
 * Pure function — zero side effects.
 */
export function compileTaskCard(
  request: AssemblyRequestV0,
): { ok: true; card: TaskCardV0 } | { ok: false; error: AssemblyErrorV0 } {
  // 1. Validate
  const validated = validateAssemblyRequest(request);
  if ('errorCode' in validated) {
    return { ok: false, error: validated };
  }

  // 2. Canonicalize decision-bearing fields (the canonical prompt bytes)
  const canonicalPrompt = canonicalizeDecisionFields(validated);

  // 3. Compute digest
  const digest = computeAssemblyDigest(validated);

  // 4. Build single-node Task Card graph (v0: simple linear card)
  const nodeId = `node-${validated.taskId}`;
  const nodes = [{
    nodeId,
    nodeType: 'invoke',
    ownedBy: validated.principal,
    dependsOn: [],
    payload: {},
  }];
  const edges: Array<{ from: string; to: string }> = [];

  // 5. Build PreparedInvocationV0
  const preparedInvocation = {
    invocationId: digest,
    targetRole: validated.rolePolicy.roleName,
    canonicalPrompt,
    constraints: {
      deadline: validated.deadline,
      budget: validated.attemptBudget,
    },
    evidenceRefs: [],
  };

  // 6. Narrow authority — v0 is identity (no dynamic policy engine)
  //    The request authority IS the card authority.
  const narrowedAuthority = {
    tenant: validated.tenant,
    principal: validated.principal,
    purpose: validated.purpose,
    audience: validated.audience,
    scope: validated.scope,
  };

  // 7. Verify narrowing did not widen (structural equality check)
  if (
    narrowedAuthority.tenant !== validated.tenant ||
    narrowedAuthority.principal !== validated.principal ||
    !isNarrowerOrEqual(narrowedAuthority.purpose, validated.purpose) ||
    !isNarrowerOrEqual(narrowedAuthority.audience, validated.audience) ||
    !isNarrowerOrEqual(narrowedAuthority.scope, validated.scope)
  ) {
    return {
      ok: false,
      error: createAssemblyError(
        'AUTHORITY_WIDENING',
        validated.taskId,
        validated.causationId,
        validated.correlationId,
        {
          reason: 'output authority is wider than input authority',
          expected: 'equal or narrower scope',
          actual: `scope: ${narrowedAuthority.scope} vs ${validated.scope}`,
        },
      ),
    };
  }

  // 8. Assemble TaskCardV0
  const canonicalBytes = canonicalPrompt;
  const card: TaskCardV0 = {
    cardId: digest,
    canonicalBytes,
    digest,
    schemaVersion: 'v0',
    taskId: validated.taskId,
    causationId: validated.causationId,
    correlationId: validated.correlationId,
    nodes,
    edges,
    preparedInvocation,
    authority: narrowedAuthority,
    rolePolicy: validated.rolePolicy,
    candidateSet: validated.candidateSet,
    traceFields: validated.traceFields,
    provenance: validated.provenance,
  };

  return { ok: true, card };
}

/**
 * Check that `narrowed` is equal to or narrower than `original`.
 * "Narrower" for v0 means the narrowed value is a subset of the original's
 * comma-separated tokens. Identity (equal strings) is the v0 default.
 */
function isNarrowerOrEqual(narrowed: string, original: string): boolean {
  if (narrowed === original) return true;
  // Comma-separated token narrowing: every token in narrowed must appear in original
  const originalTokens = new Set(
    original.split(',').map((t) => t.trim()).filter(Boolean),
  );
  const narrowedTokens = narrowed.split(',').map((t) => t.trim()).filter(Boolean);
  return narrowedTokens.every((t) => originalTokens.has(t));
}
