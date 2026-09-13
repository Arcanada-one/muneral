import { IsIn, IsString, Length, Matches } from 'class-validator';
import { SECRET_RULE_IDS } from './secret-rules.js';

export const REDACTABLE_FIELDS = ['title', 'description'] as const;
export type RedactableField = (typeof REDACTABLE_FIELDS)[number];

/**
 * MUN-0049 — what a caller may say about a redaction. Deliberately never the
 * secret: the span is named by its sha256 and by the scanner rule that found
 * it, and the server re-finds it in the current field value. `replacement` is
 * the only free text, and the service refuses one the scanner would flag.
 * Field names are snake_case on purpose: they are the names the kb-sync
 * scanner's blocked-task report already uses (`rule`, `span_hash`).
 */
export class RedactFieldDto {
  @IsIn(REDACTABLE_FIELDS)
  field: RedactableField;

  @IsString()
  @Matches(/^[0-9a-f]{64}$/, { message: 'span_sha256 must be 64 lowercase hex characters' })
  span_sha256: string;

  @IsIn(SECRET_RULE_IDS as string[])
  rule: string;

  @IsString()
  @Length(1, 512)
  replacement: string;
}
