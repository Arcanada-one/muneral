// MUN-0021 adoption gate: typed result-authority errors.
// Every one of these is returned (not thrown) from a pre-mutation position, so
// a rejected proposal leaves zero durable rows.

/** A closed message failed its schema: unknown field, wrong type, bad digest. */
export class ResultContractError extends Error {
  public readonly code = 'RESULT_CONTRACT_ERROR' as const;

  constructor(
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`Result contract violation at "${field}": ${reason}`);
    this.name = 'ResultContractError';
  }
}

/**
 * The proposal carries content that belongs to the Supervisor plane, or a
 * Supervisor principal. Muneral transports committed task facts only; fleet
 * lifecycle, placement, watchdog and command authority live in the separate
 * round-5 Supervisor project.
 */
export class ResultPlaneError extends Error {
  public readonly code = 'RESULT_PLANE_ERROR' as const;

  constructor(
    public readonly subject: string,
    public readonly reason: string,
  ) {
    super(`Wrong-plane result proposal for "${subject}": ${reason}`);
    this.name = 'ResultPlaneError';
  }
}

/**
 * The proposal did not match the authoritative binding: wrong principal, card
 * digest, projection digest, attempt, node, or expected node version; or it
 * lost a race for a node version.
 */
export class ResultBindingError extends Error {
  public readonly code = 'RESULT_BINDING_ERROR' as const;

  constructor(
    public readonly subject: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `Result binding violation for "${subject}": expected ${expected}, got ${actual}`,
    );
    this.name = 'ResultBindingError';
  }
}

/** A mutation id was reused for different canonical proposal bytes. */
export class ResultMutationCollisionError extends Error {
  public readonly code = 'RESULT_MUTATION_COLLISION' as const;

  constructor(
    public readonly taskId: string,
    public readonly mutationId: string,
    public readonly storedDigest: string,
    public readonly receivedDigest: string,
  ) {
    super(
      `Result mutation collision for task ${taskId} mutation ${mutationId}: ` +
        `stored digest ${storedDigest.substring(0, 16)}... differs from ` +
        `received digest ${receivedDigest.substring(0, 16)}...`,
    );
    this.name = 'ResultMutationCollisionError';
  }
}

/**
 * An execution adapter attempted to author a receipt or supply an
 * authoritative digest. Adapters propose mutations; Muneral authors receipts.
 */
export class AdapterAuthorityError extends Error {
  public readonly code = 'ADAPTER_AUTHORITY_ERROR' as const;

  constructor(public readonly field: string) {
    super(
      `Execution adapters cannot author "${field}": receipts and authoritative digests are created by Muneral in the accepting transaction`,
    );
    this.name = 'AdapterAuthorityError';
  }
}

export type ResultAuthorityErrorType =
  | ResultContractError
  | ResultPlaneError
  | ResultBindingError
  | ResultMutationCollisionError
  | AdapterAuthorityError;
