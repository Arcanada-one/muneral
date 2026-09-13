#!/usr/bin/env node
/* global console, process */
// Golden corpus generator. It consumes the built compiler/canonicalizer; it
// deliberately contains no private protocol or canonicalization implementation.




import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// ESM has no __dirname, and declaring that NAME would mark the module CommonJS.
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
// The built modules are ESM now, so they cannot be require()d synchronously.
// They are imported statically instead: the generator already required the API
// build to exist, and a missing build now fails at load with Node's own
// resolution error rather than the wrapped message below.
import { canonicalJsonV1 } from '../../dist/execution-authority/canonical-json-v1.js';
import { compileAssembly } from '../../dist/assembly/assembly.compiler.js';
const FIXTURE_EVALUATED_AT = '2026-08-01T12:00:00.000Z';

function canonicalJson(value) {
  return canonicalJsonV1(value);
}

function compile(input) {
  return compileAssembly(input);
}

function authority(scope = 'read') {
  return { tenant: 'acme', principal: 'operator', purpose: 'assembly', audience: 'internal', scope };
}

function base(overrides = {}) {
  return {
    schemaVersion: 'v0',
    taskId: 'task-fixture',
    causationId: 'cause-fixture',
    correlationId: 'corr-fixture',
    evaluatedAt: FIXTURE_EVALUATED_AT,
    authorityCeiling: authority('read,write'),
    requestedAuthority: authority('read'),
    rolePolicy: { policyId: 'roles', policyVersion: 'v1', roleName: 'assistant' },
    candidateSet: {
      candidates: ['assistant', 'reviewer'],
      sourceDigest: 'b'.repeat(64),
      capturedAt: '2026-08-01T11:59:00.000Z',
    },
    evidenceRefs: [],
    provenance: {
      policyUri: 'policy/roles.json',
      policyDigest: 'c'.repeat(64),
      issuedAt: '2026-08-01T11:00:00.000Z',
    },
    ...overrides,
  };
}

const evidence = [
  { uri: 'evidence/a.json', digest: '1'.repeat(64), contentType: 'application/json', label: 'A' },
  { uri: 'evidence/b.txt', digest: '2'.repeat(64), contentType: 'text/plain' },
];

const positiveFixtures = [
  ['minimal-request.json', 'Smallest valid request', base({ taskId: 'task-minimal' })],
  ['full-request.json', 'All optional fields', base({
    taskId: 'task-full', deadline: '2026-08-02T12:00:00.000Z', attemptBudget: 3,
    traceFields: { diagnostic: 'fixture' }, evidenceRefs: evidence,
    provenance: { ...base().provenance, expiresAt: '2026-08-03T12:00:00.000Z' },
  })],
  ['narrow-scope.json', 'Requested scope is narrower than ceiling', base({
    taskId: 'task-narrow', authorityCeiling: authority('admin,read,write'), requestedAuthority: authority('read'),
  })],
  ['no-deadline.json', 'Attempt budget without deadline', base({ taskId: 'task-no-deadline', attemptBudget: 2 })],
  ['with-trace-fields.json', 'Trace diagnostics excluded from identity', base({
    taskId: 'task-trace', traceFields: { nested: { note: 'non-authoritative' } },
  })],
];

const deep = {};
let cursor = deep;
for (let index = 0; index < 12; index++) { cursor.next = {}; cursor = cursor.next; }

const negativeFixtures = [
  ['unsupported-schema-version.json', 'Unsupported schema', base({ schemaVersion: 'v1' }), 'UNSUPPORTED_SCHEMA_VERSION'],
  ['unknown-execution-field.json', 'Unknown execution field', base({ providerConfig: {} }), 'UNKNOWN_EXECUTION_FIELD'],
  ['ambiguous-canonical-value.json', 'Non-integer numeric domain', base({ attemptBudget: 1.5 }), 'AMBIGUOUS_CANONICAL_VALUE'],
  ['unsafe-size.json', 'Oversized identity', base({ taskId: 'x'.repeat(257) }), 'UNSAFE_SIZE'],
  ['unsafe-nesting.json', 'Over-deep trace value', base({ traceFields: deep }), 'UNSAFE_NESTING'],
  ['authority-widening.json', 'Requested scope exceeds ceiling', base({ requestedAuthority: authority('admin,read') }), 'AUTHORITY_WIDENING'],
  ['invalid-provenance.json', 'Policy issued after evaluation', base({ provenance: { ...base().provenance, issuedAt: '2026-08-01T12:00:00.001Z' } }), 'INVALID_PROVENANCE'],
  ['expired-policy.json', 'Policy expired before evaluation', base({ provenance: { ...base().provenance, expiresAt: '2026-08-01T11:59:59.999Z' } }), 'EXPIRED_POLICY'],
  ['credential-bearer.json', 'Bearer credential in purpose', base({ requestedAuthority: { ...authority(), purpose: 'Bearer synthetic-example-token' }, authorityCeiling: { ...authority(), purpose: 'Bearer synthetic-example-token' } }), 'CREDENTIAL_IN_PROHIBITED_POSITION'],
  ['credential-key.json', 'API-key marker in trace', base({ traceFields: { value: 'api_key=synthetic-example' } }), 'CREDENTIAL_IN_PROHIBITED_POSITION'],
  ['invalid-digest.json', 'Candidate digest is malformed', base({ candidateSet: { ...base().candidateSet, sourceDigest: 'bad' } }), 'INVALID_DIGEST'],
  ['deadline-exceeded.json', 'Deadline predates evaluation', base({ deadline: '2026-08-01T11:59:59.999Z' }), 'DEADLINE_EXCEEDED'],
  ['attempt-budget-exceeded.json', 'Attempt budget exceeds bound', base({ attemptBudget: 1001 }), 'ATTEMPT_BUDGET_EXCEEDED'],
];

function writeFixture(subdir, tuple) {
  const [filename, description, input, expectedErrorCode] = tuple;
  const directory = path.join(scriptDir, 'fixtures', subdir);
  fs.mkdirSync(directory, { recursive: true });
  const output = { description, input };
  if (subdir === 'positive') {
    const result = compile(input);
    if (!result.ok) throw new Error(`${filename} refused: ${result.error.errorCode}`);
    output.expectedDigest = result.artifact.digest;
    output.expectedArtifactId = result.artifact.artifactId;
  } else {
    const result = compile(input);
    if (result.ok || result.error.errorCode !== expectedErrorCode) {
      throw new Error(`${filename}: expected ${expectedErrorCode}, received ${result.ok ? 'success' : result.error.errorCode}`);
    }
    output.expectedErrorCode = expectedErrorCode;
  }
  fs.writeFileSync(path.join(directory, filename), `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}

function main() {
  for (const fixture of positiveFixtures) writeFixture('positive', fixture);
  for (const fixture of negativeFixtures) writeFixture('negative', fixture);
  console.log(`Generated ${positiveFixtures.length} positive and ${negativeFixtures.length} negative Assembly fixtures.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) main();

export { canonicalJson, main };
