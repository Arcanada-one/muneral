import { IsString, IsNotEmpty, MaxLength, IsOptional, Matches } from 'class-validator';

export class UploadArtifactDto {
  @IsString() @IsNotEmpty() @MaxLength(128)
  name: string;
  @IsString() @Matches(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[^\r\n]+)?$/) @MaxLength(128)
  contentType: string;
  @IsString() @MaxLength(349528)
  contentBase64: string;
  @IsOptional() @Matches(/^[0-9a-f]{64}$/)
  sha256?: string;
}

