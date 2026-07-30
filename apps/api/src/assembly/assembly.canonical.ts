// MUN-0022: Assembly-specific canonical JSON — decision-bearing field extraction
// and SHA-256 digest computation. Reuses MUN-0020 canonicalJson internally;
// does not modify it. Pure function — zero side effects.

import { createHash } from 'node:crypto';
import { canonicalJson } from '../execution-authority/canonical-json';
import type { JsonValue } from '../execution-authority/canonical-json';
import type { AssemblyRequestV0, TaskCardV0 } from './assembly.types';

/**
 * Extract decision-bearing fields from a request (all fields except traceFields),
 * construct a plain object with sorted keys, and return the canonical JSON string.
 *
 * traceFields are explicitly excluded from decision-bearing bytes per the frozen
 * contract (PRD §3). All other fields are authoritative.
 */
export function canonicalizeDecisionFields(
  request: AssemblyRequestV0,
): string {
  const decisionObject: Record<string, unknown> = {
    schemaVersion: request.schemaVersion,
    taskId: request.taskId,
    causationId: request.causationId,
    correlationId: request.correlationId,
    tenant: request.tenant,
    principal: request.principal,
    purpose: request.purpose,
    audience: request.audience,
    scope: request.scope,
    rolePolicy: request.rolePolicy,
    candidateSet: request.candidateSet,
    provenance: request.provenance,
  };

  if (request.deadline !== undefined) {
    decisionObject.deadline = request.deadline;
  }
  if (request.attemptBudget !== undefined) {
    decisionObject.attemptBudget = request.attemptBudget;
  }

  // traceFields intentionally excluded — non-authoritative

  return canonicalJson(decisionObject as unknown as JsonValue);
}

/**
 * Canonicalize the decision-bearing fields of a TaskCardV0.
 * Excludes traceFields; includes nodes, edges, and preparedInvocation.
 */
export function canonicalizeTaskCardDecisionFields(
  card: TaskCardV0,
): string {
  const decisionObject: Record<string, unknown> = {
    schemaVersion: card.schemaVersion,
    taskId: card.taskId,
    causationId: card.causationId,
    correlationId: card.correlationId,
    nodes: card.nodes,
    edges: card.edges,
    preparedInvocation: card.preparedInvocation,
    authority: card.authority,
    rolePolicy: card.rolePolicy,
    candidateSet: card.candidateSet,
    provenance: card.provenance,
  };

  // traceFields intentionally excluded

  return canonicalJson(decisionObject as unknown as JsonValue);
}

/**
 * Compute SHA-256 hex digest of the decision-bearing fields of a request.
 * Returns exactly 64 lowercase hex characters.
 */
export function computeAssemblyDigest(request: AssemblyRequestV0): string {
  const canonicalBytes = canonicalizeDecisionFields(request);
  return createHash('sha256').update(canonicalBytes, 'utf8').digest('hex');
}

/**
 * Compute SHA-256 hex digest of a TaskCard's decision-bearing fields.
 */
export function computeTaskCardDigest(card: TaskCardV0): string {
  const canonicalBytes = canonicalizeTaskCardDecisionFields(card);
  return createHash('sha256').update(canonicalBytes, 'utf8').digest('hex');
}
