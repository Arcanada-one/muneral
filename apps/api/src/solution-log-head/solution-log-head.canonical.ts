import { createHash } from 'node:crypto';
import { canonicalJsonV1 } from '../execution-authority/canonical-json-v1';
import {
  DOMAIN_SOLUTION_LOG_HEAD_RECEIPT,
  SolutionLogHeadReceiptV0,
} from './solution-log-head.types';

export function computeSolutionLogHeadReceiptId(
  receipt: Omit<SolutionLogHeadReceiptV0, 'receiptId'>,
): string {
  const canonical = canonicalJsonV1(receipt);
  return createHash('sha256')
    .update(`${DOMAIN_SOLUTION_LOG_HEAD_RECEIPT}\0${canonical}`, 'utf8')
    .digest('hex');
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
