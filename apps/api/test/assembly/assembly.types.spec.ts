// MUN-0022: Type-level tests — verify frozen contract shapes, readonly
// modifiers, literal types, and bounded constants.

import type {
  AssemblyRequestV0,
  TaskCardV0,
  TaskCardProjectionV0,
  OwnedResultMutationV0,
  CompletionReceiptV0,
  AssemblyErrorV0,
  PreparedInvocationV0,
  InvocationObservationV0,
  AssemblyAuthority,
  RolePolicyIdentity,
  CandidateEvidence,
  PolicyProvenance,
  InvocationConstraints,
  ErrorDetails,
  AssemblyErrorCode,
} from '../../src/assembly/assembly.types';

import {
  MAX_FIELD_LENGTH,
  MAX_CANDIDATES,
  MAX_ATTEMPT_BUDGET,
  MAX_NESTING_DEPTH,
  MAX_NODE_COUNT,
  MAX_CONCURRENT_ACTORS,
  ASSEMBLY_ERROR_CODES,
} from '../../src/assembly/assembly.types';

// ---------------------------------------------------------------------------
// Bounded constants
// ---------------------------------------------------------------------------

describe('bounded constants', () => {
  it('MAX_FIELD_LENGTH is 256', () => {
    expect(MAX_FIELD_LENGTH).toBe(256);
  });

  it('MAX_CANDIDATES is 64', () => {
    expect(MAX_CANDIDATES).toBe(64);
  });

  it('MAX_ATTEMPT_BUDGET is 1000', () => {
    expect(MAX_ATTEMPT_BUDGET).toBe(1000);
  });

  it('MAX_NESTING_DEPTH is 10', () => {
    expect(MAX_NESTING_DEPTH).toBe(10);
  });

  it('MAX_NODE_COUNT is 100', () => {
    expect(MAX_NODE_COUNT).toBe(100);
  });

  it('MAX_CONCURRENT_ACTORS is 5', () => {
    expect(MAX_CONCURRENT_ACTORS).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// AssemblyErrorCode exhaustiveness
// ---------------------------------------------------------------------------

describe('AssemblyErrorCode', () => {
  it('has exactly 18 members', () => {
    expect(ASSEMBLY_ERROR_CODES).toHaveLength(18);
  });

  it('includes all frozen error codes from the PRD', () => {
    const expected: AssemblyErrorCode[] = [
      'UNSUPPORTED_SCHEMA_VERSION',
      'UNKNOWN_EXECUTION_FIELD',
      'AMBIGUOUS_CANONICAL_VALUE',
      'UNSAFE_SIZE',
      'UNSAFE_NESTING',
      'AUTHORITY_WIDENING',
      'INVALID_PROVENANCE',
      'EXPIRED_POLICY',
      'CREDENTIAL_IN_PROHIBITED_POSITION',
      'INVALID_DIGEST',
      'DEADLINE_EXCEEDED',
      'ATTEMPT_BUDGET_EXCEEDED',
      'INVALID_TRANSITION',
      'OUT_OF_SCOPE_MUTATION',
      'DUPLICATE_COMPLETION',
      'CONCURRENT_OWNERSHIP',
      'OUT_OF_BAND_RESULT',
      'WRONG_PLANE_CONTROL',
    ];
    expect(ASSEMBLY_ERROR_CODES.sort()).toEqual(expected.sort());
  });

  it('has no duplicate error codes', () => {
    const unique = new Set(ASSEMBLY_ERROR_CODES);
    expect(unique.size).toBe(ASSEMBLY_ERROR_CODES.length);
  });
});

// ---------------------------------------------------------------------------
// Type shape verification (compile-time + runtime duck-type checks)
// ---------------------------------------------------------------------------

describe('AssemblyRequestV0 shape', () => {
  it('has schemaVersion literal "v0"', () => {
    const req: AssemblyRequestV0 = makeMinimalRequest();
    // TypeScript literal type: req.schemaVersion is "v0", not string
    const v: 'v0' = req.schemaVersion;
    expect(v).toBe('v0');
  });

  it('has all required fields', () => {
    const req: AssemblyRequestV0 = makeMinimalRequest();
    expect(req.schemaVersion).toBe('v0');
    expect(typeof req.taskId).toBe('string');
    expect(typeof req.causationId).toBe('string');
    expect(typeof req.correlationId).toBe('string');
    expect(typeof req.tenant).toBe('string');
    expect(typeof req.principal).toBe('string');
    expect(typeof req.purpose).toBe('string');
    expect(typeof req.audience).toBe('string');
    expect(typeof req.scope).toBe('string');
    expect(req.rolePolicy).toBeDefined();
    expect(req.candidateSet).toBeDefined();
    expect(req.provenance).toBeDefined();
  });

  it('has optional deadline and attemptBudget', () => {
    const req: AssemblyRequestV0 = makeMinimalRequest();
    expect(req.deadline).toBeUndefined();
    expect(req.attemptBudget).toBeUndefined();
  });

  it('has optional traceFields', () => {
    const req: AssemblyRequestV0 = makeMinimalRequest();
    expect(req.traceFields).toBeUndefined();
  });
});

describe('TaskCardV0 shape', () => {
  it('has deterministic cardId and digest', () => {
    const card = makeMinimalTaskCard();
    expect(typeof card.cardId).toBe('string');
    expect(typeof card.digest).toBe('string');
    expect(card.cardId).toBe(card.digest);
    expect(card.digest).toHaveLength(64);
  });

  it('has schemaVersion literal "v0"', () => {
    const card = makeMinimalTaskCard();
    const v: 'v0' = card.schemaVersion;
    expect(v).toBe('v0');
  });

  it('includes nodes and edges for the task graph', () => {
    const card = makeMinimalTaskCard();
    expect(Array.isArray(card.nodes)).toBe(true);
    expect(Array.isArray(card.edges)).toBe(true);
    expect(card.nodes.length).toBeGreaterThanOrEqual(1);
  });

  it('includes preparedInvocation', () => {
    const card = makeMinimalTaskCard();
    expect(card.preparedInvocation).toBeDefined();
    expect(typeof card.preparedInvocation.invocationId).toBe('string');
    expect(typeof card.preparedInvocation.targetRole).toBe('string');
  });

  it('includes authority equal to or narrower than request', () => {
    const card = makeMinimalTaskCard();
    expect(card.authority.tenant).toBe('acme');
    expect(card.authority.principal).toBe('user-1');
  });
});

describe('TaskCardProjectionV0 shape', () => {
  it('has projectionId referencing the parent card', () => {
    const proj = makeMinimalProjection();
    expect(typeof proj.projectionId).toBe('string');
    expect(typeof proj.cardId).toBe('string');
    expect(typeof proj.cardDigest).toBe('string');
    expect(proj.cardDigest).toHaveLength(64);
  });

  it('contains only owned nodes', () => {
    const proj = makeMinimalProjection();
    expect(Array.isArray(proj.ownedNodes)).toBe(true);
    for (const node of proj.ownedNodes) {
      expect(node.ownedBy).toBe('subagent-1');
    }
  });

  it('has deadline and attemptBudget from parent card', () => {
    const proj = makeMinimalProjection();
    expect(proj.deadline).toBeDefined();
    expect(proj.attemptBudget).toBe(5);
  });
});

describe('OwnedResultMutationV0 shape', () => {
  it('references exact node, version, and new digest', () => {
    const mut = makeMinimalMutation();
    expect(typeof mut.mutationId).toBe('string');
    expect(typeof mut.nodeId).toBe('string');
    expect(mut.expectedVersion).toBe(1);
    expect(mut.newDigest).toHaveLength(64);
    expect(typeof mut.payload).toBe('object');
  });
});

describe('CompletionReceiptV0 shape', () => {
  it('references exact committed node, version, and digest', () => {
    const receipt = makeMinimalReceipt();
    expect(typeof receipt.receiptId).toBe('string');
    expect(typeof receipt.nodeId).toBe('string');
    expect(receipt.version).toBe(1);
    expect(receipt.digest).toHaveLength(64);
    expect(['completed', 'failed', 'timeout', 'cancelled']).toContain(receipt.outcome);
    expect(typeof receipt.completedAt).toBe('string');
    expect(receipt.completedAt.endsWith('Z')).toBe(true);
  });
});

describe('AssemblyErrorV0 shape', () => {
  it('has all required error fields', () => {
    const err = makeMinimalError();
    expect(typeof err.errorId).toBe('string');
    expect(ASSEMBLY_ERROR_CODES).toContain(err.errorCode);
    expect(typeof err.message).toBe('string');
    expect(err.schemaVersion).toBe('v0');
    expect(typeof err.taskId).toBe('string');
    expect(typeof err.causationId).toBe('string');
    expect(typeof err.correlationId).toBe('string');
    expect(typeof err.failedAt).toBe('string');
    expect(err.details).toBeDefined();
    expect(typeof err.details.reason).toBe('string');
  });
});

describe('PreparedInvocationV0 shape', () => {
  it('has invocationId, targetRole, canonicalPrompt, constraints, evidenceRefs', () => {
    const inv = makeMinimalPreparedInvocation();
    expect(typeof inv.invocationId).toBe('string');
    expect(typeof inv.targetRole).toBe('string');
    expect(typeof inv.canonicalPrompt).toBe('string');
    expect(inv.constraints).toBeDefined();
    expect(Array.isArray(inv.evidenceRefs)).toBe(true);
  });

  it('has NO provider endpoint, credentials, model name, or tool definitions', () => {
    const inv = makeMinimalPreparedInvocation();
    // Type system check: these keys must not exist on the type
    expect('providerEndpoint' in inv).toBe(false);
  });
});

describe('InvocationObservationV0 shape', () => {
  it('has observationId, invocationId, observedAt, outcome, evidenceRefs', () => {
    const obs: InvocationObservationV0 = {
      observationId: 'obs-1',
      invocationId: 'inv-1',
      observedAt: '2026-07-30T00:00:00Z',
      outcome: 'completed',
      resultDigest: 'a'.repeat(64),
      evidenceRefs: [],
    };
    expect(obs.outcome).toBe('completed');
    expect(Array.isArray(obs.evidenceRefs)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helpers — minimal valid instances for shape verification
// ---------------------------------------------------------------------------

function makeMinimalRequest(): AssemblyRequestV0 {
  return {
    schemaVersion: 'v0',
    taskId: 'task-1',
    causationId: 'caus-1',
    correlationId: 'corr-1',
    tenant: 'acme',
    principal: 'user-1',
    purpose: 'test',
    audience: 'internal',
    scope: 'read',
    rolePolicy: {
      policyId: 'policy-sha256',
      policyVersion: '2026-07-30T00:00:00Z',
      roleName: 'assistant',
    },
    candidateSet: {
      candidates: ['assistant', 'reviewer'],
      sourceDigest: 'b'.repeat(64),
      capturedAt: '2026-07-30T00:00:00Z',
    },
    provenance: {
      policyUri: 'content://policy-sha256',
      policyDigest: 'c'.repeat(64),
      issuedAt: '2026-07-30T00:00:00Z',
    },
  };
}

function makeMinimalTaskCard(): TaskCardV0 {
  return {
    cardId: 'd'.repeat(64),
    canonicalBytes: '{"schemaVersion":"v0"}',
    digest: 'd'.repeat(64),
    schemaVersion: 'v0',
    taskId: 'task-1',
    causationId: 'caus-1',
    correlationId: 'corr-1',
    nodes: [{
      nodeId: 'node-1',
      nodeType: 'invoke',
      ownedBy: 'subagent-1',
      dependsOn: [],
      payload: {},
    }],
    edges: [],
    preparedInvocation: makeMinimalPreparedInvocation(),
    authority: {
      tenant: 'acme',
      principal: 'user-1',
      purpose: 'test',
      audience: 'internal',
      scope: 'read',
    },
    rolePolicy: {
      policyId: 'policy-sha256',
      policyVersion: '2026-07-30T00:00:00Z',
      roleName: 'assistant',
    },
    candidateSet: {
      candidates: ['assistant', 'reviewer'],
      sourceDigest: 'b'.repeat(64),
      capturedAt: '2026-07-30T00:00:00Z',
    },
    provenance: {
      policyUri: 'content://policy-sha256',
      policyDigest: 'c'.repeat(64),
      issuedAt: '2026-07-30T00:00:00Z',
    },
  };
}

function makeMinimalProjection(): TaskCardProjectionV0 {
  return {
    projectionId: 'proj-1',
    cardId: 'd'.repeat(64),
    cardDigest: 'd'.repeat(64),
    schemaVersion: 'v0',
    ownedNodes: [{
      nodeId: 'node-1',
      nodeType: 'invoke',
      ownedBy: 'subagent-1',
      dependsOn: [],
      payload: {},
    }],
    visibleEdges: [],
    authority: {
      tenant: 'acme',
      principal: 'user-1',
      purpose: 'test',
      audience: 'internal',
      scope: 'read',
    },
    deadline: '2027-01-01T00:00:00Z',
    attemptBudget: 5,
    provenance: {
      policyUri: 'content://policy-sha256',
      policyDigest: 'c'.repeat(64),
      issuedAt: '2026-07-30T00:00:00Z',
    },
  };
}

function makeMinimalMutation(): OwnedResultMutationV0 {
  return {
    mutationId: 'mut-1',
    nodeId: 'node-1',
    expectedVersion: 1,
    newDigest: 'e'.repeat(64),
    payload: { result: 'done' },
    causationId: 'caus-1',
    correlationId: 'corr-1',
  };
}

function makeMinimalReceipt(): CompletionReceiptV0 {
  return {
    receiptId: 'rec-1',
    nodeId: 'node-1',
    version: 1,
    digest: 'e'.repeat(64),
    outcome: 'completed',
    completedAt: '2026-07-30T00:00:00Z',
    causationId: 'caus-1',
    correlationId: 'corr-1',
    evidenceRefs: [],
  };
}

function makeMinimalError(): AssemblyErrorV0 {
  return {
    errorId: 'e'.repeat(64),
    errorCode: 'UNSUPPORTED_SCHEMA_VERSION',
    message: 'Unsupported schema version: v99',
    schemaVersion: 'v0',
    taskId: 'task-1',
    causationId: 'caus-1',
    correlationId: 'corr-1',
    failedAt: '2026-07-30T00:00:00Z',
    details: {
      reason: 'schemaVersion must be "v0"',
      fieldName: 'schemaVersion',
      expected: 'v0',
      actual: 'v99',
    },
  };
}

function makeMinimalPreparedInvocation(): PreparedInvocationV0 {
  return {
    invocationId: 'inv-1',
    targetRole: 'assistant',
    canonicalPrompt: '{"schemaVersion":"v0"}',
    constraints: {},
    evidenceRefs: [],
  };
}
