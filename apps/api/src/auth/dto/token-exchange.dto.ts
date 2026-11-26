import { IsString, Matches, MaxLength } from 'class-validator';

export class GithubExchangeDto {
  @IsString()
  @MaxLength(512)
  @Matches(/^[A-Za-z0-9_]+$/u)
  access_token: string;
}

export class RefreshTokenDto {
  @IsString()
  @MaxLength(4096)
  @Matches(/^[\w-]+\.[\w-]+\.[\w-]+$/u)
  refresh_token: string;
}
