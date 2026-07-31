// MUN-0021 adoption gate: public surface of the Muneral result authority.
// No NestJS module, no @Injectable(), no controller, no runtime wiring.

export {
  ADAPTER_FORBIDDEN_FIELDS,
  COMMITTED_RESULT_REF_FIELDS,
  COMPLETION_RECEIPT_FIELDS,
  DOMAIN_CARD,
  DOMAIN_PROJECTION,
  DOMAIN_RECEIPT,
  DOMAIN_RESULT_NODE,
  DOMAIN_RESULT_REF,
  LEGACY_NONE,
  OWNED_RESULT_MUTATION_FIELDS,
} from './result-authority.types';
export type {
  CommittedResultEnvelopeV0,
  CommittedResultRefV0,
  CompletionReceiptV0,
  LegacyNone,
  OwnedResultMutationV0,
  Sha256Hex,
} from './result-authority.types';

export {
  cardDigest,
  computeReceiptId,
  computeResultRefId,
  domainDigest,
  isSha256Hex,
  projectionDigest,
  resultNodeDigest,
} from './result-authority.canonical';

export {
  replayLegacyCommittedResult,
  validateCommittedResultRefV0,
  validateCompletionReceiptV0,
  validateOwnedResultMutationV0,
  validateResultPlane,
  validateResultPrincipal,
} from './result-authority.guards';

export {
  AdapterAuthorityError,
  ResultBindingError,
  ResultContractError,
  ResultPlaneError,
} from './result-authority.errors';
export type { ResultAuthorityErrorType } from './result-authority.errors';

export { ResultAuthorityService } from './result-authority.service';
export type {
  CommittedResultOutcome,
  CommitOwnedResultOutcome,
} from './result-authority.service';
