import { IsString, IsUUID, MaxLength } from 'class-validator';
import { BadRequestException } from '@nestjs/common';

/** Current Transcribator v1/jobs contract; never a signed R2 URL or credential. */
export class TranscriptionLinkDto {
  @IsUUID()
  jobId: string;

  @IsString()
  @MaxLength(2048)
  producerRoute: string;
}
export function readTranscriptionLink(value: unknown): TranscriptionLinkDto {
  if (!value || typeof value !== 'object') throw new BadRequestException('Invalid transcription link');
  const {jobId, producerRoute} = value as Record<string, unknown>;
  if (typeof jobId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId) || typeof producerRoute !== 'string') throw new BadRequestException('Invalid transcription link');
  try {
    const url = new URL(producerRoute);
    const entries = [...url.searchParams.entries()];
    if (producerRoute.length > 2048 || /[\s\x00-\x1f\x7f]/.test(producerRoute) || url.protocol !== 'https:' || url.username || url.password || url.hash || url.pathname !== '/v1/jobs/' + jobId + '/result' || entries.length !== 1 || entries[0][0] !== 'format' || !['txt', 'srt', 'vtt', 'json'].includes(entries[0][1])) throw new Error('route');
    return {jobId, producerRoute};
  } catch { throw new BadRequestException('Invalid transcription producer route'); }
}
