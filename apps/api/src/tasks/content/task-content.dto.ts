import { IsString, IsNotEmpty, MaxLength, IsOptional, Matches, IsInt, Min, Max, IsObject } from 'class-validator';

export class ArtifactMetadataDto {
  @IsString() @IsNotEmpty() @MaxLength(128)
  name: string;
  @IsString() @Matches(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[^\r\n]+)?$/) @MaxLength(128)
  contentType: string;
  @IsOptional() @Matches(/^[0-9a-f]{64}$/)
  sha256?: string;
}

export class UploadArtifactDto extends ArtifactMetadataDto {
  @IsString() @MaxLength(87384)
  contentBase64: string;
}

export class StoreGraphDto {
  @IsInt() @Min(0) @Max(1000)
  expectedRevision: number;
  @IsObject()
  document: Record<string, unknown>;
}

