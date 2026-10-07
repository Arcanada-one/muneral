import { IsOptional, IsString, IsUUID, Length, Matches, ValidateIf } from 'class-validator';
import { CONTRACT_DIGEST_PATTERN } from './create-task.dto.js';

/** Required, nullable fields. Undefined is not a clear or a wildcard CAS. */
export class UpdateTaskContractDto {
  /** Atomic narrower lane precondition for receivers with one configured project. */
  @IsOptional()
  @IsUUID()
  expectedProjectId?: string;

  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @Length(71, 71)
  @Matches(CONTRACT_DIGEST_PATTERN)
  contractDigest: string | null;

  @ValidateIf((_object, value) => value !== null)
  @IsString()
  @Length(71, 71)
  @Matches(CONTRACT_DIGEST_PATTERN)
  expectedContractDigest: string | null;
}
