import { IsString } from 'class-validator';

/**
 * A2-274 — what a caller may say when attaching evidence to a work item.
 *
 * Deliberately three plain strings. Every CONTENT rule — the digest's shape,
 * the locator's shape, the media type's shape, the lengths — lives in
 * `task-evidence.errors.ts` and is applied by the service, so that each of
 * those refusals carries a machine-readable `code`. The global pipe's own 400
 * (a missing field, a number where a string belongs, an undeclared property
 * under `forbidNonWhitelisted`) carries no `code` and cannot be made to carry
 * one without changing the pipe for every route in the API; an unattended
 * executor branches on `code`, so the refusals it can actually provoke by
 * getting a VALUE wrong are the ones that must have it.
 *
 * camelCase, as `CreateTaskDto`: this body is written by an agent against this
 * API, not copied from another tool's report (which is why `RedactFieldDto`
 * next door is snake_case — it mirrors the kb-sync scanner's field names).
 */
export class AttachEvidenceDto {
  /** Where the artefact is. Absolute URI — see `requireUri`. */
  @IsString()
  uri: string;

  /** Which bytes are meant: 64 lowercase hex characters, no `sha256:` prefix. */
  @IsString()
  sha256: string;

  /** What the artefact is, as a lowercase media type — e.g. `application/json`. */
  @IsString()
  contentType: string;
}
