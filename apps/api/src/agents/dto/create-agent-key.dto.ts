import { IsDateString, IsOptional, IsString, Matches } from 'class-validator';

export class CreateAgentKeyDto {
  @IsString()
  @IsOptional()
  label?: string;

  @IsDateString({ strict: true, strictSeparator: true })
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/)
  expiresAt!: string;
}
