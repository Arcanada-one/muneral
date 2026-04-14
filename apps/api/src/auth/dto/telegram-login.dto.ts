import { IsNumber, IsString, IsOptional } from 'class-validator';

export class TelegramLoginDto {
  @IsNumber()
  id: number;

  @IsString()
  first_name: string;

  @IsString()
  @IsOptional()
  last_name?: string;

  @IsString()
  @IsOptional()
  username?: string;

  @IsString()
  @IsOptional()
  photo_url?: string;

  @IsNumber()
  auth_date: number;

  @IsString()
  hash: string;
}
