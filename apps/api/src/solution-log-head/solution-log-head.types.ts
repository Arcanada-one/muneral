export type Sha256Hex = string;

export const SOLUTION_LOG_HEAD_PROPOSAL_FIELDS = [
  'schemaVersion', 'kind', 'taskRevision', 'projectionDigestSha256',
  'logRevision', 'previousHeadDigestSha256', 'headDigestSha256',
  'solutionLogDigestSha256', 'expectedProducerVersion',
] as const;

export const SOLUTION_LOG_HEAD_RECEIPT_FIELDS = [
  'schemaVersion', 'kind', 'receiptId', 'taskId', 'attemptId', 'principalId',
  'taskRevision', 'projectionDigestSha256', 'logRevision',
  'previousHeadDigestSha256', 'headDigestSha256', 'solutionLogDigestSha256',
  'executionAggregateVersion', 'producerVersion', 'recordedAt',
  'provenanceScope', 'modelUseStatus',
] as const;

export interface SolutionLogHeadProposalV0 {
  schemaVersion: 'v0';
  kind: 'solution-log-head-proposal';
  taskRevision: number;
  projectionDigestSha256: Sha256Hex;
  logRevision: number;
  previousHeadDigestSha256: Sha256Hex | null;
  headDigestSha256: Sha256Hex;
  solutionLogDigestSha256: Sha256Hex;
  expectedProducerVersion: number;
}

export interface SolutionLogHeadReceiptV0 {
  schemaVersion: 'v0';
  kind: 'solution-log-head-receipt';
  receiptId: Sha256Hex;
  taskId: string;
  attemptId: string;
  principalId: string;
  taskRevision: number;
  projectionDigestSha256: Sha256Hex;
  logRevision: number;
  previousHeadDigestSha256: Sha256Hex | null;
  headDigestSha256: Sha256Hex;
  solutionLogDigestSha256: Sha256Hex;
  executionAggregateVersion: number;
  producerVersion: number;
  recordedAt: string;
  provenanceScope: 'PRODUCER_AUTHENTICATED_ONLY';
  modelUseStatus: 'NOT_AUTHORIZED';
}

export const DOMAIN_SOLUTION_LOG_HEAD_RECEIPT =
  'muneral-solution-log-head-receipt-v0';
