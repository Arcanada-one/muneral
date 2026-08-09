import { computeSolutionLogHeadReceiptId, isSha256Hex } from './solution-log-head.canonical';
import { SolutionLogHeadContractError } from './solution-log-head.errors';
import {
  SOLUTION_LOG_HEAD_PROPOSAL_FIELDS,
  SOLUTION_LOG_HEAD_RECEIPT_FIELDS,
  SolutionLogHeadProposalV0,
  SolutionLogHeadReceiptV0,
} from './solution-log-head.types';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function closedShape(value: Record<string, unknown>, fields: readonly string[]) {
  const allowed = new Set(fields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) return new SolutionLogHeadContractError(field, 'unknown or server-authored field');
  }
  for (const field of fields) {
    if (!(field in value)) return new SolutionLogHeadContractError(field, 'missing required field');
  }
  return null;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function validateSolutionLogHeadProposalV0(value: unknown): SolutionLogHeadProposalV0 | SolutionLogHeadContractError {
  if (!isPlainRecord(value)) return new SolutionLogHeadContractError('$', 'must be a plain JSON object');
  const shape = closedShape(value, SOLUTION_LOG_HEAD_PROPOSAL_FIELDS);
  if (shape) return shape;
  if (value.schemaVersion !== 'v0') return new SolutionLogHeadContractError('schemaVersion', 'must be "v0"');
  if (value.kind !== 'solution-log-head-proposal') return new SolutionLogHeadContractError('kind', 'must be "solution-log-head-proposal"');
  for (const field of ['taskRevision', 'logRevision'] as const) {
    if (!positiveSafeInteger(value[field])) return new SolutionLogHeadContractError(field, 'must be a positive safe integer');
  }
  if (!nonNegativeSafeInteger(value.expectedProducerVersion)) return new SolutionLogHeadContractError('expectedProducerVersion', 'must be a non-negative safe integer');
  for (const field of ['projectionDigestSha256', 'headDigestSha256', 'solutionLogDigestSha256'] as const) {
    if (!isSha256Hex(value[field])) return new SolutionLogHeadContractError(field, 'must be lowercase SHA-256 hexadecimal');
  }
  if (value.previousHeadDigestSha256 !== null && !isSha256Hex(value.previousHeadDigestSha256)) {
    return new SolutionLogHeadContractError('previousHeadDigestSha256', 'must be null or lowercase SHA-256 hexadecimal');
  }
  if ((value.expectedProducerVersion === 0) !== (value.previousHeadDigestSha256 === null)) {
    return new SolutionLogHeadContractError('previousHeadDigestSha256', 'must be null exactly for producer version zero');
  }
  return value as unknown as SolutionLogHeadProposalV0;
}

export function validateSolutionLogHeadReceiptV0(value: unknown): SolutionLogHeadReceiptV0 | SolutionLogHeadContractError {
  if (!isPlainRecord(value)) return new SolutionLogHeadContractError('$', 'must be a plain JSON object');
  const shape = closedShape(value, SOLUTION_LOG_HEAD_RECEIPT_FIELDS);
  if (shape) return shape;
  if (value.schemaVersion !== 'v0' || value.kind !== 'solution-log-head-receipt') return new SolutionLogHeadContractError('$', 'wrong receipt discriminator');
  if (value.provenanceScope !== 'PRODUCER_AUTHENTICATED_ONLY' || value.modelUseStatus !== 'NOT_AUTHORIZED') {
    return new SolutionLogHeadContractError('provenanceScope', 'receipt is provenance-only and must not grant model-use authority');
  }
  for (const field of ['taskId', 'attemptId', 'principalId'] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0) return new SolutionLogHeadContractError(field, 'must be a non-empty string');
  }
  for (const field of ['taskRevision', 'logRevision', 'executionAggregateVersion', 'producerVersion'] as const) {
    if (!positiveSafeInteger(value[field])) return new SolutionLogHeadContractError(field, 'must be a positive safe integer');
  }
  for (const field of ['receiptId', 'projectionDigestSha256', 'headDigestSha256', 'solutionLogDigestSha256'] as const) {
    if (!isSha256Hex(value[field])) return new SolutionLogHeadContractError(field, 'must be lowercase SHA-256 hexadecimal');
  }
  if (value.previousHeadDigestSha256 !== null && !isSha256Hex(value.previousHeadDigestSha256)) return new SolutionLogHeadContractError('previousHeadDigestSha256', 'must be null or lowercase SHA-256 hexadecimal');
  if ((value.producerVersion === 1) !== (value.previousHeadDigestSha256 === null)) return new SolutionLogHeadContractError('previousHeadDigestSha256', 'must be null exactly for producer version one');
  if (typeof value.recordedAt !== 'string' || Number.isNaN(Date.parse(value.recordedAt)) || new Date(value.recordedAt).toISOString() !== value.recordedAt) {
    return new SolutionLogHeadContractError('recordedAt', 'must be canonical ISO-8601 UTC');
  }
  const receipt = value as unknown as SolutionLogHeadReceiptV0;
  const { receiptId, ...withoutId } = receipt;
  if (computeSolutionLogHeadReceiptId(withoutId) !== receiptId) return new SolutionLogHeadContractError('receiptId', 'does not match the content-addressed receipt fields');
  return receipt;
}
