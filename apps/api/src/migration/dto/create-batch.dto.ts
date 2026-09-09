import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

/** AUP-X04 MigrationBatch — the idempotent unit of migration work. */
export class CreateBatchDto {
  /** Caller-chosen idempotency key. Repeating it with the same payload
   *  returns the same batch; repeating it with a different payload is a
   *  BATCH_KEY_CONFLICT. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  batchKey: string;

  /** Identifies the snapshot of the source set this batch was cut from. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  sourceSetEpoch: string;

  /** Who produced the batch (an importer identity, not a Muneral actor). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  producer: string;

  @IsUUID()
  projectId: string;
}
