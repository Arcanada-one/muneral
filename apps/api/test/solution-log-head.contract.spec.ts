import {
  computeSolutionLogHeadReceiptId,
  validateSolutionLogHeadProposalV0,
  validateSolutionLogHeadReceiptV0,
} from '../src/solution-log-head';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'v0',
    kind: 'solution-log-head-proposal',
    taskRevision: 7,
    projectionDigestSha256: SHA_A,
    logRevision: 1,
    previousHeadDigestSha256: null,
    headDigestSha256: SHA_B,
    solutionLogDigestSha256: SHA_C,
    expectedProducerVersion: 0,
    ...overrides,
  };
}

describe('SolutionLogHeadReceiptV0 contract', () => {
  it('accepts the closed producer proposal and rejects every server-authored field', () => {
    expect(validateSolutionLogHeadProposalV0(proposal())).not.toBeInstanceOf(Error);
    for (const field of [
      'taskId',
      'attemptId',
      'principalId',
      'producerVersion',
      'executionAggregateVersion',
      'recordedAt',
      'receiptId',
      'provenanceScope',
      'modelUseStatus',
    ]) {
      expect(
        validateSolutionLogHeadProposalV0(proposal({ [field]: 'forged' })),
      ).toBeInstanceOf(Error);
    }
  });

  it.each([
    ['taskRevision', 0],
    ['logRevision', 0],
    ['expectedProducerVersion', -1],
    ['projectionDigestSha256', SHA_A.toUpperCase()],
    ['headDigestSha256', 'not-a-digest'],
    ['solutionLogDigestSha256', SHA_C.slice(1)],
  ])('rejects malformed %s', (field, value) => {
    expect(validateSolutionLogHeadProposalV0(proposal({ [field]: value }))).toBeInstanceOf(
      Error,
    );
  });

  it('requires null prior head only for the first producer version', () => {
    expect(
      validateSolutionLogHeadProposalV0(
        proposal({ expectedProducerVersion: 1, logRevision: 2 }),
      ),
    ).toBeInstanceOf(Error);
    expect(
      validateSolutionLogHeadProposalV0(
        proposal({ previousHeadDigestSha256: SHA_A }),
      ),
    ).toBeInstanceOf(Error);
  });

  it('content-addresses every binding and carries provenance-only semantics', () => {
    const withoutId = {
      schemaVersion: 'v0' as const,
      kind: 'solution-log-head-receipt' as const,
      taskId: '11111111-1111-4111-8111-111111111111',
      attemptId: '22222222-2222-4222-8222-222222222222',
      principalId: '33333333-3333-4333-8333-333333333333',
      taskRevision: 7,
      projectionDigestSha256: SHA_A,
      logRevision: 1,
      previousHeadDigestSha256: null,
      headDigestSha256: SHA_B,
      solutionLogDigestSha256: SHA_C,
      executionAggregateVersion: 2,
      producerVersion: 1,
      recordedAt: '2026-08-09T18:00:00.000Z',
      provenanceScope: 'PRODUCER_AUTHENTICATED_ONLY' as const,
      modelUseStatus: 'NOT_AUTHORIZED' as const,
    };
    const receipt = {
      ...withoutId,
      receiptId: computeSolutionLogHeadReceiptId(withoutId),
    };
    expect(receipt.receiptId).toBe(
      '26525bc1f054c5f468ba3e727bc5556e81249916dc6a2bf55c9654c921c87389',
    );
    expect(validateSolutionLogHeadReceiptV0(receipt)).toEqual(receipt);

    const bindingMutations: Array<[keyof typeof receipt, unknown]> = [
      ['taskId', '44444444-4444-4444-8444-444444444444'],
      ['attemptId', '55555555-5555-4555-8555-555555555555'],
      ['principalId', '66666666-6666-4666-8666-666666666666'],
      ['taskRevision', 8],
      ['projectionDigestSha256', 'd'.repeat(64)],
      ['logRevision', 2],
      ['previousHeadDigestSha256', 'd'.repeat(64)],
      ['headDigestSha256', 'd'.repeat(64)],
      ['solutionLogDigestSha256', 'd'.repeat(64)],
      ['executionAggregateVersion', 3],
      ['producerVersion', 2],
      ['recordedAt', '2026-08-09T18:00:01.000Z'],
    ];
    for (const [field, changed] of bindingMutations) {
      const mutated = { ...receipt, [field]: changed };
      expect(validateSolutionLogHeadReceiptV0(mutated)).toBeInstanceOf(Error);
    }
  });
});
