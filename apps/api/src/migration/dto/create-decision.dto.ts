import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * AUP-X02 LegacyIdentityMap decision.
 *
 * A title or embedding match may only PROPOSE a review — it can never be the
 * mechanism that binds two identities. That is why this endpoint exists and
 * why `basis` is required: recorded together with the deciding agent, it is
 * what makes the mapping reversible and auditable.
 */
export class CreateDecisionDto {
  @IsIn(['same', 'split', 'merge', 'candidate_conflict'])
  kind: 'same' | 'split' | 'merge' | 'candidate_conflict';

  /** The other identities this decision relates the subject to. */
  @IsArray()
  @IsUUID(undefined, { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(64)
  targets: string[];

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  basis: string;

  /** Optimistic concurrency on the identity's mapping revision. */
  @IsInt()
  @Min(0)
  expectedMappingRevision: number;
}
