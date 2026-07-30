#!/usr/bin/env node
// MUN-0022: Golden fixture digest generator. Computes expectedDigest for
// each fixture input using the TypeScript compiler, producing JSON fixture
// files in fixtures/positive/ and fixtures/negative/.
//
// Usage: npx ts-node generate-fixtures.ts
// Output: apps/api/test/assembly/fixtures/{positive,negative}/*.json

const path = require('path');
const fs = require('fs');

// We can't import TS modules directly with plain node, so we compute
// the canonical JSON and digest inline using the same algorithm.

function canonicalJson(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort(), '');
  // Actually use the proper sorted-keys approach
}

// The proper canonical JSON: sort keys, no whitespace
function canonicalJsonProper(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJsonProper).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  const pairs = keys.map(k => JSON.stringify(k) + ':' + canonicalJsonProper(obj[k]));
  return '{' + pairs.join(',') + '}';
}

const crypto = require('crypto');

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function extractDecisionFields(request) {
  const decision = {
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
    decision.deadline = request.deadline;
  }
  if (request.attemptBudget !== undefined) {
    decision.attemptBudget = request.attemptBudget;
  }
  return decision;
}

function computeDigest(request) {
  const decision = extractDecisionFields(request);
  const canonical = canonicalJsonProper(decision);
  return sha256(canonical);
}

// ---------------------------------------------------------------------------
// Fixture definitions
// ---------------------------------------------------------------------------

const fixturesDir = path.resolve(__dirname, 'fixtures');

const positiveFixtures = [
  {
    filename: 'minimal-request.json',
    description: 'Smallest valid request — all required fields, no optionals',
    input: {
      schemaVersion: 'v0',
      taskId: 'task-minimal',
      causationId: 'caus-minimal',
      correlationId: 'corr-minimal',
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
    },
  },
  {
    filename: 'full-request.json',
    description: 'All fields present including deadline, attemptBudget, traceFields',
    input: {
      schemaVersion: 'v0',
      taskId: 'task-full',
      causationId: 'caus-full',
      correlationId: 'corr-full',
      tenant: 'acme',
      principal: 'user-2',
      purpose: 'production',
      audience: 'external',
      scope: 'read,write',
      rolePolicy: {
        policyId: 'policy-full',
        policyVersion: '2026-08-01T00:00:00Z',
        roleName: 'reviewer',
      },
      candidateSet: {
        candidates: ['assistant', 'reviewer', 'critic'],
        sourceDigest: 'd'.repeat(64),
        capturedAt: '2026-07-30T12:00:00Z',
      },
      deadline: '2027-01-01T00:00:00Z',
      attemptBudget: 10,
      traceFields: {
        requestId: 'abc-999',
        source: 'cli',
        debugHint: 'test-mode',
      },
      provenance: {
        policyUri: 'content://policy-full',
        policyDigest: 'e'.repeat(64),
        issuedAt: '2026-07-30T00:00:00Z',
        expiresAt: '2027-07-30T00:00:00Z',
      },
    },
  },
  {
    filename: 'narrow-scope.json',
    description: 'Scope is subset — narrow authority',
    input: {
      schemaVersion: 'v0',
      taskId: 'task-narrow',
      causationId: 'caus-narrow',
      correlationId: 'corr-narrow',
      tenant: 'acme',
      principal: 'user-3',
      purpose: 'review',
      audience: 'internal',
      scope: 'read',
      rolePolicy: {
        policyId: 'policy-narrow',
        policyVersion: '2026-07-30T00:00:00Z',
        roleName: 'assistant',
      },
      candidateSet: {
        candidates: ['assistant'],
        sourceDigest: 'f'.repeat(64),
        capturedAt: '2026-07-30T00:00:00Z',
      },
      provenance: {
        policyUri: 'content://policy-narrow',
        policyDigest: 'a'.repeat(64),
        issuedAt: '2026-07-30T00:00:00Z',
      },
    },
  },
  {
    filename: 'with-trace-fields.json',
    description: 'Non-empty traceFields — verify they do not affect digest',
    input: {
      schemaVersion: 'v0',
      taskId: 'task-trace',
      causationId: 'caus-trace',
      correlationId: 'corr-trace',
      tenant: 'acme',
      principal: 'user-4',
      purpose: 'test',
      audience: 'internal',
      scope: 'read',
      rolePolicy: {
        policyId: 'policy-trace',
        policyVersion: '2026-07-30T00:00:00Z',
        roleName: 'assistant',
      },
      candidateSet: {
        candidates: ['assistant', 'reviewer'],
        sourceDigest: 'b'.repeat(64),
        capturedAt: '2026-07-30T00:00:00Z',
      },
      deadline: '2027-06-01T00:00:00Z',
      traceFields: {
        customRequestId: 'xyz-789',
        originatingHost: 'build-agent-3',
        pipelineRunId: 'run-42',
      },
      provenance: {
        policyUri: 'content://policy-trace',
        policyDigest: 'c'.repeat(64),
        issuedAt: '2026-07-30T00:00:00Z',
      },
    },
  },
  {
    filename: 'no-deadline.json',
    description: 'Optional deadline omitted, attemptBudget present',
    input: {
      schemaVersion: 'v0',
      taskId: 'task-nodeadline',
      causationId: 'caus-nd',
      correlationId: 'corr-nd',
      tenant: 'acme',
      principal: 'user-5',
      purpose: 'batch',
      audience: 'internal',
      scope: 'admin',
      rolePolicy: {
        policyId: 'policy-admin',
        policyVersion: '2026-07-30T00:00:00Z',
        roleName: 'admin',
      },
      candidateSet: {
        candidates: ['admin'],
        sourceDigest: 'a'.repeat(64),
        capturedAt: '2026-07-30T00:00:00Z',
      },
      attemptBudget: 50,
      provenance: {
        policyUri: 'content://policy-admin',
        policyDigest: 'b'.repeat(64),
        issuedAt: '2026-07-30T00:00:00Z',
      },
    },
  },
];

const negativeFixtures = [
  {
    filename: 'unsupported-schema-version.json',
    description: 'schemaVersion "v1" → UNSUPPORTED_SCHEMA_VERSION',
    input: {
      schemaVersion: 'v1',
      taskId: 'task-bad',
      causationId: 'c',
      correlationId: 'c',
      tenant: 'acme',
      principal: 'user',
      purpose: 'test',
      audience: 'internal',
      scope: 'read',
      rolePolicy: { policyId: 'p', policyVersion: 'v1', roleName: 'r' },
      candidateSet: { candidates: ['a'], sourceDigest: 'a'.repeat(64), capturedAt: '2026-07-30T00:00:00Z' },
      provenance: { policyUri: 'u', policyDigest: 'b'.repeat(64), issuedAt: '2026-07-30T00:00:00Z' },
    },
    expectedErrorCode: 'UNSUPPORTED_SCHEMA_VERSION',
  },
  {
    filename: 'unknown-execution-field.json',
    description: 'Extra key "providerConfig" → UNKNOWN_EXECUTION_FIELD',
    input: {
      schemaVersion: 'v0',
      taskId: 'task-bad',
      causationId: 'c',
      correlationId: 'c',
      tenant: 'acme',
      principal: 'user',
      purpose: 'test',
      audience: 'internal',
      scope: 'read',
      rolePolicy: { policyId: 'p', policyVersion: 'v1', roleName: 'r' },
      candidateSet: { candidates: ['a'], sourceDigest: 'a'.repeat(64), capturedAt: '2026-07-30T00:00:00Z' },
      provenance: { policyUri: 'u', policyDigest: 'b'.repeat(64), issuedAt: '2026-07-30T00:00:00Z' },
      providerConfig: { endpoint: 'https://evil.com' },
    },
    expectedErrorCode: 'UNKNOWN_EXECUTION_FIELD',
  },
  {
    filename: 'unsafe-size.json',
    description: 'taskId exceeds 256 chars → UNSAFE_SIZE',
    input: {
      schemaVersion: 'v0',
      taskId: 'x'.repeat(257),
      causationId: 'c',
      correlationId: 'c',
      tenant: 'acme',
      principal: 'user',
      purpose: 'test',
      audience: 'internal',
      scope: 'read',
      rolePolicy: { policyId: 'p', policyVersion: 'v1', roleName: 'r' },
      candidateSet: { candidates: ['a'], sourceDigest: 'a'.repeat(64), capturedAt: '2026-07-30T00:00:00Z' },
      provenance: { policyUri: 'u', policyDigest: 'b'.repeat(64), issuedAt: '2026-07-30T00:00:00Z' },
    },
    expectedErrorCode: 'UNSAFE_SIZE',
  },
  {
    filename: 'unsafe-nesting.json',
    description: 'Deeply nested object → UNSAFE_NESTING',
    input: (() => {
      let deep = {};
      let cursor = deep;
      for (let i = 0; i < 12; i++) {
        cursor['nested'] = {};
        cursor = cursor['nested'];
      }
      return {
        schemaVersion: 'v0',
        taskId: 'task-nest',
        causationId: 'c',
        correlationId: 'c',
        tenant: 'acme',
        principal: 'user',
        purpose: 'test',
        audience: 'internal',
        scope: 'read',
        rolePolicy: { policyId: 'p', policyVersion: 'v1', roleName: 'r' },
        candidateSet: { candidates: ['a'], sourceDigest: 'a'.repeat(64), capturedAt: '2026-07-30T00:00:00Z' },
        provenance: { policyUri: 'u', policyDigest: 'b'.repeat(64), issuedAt: '2026-07-30T00:00:00Z' },
        traceFields: deep,
      };
    })(),
    expectedErrorCode: 'UNSAFE_NESTING',
  },
  {
    filename: 'invalid-provenance.json',
    description: 'policyDigest is 63 hex chars → INVALID_PROVENANCE',
    input: {
      schemaVersion: 'v0',
      taskId: 'task-prov',
      causationId: 'c',
      correlationId: 'c',
      tenant: 'acme',
      principal: 'user',
      purpose: 'test',
      audience: 'internal',
      scope: 'read',
      rolePolicy: { policyId: 'p', policyVersion: 'v1', roleName: 'r' },
      candidateSet: { candidates: ['a'], sourceDigest: 'a'.repeat(64), capturedAt: '2026-07-30T00:00:00Z' },
      provenance: { policyUri: 'u', policyDigest: 'a'.repeat(63), issuedAt: '2026-07-30T00:00:00Z' },
    },
    expectedErrorCode: 'INVALID_PROVENANCE',
  },
  {
    filename: 'expired-policy.json',
    description: 'expiresAt in past → EXPIRED_POLICY',
    input: {
      schemaVersion: 'v0',
      taskId: 'task-exp',
      causationId: 'c',
      correlationId: 'c',
      tenant: 'acme',
      principal: 'user',
      purpose: 'test',
      audience: 'internal',
      scope: 'read',
      rolePolicy: { policyId: 'p', policyVersion: 'v1', roleName: 'r' },
      candidateSet: { candidates: ['a'], sourceDigest: 'a'.repeat(64), capturedAt: '2026-07-30T00:00:00Z' },
      provenance: {
        policyUri: 'u',
        policyDigest: 'b'.repeat(64),
        issuedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2020-01-01T00:00:00Z',
      },
    },
    expectedErrorCode: 'EXPIRED_POLICY',
  },
  {
    filename: 'credential-bearer.json',
    description: 'purpose contains "Bearer " token → CREDENTIAL_IN_PROHIBITED_POSITION',
    input: {
      schemaVersion: 'v0',
      taskId: 'task-cred',
      causationId: 'c',
      correlationId: 'c',
      tenant: 'acme',
      principal: 'user',
      purpose: 'Bearer sk-abc123',
      audience: 'internal',
      scope: 'read',
      rolePolicy: { policyId: 'p', policyVersion: 'v1', roleName: 'r' },
      candidateSet: { candidates: ['a'], sourceDigest: 'a'.repeat(64), capturedAt: '2026-07-30T00:00:00Z' },
      provenance: { policyUri: 'u', policyDigest: 'b'.repeat(64), issuedAt: '2026-07-30T00:00:00Z' },
    },
    expectedErrorCode: 'CREDENTIAL_IN_PROHIBITED_POSITION',
  },
  {
    filename: 'credential-key.json',
    description: 'scope contains base64-key pattern → CREDENTIAL_IN_PROHIBITED_POSITION',
    input: {
      schemaVersion: 'v0',
      taskId: 'task-cred2',
      causationId: 'c',
      correlationId: 'c',
      tenant: 'acme',
      principal: 'user',
      purpose: 'test',
      audience: 'internal',
      scope: 'akid-' + 'A'.repeat(40),
      rolePolicy: { policyId: 'p', policyVersion: 'v1', roleName: 'r' },
      candidateSet: { candidates: ['a'], sourceDigest: 'a'.repeat(64), capturedAt: '2026-07-30T00:00:00Z' },
      provenance: { policyUri: 'u', policyDigest: 'b'.repeat(64), issuedAt: '2026-07-30T00:00:00Z' },
    },
    expectedErrorCode: 'CREDENTIAL_IN_PROHIBITED_POSITION',
  },
  {
    filename: 'invalid-digest.json',
    description: 'candidateSet sourceDigest is not 64 lowercase hex → INVALID_DIGEST',
    input: {
      schemaVersion: 'v0',
      taskId: 'task-dig',
      causationId: 'c',
      correlationId: 'c',
      tenant: 'acme',
      principal: 'user',
      purpose: 'test',
      audience: 'internal',
      scope: 'read',
      rolePolicy: { policyId: 'p', policyVersion: 'v1', roleName: 'r' },
      candidateSet: { candidates: ['a'], sourceDigest: 'not-a-sha256', capturedAt: '2026-07-30T00:00:00Z' },
      provenance: { policyUri: 'u', policyDigest: 'b'.repeat(64), issuedAt: '2026-07-30T00:00:00Z' },
    },
    expectedErrorCode: 'INVALID_DIGEST',
  },
  {
    filename: 'ambiguous-canonical-value.json',
    description: 'attemptBudget is Infinity → AMBIGUOUS_CANONICAL_VALUE',
    input: {
      schemaVersion: 'v0',
      taskId: 'task-amb',
      causationId: 'c',
      correlationId: 'c',
      tenant: 'acme',
      principal: 'user',
      purpose: 'test',
      audience: 'internal',
      scope: 'read',
      rolePolicy: { policyId: 'p', policyVersion: 'v1', roleName: 'r' },
      candidateSet: { candidates: ['a'], sourceDigest: 'a'.repeat(64), capturedAt: '2026-07-30T00:00:00Z' },
      provenance: { policyUri: 'u', policyDigest: 'b'.repeat(64), issuedAt: '2026-07-30T00:00:00Z' },
      attemptBudget: Infinity,
    },
    expectedErrorCode: 'AMBIGUOUS_CANONICAL_VALUE',
  },
  {
    filename: 'deadline-exceeded.json',
    description: 'deadline in the past → DEADLINE_EXCEEDED',
    input: {
      schemaVersion: 'v0',
      taskId: 'task-dl',
      causationId: 'c',
      correlationId: 'c',
      tenant: 'acme',
      principal: 'user',
      purpose: 'test',
      audience: 'internal',
      scope: 'read',
      rolePolicy: { policyId: 'p', policyVersion: 'v1', roleName: 'r' },
      candidateSet: { candidates: ['a'], sourceDigest: 'a'.repeat(64), capturedAt: '2026-07-30T00:00:00Z' },
      provenance: { policyUri: 'u', policyDigest: 'b'.repeat(64), issuedAt: '2026-07-30T00:00:00Z' },
      deadline: '2020-01-01T00:00:00Z',
    },
    expectedErrorCode: 'DEADLINE_EXCEEDED',
  },
  {
    filename: 'attempt-budget-exceeded.json',
    description: 'attemptBudget > 1000 → ATTEMPT_BUDGET_EXCEEDED',
    input: {
      schemaVersion: 'v0',
      taskId: 'task-bud',
      causationId: 'c',
      correlationId: 'c',
      tenant: 'acme',
      principal: 'user',
      purpose: 'test',
      audience: 'internal',
      scope: 'read',
      rolePolicy: { policyId: 'p', policyVersion: 'v1', roleName: 'r' },
      candidateSet: { candidates: ['a'], sourceDigest: 'a'.repeat(64), capturedAt: '2026-07-30T00:00:00Z' },
      provenance: { policyUri: 'u', policyDigest: 'b'.repeat(64), issuedAt: '2026-07-30T00:00:00Z' },
      attemptBudget: 1001,
    },
    expectedErrorCode: 'ATTEMPT_BUDGET_EXCEEDED',
  },
];

// ---------------------------------------------------------------------------
// Generate fixture files
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function writeFixture(subdir, fixture) {
  const dir = path.join(fixturesDir, subdir);
  ensureDir(dir);

  const output = {
    description: fixture.description,
  };

  if (subdir === 'positive') {
    output.input = fixture.input;
    output.expectedDigest = computeDigest(fixture.input);
    output.expectedArtifactId = output.expectedDigest; // content-addressed
  } else {
    output.input = fixture.input;
    output.expectedErrorCode = fixture.expectedErrorCode;
  }

  const filePath = path.join(dir, fixture.filename);
  fs.writeFileSync(filePath, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(`  [${subdir}] ${fixture.filename} → ${subdir === 'positive' ? output.expectedDigest : fixture.expectedErrorCode}`);
}

console.log('Generating positive fixtures...');
for (const fixture of positiveFixtures) {
  writeFixture('positive', fixture);
}

console.log('\nGenerating negative fixtures...');
for (const fixture of negativeFixtures) {
  writeFixture('negative', fixture);
}

console.log(`\nDone: ${positiveFixtures.length} positive, ${negativeFixtures.length} negative fixtures.`);
