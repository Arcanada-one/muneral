import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import type { TaskPriority } from '@muneral/types';

/**
 * An ISO-8601 timestamp without an offset (`2019-04-02T10:15:00`) is valid to
 * `@IsDateString`, and `new Date()` then reads it as the SERVER's local time.
 * The historical date is the one value AUP-DAT-003 exists to protect from
 * being rewritten; letting an environment variable shift it by hours, silently
 * and differently per host, is exactly the rewrite. Require the offset.
 */
const OFFSET_REQUIRED = /(?:Z|[+-]\d{2}:?\d{2})$/;
const OFFSET_MESSAGE =
  'must carry an explicit UTC offset (a trailing "Z" or "±HH:MM"); ' +
  'a timestamp without one would be reinterpreted in the server\'s local time zone';

/** AUP-X01 SourceOccurrence — one sighting of one identity in one source. */
export class SourceOccurrenceDto {
  /** The tracker/workspace root the sighting came from. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  sourceRoot: string;

  /** Where inside that root — file path, anchor, row id. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  sourceLocator: string;

  /**
   * Stable key for the record inside the source. AUP-DAT-002 requires an
   * anonymous record to get a key that does NOT depend only on a line number,
   * because a reflow of the source file would otherwise re-key it into a new
   * identity. A bare line number is rejected here and again by a CHECK
   * constraint in the database.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  @Matches(/^(?!(?:l(?:ine)?[ :#_-]*)?\d+$)[\s\S]+$/i, {
    message:
      'sourceKey must not be a bare line number: a key derived from a line number ' +
      'alone re-keys the record the next time the source file reflows. Derive it ' +
      'from stable content (a heading slug, a content digest), or, for a genuinely ' +
      'stable numeric id from another tracker, qualify it with its source ' +
      '(e.g. "asana:1203847362")',
  })
  sourceKey: string;

  @IsString()
  @Matches(/^[0-9a-f]{64}$/, { message: 'contentDigest must be a sha256 hex digest' })
  contentDigest: string;

  /** When the importer read the source. */
  @IsDateString()
  @Matches(OFFSET_REQUIRED, { message: OFFSET_MESSAGE })
  capturedAt: string;

  /** The historical time the SOURCE states, if it states one. Never the
   *  import time — that is recorded separately as tasks.importedAt. */
  @IsDateString()
  @Matches(OFFSET_REQUIRED, { message: OFFSET_MESSAGE })
  @IsOptional()
  historicalAt?: string;

  /**
   * Bounded verbatim excerpt.
   *
   * The hard bound is 16 KiB of UTF-8 and is checked in the service and by a
   * CHECK constraint, both in BYTES. This character cap is only a cheap first
   * filter: it cannot be 16384 characters, because 16384 characters of
   * Cyrillic are 32 KiB and would sail past validation into an untyped
   * constraint failure.
   */
  @IsString()
  @IsOptional()
  @MaxLength(16384)
  rawExcerpt?: string;
}

export class CreateWorkItemDto {
  @IsUUID()
  batchId: string;

  /** Namespaces the legacy id. Two trackers may both hold `ARAS-0001`; the
   *  namespace is what keeps them distinguishable. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  sourceNamespace: string;

  /** The historical ID, kept as a searchable alias across namespaces. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  legacyId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsIn(['critical', 'high', 'medium', 'low'])
  @IsOptional()
  priority?: TaskPriority;

  /** The status verbatim from the source. Unknown values are accepted: they
   *  land the work item in `todo` and survive on the occurrence. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  historicalStatus: string;

  @IsObject()
  @ValidateNested()
  @Type(() => SourceOccurrenceDto)
  occurrence: SourceOccurrenceDto;

  /** MIG-003: one bounded, write-once bootstrap provenance receipt. */
  @IsObject()
  @IsOptional()
  bootstrapStamp?: Record<string, unknown>;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  idempotencyKey: string;
}
