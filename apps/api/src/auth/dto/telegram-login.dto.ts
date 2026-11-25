import { IsInt, IsString, IsOptional, Matches, Max, Min } from 'class-validator';

export class TelegramLoginDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  id: number;

  @IsString()
  @Matches(/^[^\r\n]*$/u)
  first_name: string;

  @IsString()
  @IsOptional()
  @Matches(/^[^\r\n]*$/u)
  last_name?: string;

  @IsString()
  @IsOptional()
  @Matches(/^[^\r\n]*$/u)
  username?: string;

  @IsString()
  @IsOptional()
  @Matches(/^[^\r\n]*$/u)
  photo_url?: string;

  @IsInt()
  @Min(1)
  auth_date: number;

  @Matches(/^[a-f0-9]{64}$/u)
  hash: string;
}
